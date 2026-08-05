// db.js — persistence layer.
//
// Deliberately behind a small repository interface (users / games / ingest /
// stats) so the storage ENGINE is swappable without touching the rest of the
// app. Locally this is a zero-dependency JSON-file store — no native modules,
// no build tools, runs on any Node/any OS. For production you'd point the same
// interface at Postgres; server.js, auth.js and the SDK never change.
//
// Design notes (the "why", for interviews):
//   - API keys live on `games`, not `users`: one game leaking its key never
//     compromises the developer's whole account. Revoke per-game.
//   - Event `properties` are free-form objects: the SDK can send arbitrary
//     event shapes without a schema migration.
//   - Two timestamps on events (client_ts + server_ts): never trust the
//     client's clock. Keep what the client CLAIMS and what our server OBSERVED.
//   - `player_ref` is an anonymized salted hash, never a raw Roblox UserId.
//   - A batch is applied all-or-nothing: rows are staged, then committed and
//     persisted in one step, so a game never sees half a batch.

import fs from "node:fs";
import crypto from "node:crypto";

const DB_PATH = process.env.DB_PATH || "pulse.data.json";

const empty = () => ({ users: [], games: [], sessions: [], events: [], feedback: [] });

let data = empty();
try {
  if (fs.existsSync(DB_PATH)) data = { ...empty(), ...JSON.parse(fs.readFileSync(DB_PATH, "utf8")) };
} catch {
  data = empty(); // corrupt/partial file -> start clean rather than crash
}

function persist() {
  fs.writeFileSync(DB_PATH, JSON.stringify(data));
}

const uuid = () => crypto.randomUUID();
const now = () => Date.now();

// Anonymize a player identifier before it is ever stored. Per-game salt means
// the same player can't be correlated across different games.
export function hashPlayer(gameId, rawId) {
  return crypto
    .createHash("sha256")
    .update(`${gameId}:${rawId}`)
    .digest("hex")
    .slice(0, 16);
}

export function newApiKey() {
  return "pk_" + crypto.randomBytes(24).toString("hex");
}

// ---- users ----
export const users = {
  create(email, passwordHash) {
    const user = { id: uuid(), email, password_hash: passwordHash, created_at: now() };
    data.users.push(user);
    persist();
    return user;
  },
  byEmail: (email) => data.users.find((u) => u.email === email),
  byId: (id) => data.users.find((u) => u.id === id),
  findOrCreateOAuth({ email, provider, providerId, displayName }) {
    let user = data.users.find((u) => u.oauth?.[provider]?.id === providerId);
    if (!user) user = data.users.find((u) => u.email === email);
    if (!user) {
      user = { id: uuid(), email, password_hash: null, created_at: now(), oauth: {} };
      data.users.push(user);
    }
    user.oauth ||= {};
    user.oauth[provider] = { id: providerId, display_name: displayName || null, linked_at: now() };
    persist();
    return user;
  },
};

// ---- games ----
export const games = {
  create(userId, name) {
    const game = {
      id: uuid(),
      user_id: userId,
      name,
      api_key: newApiKey(),
      created_at: now(),
    };
    data.games.push(game);
    persist();
    return game;
  },
  byUser: (userId) =>
    data.games.filter((g) => g.user_id === userId).sort((a, b) => b.created_at - a.created_at),
  byKey: (key) => data.games.find((g) => g.api_key === key),
  byIdForUser: (id, userId) => data.games.find((g) => g.id === id && g.user_id === userId),
  rotateKey(id) {
    const game = data.games.find((g) => g.id === id);
    if (!game) return null;
    game.api_key = newApiKey();
    persist();
    return game.api_key;
  },
  rename(id, name) {
    const game = data.games.find((g) => g.id === id);
    if (!game) return null;
    game.name = name;
    persist();
    return game;
  },
  // Remove a game and cascade-delete all of its telemetry. All-or-nothing,
  // persisted once — the game never lingers half-deleted.
  remove(id) {
    const before = data.games.length;
    data.games = data.games.filter((g) => g.id !== id);
    if (data.games.length === before) return false;
    data.sessions = data.sessions.filter((s) => s.game_id !== id);
    data.events = data.events.filter((e) => e.game_id !== id);
    data.feedback = data.feedback.filter((f) => f.game_id !== id);
    persist();
    return true;
  },
};

// ---- ingestion (sessions / events / feedback) ----
// Stage all rows, then commit + persist once: all-or-nothing per batch.
export function ingest(gameId, batch) {
  const serverTs = now();
  const sid = batch.session_id || uuid();
  const playerRef = hashPlayer(gameId, batch.player_id ?? "anon");

  const newSessions = [];
  const newEvents = [];
  const newFeedback = [];

  // Roblox server instance id (game.JobId). Empty in Studio playtests, so the
  // SDK sends "studio" — either way we tag the session with where it came from.
  const serverId = String(batch.server_id || "studio").slice(0, 64);

  const sessionExists = data.sessions.some((s) => s.id === sid && s.game_id === gameId);
  if (!sessionExists) {
    newSessions.push({
      id: sid,
      game_id: gameId,
      player_ref: playerRef,
      server_id: serverId,
      started_at: batch.started_at || serverTs,
      ended_at: null,
    });
  }

  for (const e of batch.events || []) {
    newEvents.push({
      id: uuid(),
      session_id: sid,
      game_id: gameId,
      name: String(e.name).slice(0, 120),
      properties: e.properties ?? null,
      client_ts: e.client_ts || null,
      server_ts: serverTs,
    });
  }

  for (const f of batch.feedback || []) {
    newFeedback.push({
      id: uuid(),
      game_id: gameId,
      session_id: sid,
      player_ref: playerRef,
      content: String(f.content).slice(0, 2000),
      created_at: serverTs,
    });
  }

  // commit
  data.sessions.push(...newSessions);
  data.events.push(...newEvents);
  data.feedback.push(...newFeedback);

  if (batch.ended) {
    const s = data.sessions.find((s) => s.id === sid && s.game_id === gameId);
    if (s) s.ended_at = serverTs;
  }
  persist();

  return {
    session_id: sid,
    sessions: newSessions.length,
    events: newEvents.length,
    feedback: newFeedback.length,
  };
}

