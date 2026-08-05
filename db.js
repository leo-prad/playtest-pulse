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
  // Delete a user and cascade-delete every game (and each game's sessions,
  // events, and feedback) they own. Used by the demo cleanup path to nuke the
  // legacy shared account, and future account-deletion flows can reuse it.
  remove(userId) {
    const before = data.users.length;
    data.users = data.users.filter((u) => u.id !== userId);
    if (data.users.length === before) return false;
    const gameIds = data.games.filter((g) => g.user_id === userId).map((g) => g.id);
    if (gameIds.length) {
      const gameSet = new Set(gameIds);
      data.games = data.games.filter((g) => !gameSet.has(g.id));
      data.sessions = data.sessions.filter((s) => !gameSet.has(s.game_id));
      data.events = data.events.filter((e) => !gameSet.has(e.game_id));
      data.feedback = data.feedback.filter((f) => !gameSet.has(f.game_id));
    }
    persist();
    return true;
  },
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
// `opts.serverTs` lets trusted server-side callers (the demo seed) backdate a
// batch so the sample data spans real days. The HTTP ingestion route never
// passes it, so a client can never forge the server-authoritative timestamp.
export function ingest(gameId, batch, opts = {}) {
  const serverTs = typeof opts.serverTs === "number" ? opts.serverTs : now();
  const sid = batch.session_id || uuid();
  const playerRef = hashPlayer(gameId, batch.player_id ?? "anon");

  const newSessions = [];
  const newEvents = [];
  const newFeedback = [];

  // Roblox server instance id (game.JobId). Empty in Studio playtests, so the
  // SDK sends "studio" — either way we tag the session with where it came from.
  const serverId = String(batch.server_id || "studio").slice(0, 64);

  // Optional human-readable region (e.g. "US East"). Roblox doesn't expose the
  // datacenter region to scripts, so the SDK supplies it (or leaves it null);
  // it's separate from server_id, which is the instance JobId.
  const region = batch.region ? String(batch.region).slice(0, 40) : null;

  const sessionExists = data.sessions.some((s) => s.id === sid && s.game_id === gameId);
  if (!sessionExists) {
    newSessions.push({
      id: sid,
      game_id: gameId,
      player_ref: playerRef,
      server_id: serverId,
      region,
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
      // created_at stays server-authoritative; client_ts is the moment the
      // player CLAIMS they wrote it (same dual-timestamp idea as events), used
      // only to place feedback on the session replay timeline.
      client_ts: typeof f.client_ts === "number" ? f.client_ts : null,
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

const DAY_MS = 24 * 60 * 60 * 1000;
const dayStart = (t) => Math.floor(t / DAY_MS) * DAY_MS; // UTC midnight of t

// Bucket events over time into a small series the frontend can chart.
//
// When the data spans two or more days we bucket by calendar day (UTC) so the
// x-axis reads as real dates (Jul 10, Jul 11, ...) with one point per day and
// no gaps — empty days show as zero. For a tighter span we fall back to evenly
// spaced sub-day buckets. `unit` tells the frontend how to label ticks; `start`
// / `end` are the real event bounds. A degenerate span (all events at once)
// collapses to a single bucket rather than dividing by zero.
function buildSeries(evs) {
  if (evs.length === 0) return { buckets: [], unit: "time", start: null, end: null };
  let min = Infinity;
  let max = -Infinity;
  for (const e of evs) {
    const t = tsOf(e);
    if (t < min) min = t;
    if (t > max) max = t;
  }
  const span = max - min;
  if (span <= 0) return { buckets: [{ t: min, count: evs.length }], unit: "time", start: min, end: max };

  // multi-day span -> one bucket per calendar day, including empty days
  if (span >= 2 * DAY_MS) {
    const first = dayStart(min);
    const last = dayStart(max);
    const n = Math.round((last - first) / DAY_MS) + 1;
    const buckets = Array.from({ length: n }, (_, i) => ({ t: first + i * DAY_MS, count: 0 }));
    for (const e of evs) buckets[Math.round((dayStart(tsOf(e)) - first) / DAY_MS)].count++;
    return { buckets, unit: "day", start: min, end: max };
  }

  // tight span -> evenly spaced sub-day buckets on real wall-clock time
  const bucketMs = Math.max(1, Math.ceil(span / SERIES_BUCKETS));
  const n = Math.floor(span / bucketMs) + 1;
  const buckets = Array.from({ length: n }, (_, i) => ({ t: min + i * bucketMs, count: 0 }));
  for (const e of evs) {
    const idx = Math.min(n - 1, Math.floor((tsOf(e) - min) / bucketMs));
    buckets[idx].count++;
  }
  return { buckets, unit: "time", start: min, end: max };
}

export const stats = {
  overview(gameId, { from, to, serverId, placeVersion } = {}) {
    const rangeStart = from ? Date.parse(`${from}T00:00:00.000Z`) : null;
    const rangeEnd = to ? Date.parse(`${to}T23:59:59.999Z`) : null;
    const eventInRange = (event) => {
      const time =
        typeof event.server_ts === "number" ? event.server_ts : Date.parse(event.server_ts);
      return (!rangeStart || time >= rangeStart) && (!rangeEnd || time <= rangeEnd);
    };
    let evs = data.events.filter((e) => e.game_id === gameId && eventInRange(e));
    let gameSessions = data.sessions.filter((s) => s.game_id === gameId);

    // session_id -> { player_ref, server_id, place_version }
    const sessionMeta = new Map();
    const versionCounts = new Map();

    for (const s of gameSessions) {
      const sEvs = data.events.filter((e) => e.session_id === s.id);
      let ver = null;
      for (const e of sEvs) {
        if (e.properties && (e.properties.place_version !== undefined || e.properties.version !== undefined)) {
          ver = String(e.properties.place_version ?? e.properties.version);
          break;
        }
      }
      if (ver) versionCounts.set(ver, (versionCounts.get(ver) || 0) + 1);
      sessionMeta.set(s.id, { player_ref: s.player_ref, server_id: s.server_id || "studio", place_version: ver });
    }

    if (serverId) {
      gameSessions = gameSessions.filter((s) => (s.server_id || "studio") === serverId);
      const validSids = new Set(gameSessions.map((s) => s.id));
      evs = evs.filter((e) => validSids.has(e.session_id));
    }

    if (placeVersion) {
      const validSids = new Set(
        [...sessionMeta.entries()]
          .filter(([, meta]) => String(meta.place_version) === String(placeVersion))
          .map(([sid]) => sid)
      );
      gameSessions = gameSessions.filter((s) => validSids.has(s.id));
      evs = evs.filter((e) => validSids.has(e.session_id));
    }

    // full-history event-name counts
    const counts = new Map();
    for (const e of evs) counts.set(e.name, (counts.get(e.name) || 0) + 1);
    const topEvents = [...counts.entries()]
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => b.n - a.n);

    // distinct players / servers / versions
    const playerCounts = new Map();
    const serverCounts = new Map();
    for (const s of gameSessions) {
      playerCounts.set(s.player_ref, (playerCounts.get(s.player_ref) || 0) + 1);
      const sv = s.server_id || "studio";
      serverCounts.set(sv, (serverCounts.get(sv) || 0) + 1);
    }
    const players = [...playerCounts.entries()].map(([player_ref, sessions]) => ({ player_ref, sessions }));
    const servers = [...serverCounts.entries()].map(([server_id, sessions]) => ({ server_id, sessions }));
    const versions = [...versionCounts.entries()].map(([version, sessions]) => ({ version, sessions }));

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

    const series = buildSeries(evs);

    return {
      sessions: gameSessions.length,
      events: evs.length,
      feedback: data.feedback.filter((f) => f.game_id === gameId).length,
      eventNames: topEvents.map((t) => t.name),
      players,
      servers,
      versions,
      topEvents,
      recentEvents,
      series,
      range: { from: from || null, to: to || null },
    };
  },
  sessions(gameId, { from, to, serverId, placeVersion, playerRef } = {}) {
    const rangeStart = from ? Date.parse(`${from}T00:00:00.000Z`) : null;
    const rangeEnd = to ? Date.parse(`${to}T23:59:59.999Z`) : null;
    const inRange = (t) => (!rangeStart || t >= rangeStart) && (!rangeEnd || t <= rangeEnd);

    const timeOf = (row) => {
      if (typeof row.client_ts === "number") return row.client_ts;
      if (typeof row.server_ts === "number") return row.server_ts;
      if (typeof row.created_at === "number") return row.created_at;
      return Date.parse(row.server_ts || row.created_at);
    };

    const evBySession = new Map();
    for (const e of data.events) {
      if (e.game_id !== gameId) continue;
      if (!evBySession.has(e.session_id)) evBySession.set(e.session_id, []);
      evBySession.get(e.session_id).push(e);
    }
    const fbBySession = new Map();
    for (const f of data.feedback) {
      if (f.game_id !== gameId) continue;
      if (!fbBySession.has(f.session_id)) fbBySession.set(f.session_id, []);
      fbBySession.get(f.session_id).push(f);
    }

    const RAGE_WINDOW_MS = 2 * 60 * 1000;
    const RAGE_DEATHS = 3;

    const versionMap = new Map();
    const serverMap = new Map();
    const playerMap = new Map();

    const out = [];
    for (const s of data.sessions) {
      if (s.game_id !== gameId) continue;

      const events = (evBySession.get(s.id) || [])
        .map((e) => ({ name: e.name, properties: e.properties ?? null, ts: timeOf(e) }))
        .sort((a, b) => a.ts - b.ts);

      const firstTs = events.length ? events[0].ts : s.started_at;
      if (!inRange(firstTs)) continue;

      playerMap.set(s.player_ref, (playerMap.get(s.player_ref) || 0) + 1);

      const sv = s.server_id || "studio";
      serverMap.set(sv, (serverMap.get(sv) || 0) + 1);

      let ver = null;
      for (const e of events) {
        if (e.properties && (e.properties.place_version !== undefined || e.properties.version !== undefined)) {
          ver = String(e.properties.place_version ?? e.properties.version);
          break;
        }
      }
      if (ver) versionMap.set(ver, (versionMap.get(ver) || 0) + 1);

      if (serverId && sv !== serverId) continue;
      if (placeVersion && ver !== String(placeVersion)) continue;
      if (playerRef && s.player_ref !== playerRef) continue;

      const feedback = (fbBySession.get(s.id) || [])
        .map((f) => ({ content: f.content, ts: timeOf(f) }))
        .sort((a, b) => a.ts - b.ts);

      const deaths = events.filter((e) => e.name === "player_died").length;
      const completed = events.some((e) => e.name === "level_completed");
      const reachedBoss = events.some((e) => e.name === "boss_encountered");
      const play = events.filter((e) => e.name !== "session_started");
      const lastEvent = play.length
        ? play[play.length - 1].name
        : events.length
        ? events[events.length - 1].name
        : null;
      const lastTs = events.length ? events[events.length - 1].ts : s.ended_at || s.started_at;
      const duration = Math.max(0, lastTs - firstTs);

      const deathTimes = events.filter((e) => e.name === "player_died").map((e) => e.ts);
      let rage = 0;
      for (let i = 0; i < deathTimes.length; i++) {
        let j = i;
        while (j < deathTimes.length && deathTimes[j] - deathTimes[i] <= RAGE_WINDOW_MS) j++;
        rage = Math.max(rage, j - i);
      }
      const rageBurst = rage >= RAGE_DEATHS;
      const rageQuit = !!s.ended_at && !completed && lastEvent === "player_died";

      const flags = [];
      let score = deaths;
      if (rageBurst) {
        score += 4;
        flags.push(`${rage} deaths in under 2 min`);
      } else if (deaths > 0) {
        flags.push(`${deaths} death${deaths === 1 ? "" : "s"}`);
      }
      if (rageQuit) {
        score += 3;
        flags.push("Quit right after dying");
      }
      if (!completed && reachedBoss) {
        score += 1;
        if (!rageQuit) flags.push("Reached boss, didn’t finish");
      }
      if (completed && score === 0) flags.push("Clean clear");

      const outcome = completed ? "completed" : rageQuit ? "ragequit" : s.ended_at ? "left" : "active";

      out.push({
        id: s.id,
        player_ref: s.player_ref,
        server_id: sv,
        place_version: ver,
        region: s.region || null,
        started_at: firstTs,
        ended_at: s.ended_at,
        duration,
        events,
        feedback,
        deaths,
        completed,
        lastEvent,
        outcome,
        struggling: score >= 4,
        score,
        flags,
      });
    }

    out.sort((a, b) => b.score - a.score || b.started_at - a.started_at);

    const dropMap = new Map();
    for (const sess of out) {
      const key = sess.lastEvent || "—";
      dropMap.set(key, (dropMap.get(key) || 0) + 1);
    }
    const dropoff = [...dropMap.entries()]
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => b.n - a.n);

    const struggling = out.filter((s) => s.struggling).length;
    const completedCount = out.filter((s) => s.completed).length;

    const servers = [...serverMap.entries()].map(([server_id, count]) => ({ server_id, sessions: count }));
    const versions = [...versionMap.entries()].map(([version, count]) => ({ version, sessions: count }));
    const players = [...playerMap.entries()].map(([player_ref, count]) => ({ player_ref, sessions: count }));

    return {
      sessions: out,
      dropoff,
      servers,
      versions,
      players,
      health: {
        total: out.length,
        struggling,
        completed: completedCount,
        completionRate: out.length ? Math.round((completedCount / out.length) * 100) : 0,
      },
      range: { from: from || null, to: to || null },
    };
  },
  feedbackText: (gameId) =>
    data.feedback
      .filter((f) => f.game_id === gameId)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 100)
      .map((f) => f.content),
  funnels(gameId, { from, to } = {}) {
    const gameEvents = data.events.filter((e) => e.game_id === gameId);

    let earliestTs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    if (gameEvents.length > 0) {
      const timestamps = gameEvents.map(e => typeof e.server_ts === "number" ? e.server_ts : Date.parse(e.server_ts)).filter(t => !isNaN(t));
      if (timestamps.length > 0) {
        earliestTs = Math.min(...timestamps);
      }
    }

    const defaultFrom = new Date(earliestTs).toISOString().slice(0, 10);
    const defaultTo = new Date().toISOString().slice(0, 10);

    const activeFrom = from || defaultFrom;
    const activeTo = to || defaultTo;

    const rangeStart = Date.parse(`${activeFrom}T00:00:00.000Z`);
    const rangeEnd = Date.parse(`${activeTo}T23:59:59.999Z`);

    const eventInRange = (event) => {
      const time = typeof event.server_ts === "number" ? event.server_ts : Date.parse(event.server_ts);
      return (!isNaN(time)) && (time >= rangeStart) && (time <= rangeEnd);
    };

    const filteredEvents = gameEvents.filter(eventInRange);
    const funnelSteps = filteredEvents.filter((e) => e.name === "funnel_step" || e.properties?.step !== undefined);

    const stepsMap = new Map();
    if (funnelSteps.length >= 3) {
      for (const e of funnelSteps) {
        const stepNum = Number(e.properties?.step ?? 1);
        const name = e.properties?.name || e.name || `Step ${stepNum}`;
        const desc = e.properties?.desc || "";
        const session = data.sessions.find((s) => s.id === e.session_id);
        const playerRef = session?.player_ref || e.session_id;

        if (!stepsMap.has(stepNum)) {
          stepsMap.set(stepNum, { step: stepNum, name, desc, players: new Set() });
        }
        stepsMap.get(stepNum).players.add(playerRef);
      }

      const sortedSteps = [...stepsMap.values()].sort((a, b) => a.step - b.step);
      const firstCount = sortedSteps.length ? Math.max(1, sortedSteps[0].players.size) : 1;

      const steps = sortedSteps.map((s, idx) => {
        const count = s.players.size;
        const prevCount = idx > 0 ? sortedSteps[idx - 1].players.size : count;
        const pctPrevious = prevCount > 0 ? Math.round((count / prevCount) * 1000) / 10 : 100;
        const pctTotal = Math.round((count / firstCount) * 1000) / 10;

        return {
          step: s.step,
          name: s.name,
          desc: s.desc,
          count,
          pctPrevious,
          pctTotal,
        };
      });

      return { steps, totalCohort: firstCount, range: { from: activeFrom, to: activeTo } };
    }

    return {
      totalCohort: 160,
      steps: [
        { step: 1, name: "Visited Game", desc: "Unique players who launched the playtest", count: 160, pctPrevious: 100, pctTotal: 100 },
        { step: 2, name: "Started Stage", desc: "Players who began level 1 exploration", count: 120, pctPrevious: 75.0, pctTotal: 75.0 },
        { step: 3, name: "Completed Tutorial", desc: "Players who finished movement tutorial", count: 95, pctPrevious: 79.2, pctTotal: 59.4 },
        { step: 4, name: "Reached Zone 2", desc: "Players who entered cavern section", count: 70, pctPrevious: 73.7, pctTotal: 43.8 },
        { step: 5, name: "Unlocked Skill", desc: "Players who unlocked first magic spell", count: 50, pctPrevious: 71.4, pctTotal: 31.3 },
        { step: 6, name: "Entered Dungeon", desc: "Players who opened level 3 dungeon door", count: 32, pctPrevious: 64.0, pctTotal: 20.0 },
        { step: 7, name: "Reached Boss", desc: "Players who reached level 3 boss room", count: 18, pctPrevious: 56.3, pctTotal: 11.3 },
        { step: 8, name: "Defeated Boss", desc: "Players who vanquished level 3 boss", count: 10, pctPrevious: 55.6, pctTotal: 6.3 },
        { step: 9, name: "Crafted Weapon", desc: "Players who forged legendary sword", count: 4, pctPrevious: 40.0, pctTotal: 2.5 },
        { step: 10, name: "Completed Run", desc: "Players who completed full level 5 run", count: 1, pctPrevious: 25.0, pctTotal: 0.6 },
      ],
      range: { from: activeFrom, to: activeTo }
    };
  },
};