// ---- dashboard reads ----
const RECENT_WINDOW = 500; // how many recent events the live stream can filter over
const SERIES_BUCKETS = 40; // resolution of the Overall time-vs-events chart

const tsOf = (e) => (typeof e.server_ts === "number" ? e.server_ts : Date.parse(e.server_ts));

// Bucket events over time into a small series the frontend can chart. Returns
// evenly spaced buckets between the first and last event so the x-axis is real
// wall-clock time. A degenerate span (all events at once) collapses to a single
// bucket rather than dividing by zero.
function buildSeries(evs) {
  if (evs.length === 0) return { buckets: [], bucketMs: 0, start: null, end: null };
  let min = Infinity;
  let max = -Infinity;
  for (const e of evs) {
    const t = tsOf(e);
    if (t < min) min = t;
    if (t > max) max = t;
  }
  const span = max - min;
  if (span <= 0) return { buckets: [{ t: min, count: evs.length }], bucketMs: 1, start: min, end: min };

  const bucketMs = Math.max(1, Math.ceil(span / SERIES_BUCKETS));
  const n = Math.floor(span / bucketMs) + 1;
  const buckets = Array.from({ length: n }, (_, i) => ({ t: min + i * bucketMs, count: 0 }));
  for (const e of evs) {
    const idx = Math.min(n - 1, Math.floor((tsOf(e) - min) / bucketMs));
    buckets[idx].count++;
  }
  return { buckets, bucketMs, start: min, end: max };
}

export const stats = {
  overview(gameId, { from, to } = {}) {
    const rangeStart = from ? Date.parse(`${from}T00:00:00.000Z`) : null;
    const rangeEnd = to ? Date.parse(`${to}T23:59:59.999Z`) : null;
    const eventInRange = (event) => {
      const time =
        typeof event.server_ts === "number" ? event.server_ts : Date.parse(event.server_ts);
      return (!rangeStart || time >= rangeStart) && (!rangeEnd || time <= rangeEnd);
    };
    const evs = data.events.filter((e) => e.game_id === gameId && eventInRange(e));
    const gameSessions = data.sessions.filter((s) => s.game_id === gameId);

    // session_id -> { player_ref, server_id } so each event can be attributed
    // to a player and a server instance without duplicating those on the event.
    const sessionMeta = new Map();
    for (const s of gameSessions)
      sessionMeta.set(s.id, { player_ref: s.player_ref, server_id: s.server_id || "studio" });

    // full-history event-name counts (drives the Overall page)
    const counts = new Map();
    for (const e of evs) counts.set(e.name, (counts.get(e.name) || 0) + 1);
    const topEvents = [...counts.entries()]
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => b.n - a.n);

    // distinct players / servers with session counts — these populate the filters
    const playerCounts = new Map();
    const serverCounts = new Map();
    for (const s of gameSessions) {
      playerCounts.set(s.player_ref, (playerCounts.get(s.player_ref) || 0) + 1);
      const sv = s.server_id || "studio";
      serverCounts.set(sv, (serverCounts.get(sv) || 0) + 1);
    }
    const players = [...playerCounts.entries()].map(([player_ref, sessions]) => ({ player_ref, sessions }));
    const servers = [...serverCounts.entries()].map(([server_id, sessions]) => ({ server_id, sessions }));

    // recent events, each attributed to its player + server for grouping/filtering
    const recentEvents = evs
      .slice(-RECENT_WINDOW)
      .reverse()
      .map((e) => {
        const meta = sessionMeta.get(e.session_id) || {};
        return {
          name: e.name,
          properties: e.properties,
          server_ts: e.server_ts,
          session_id: e.session_id,
          player_ref: meta.player_ref || null,
          server_id: meta.server_id || "studio",
        };
      });

    // time-vs-events series for the Overall chart. Bucket every in-range event
    // by server_ts into ~40 evenly spaced slots between the first and last event.
    const series = buildSeries(evs);

    return {
      sessions: gameSessions.length,
      events: evs.length,
      feedback: data.feedback.filter((f) => f.game_id === gameId).length,
      eventNames: topEvents.map((t) => t.name),
      players,
      servers,
      topEvents,
      recentEvents,
      series,
      range: { from: from || null, to: to || null },
    };
  },
  feedbackText: (gameId) =>
    data.feedback
      .filter((f) => f.game_id === gameId)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 100)
      .map((f) => f.content),
};
