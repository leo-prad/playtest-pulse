// app.js — Playtest Pulse dashboard client. Vanilla JS, no build step.

const DEFAULT_COLS = { time: true, player: true, server: true, data: true, feedback: true };

function loadCols() {
  try {
    return { ...DEFAULT_COLS, ...JSON.parse(localStorage.getItem("pp_cols") || "{}") };
  } catch {
    return { ...DEFAULT_COLS };
  }
}

const state = {
  token: localStorage.getItem("pp_token") || null,
  mode: "login", // or "signup"
  games: [],
  currentGameId: null,
  pollTimer: null,
  tab: "overall",
  latest: null, // last stats payload, so filters re-render without a refetch
  revealKey: false,
  filters: { event: "", player: "", server: "", version: "", search: "", from: "", to: "" },
  funnelFilters: { from: "", to: "" },
  sort: { key: "time", dir: "desc" }, // Events table sort (time = newest first)
  cols: loadCols(), // which Events columns are visible (persisted)
  summarizedGameId: null, // game whose feedback we've already auto-crunched this session
  sessions: null, // last /sessions payload (Sessions tab)
  selectedSession: null, // id of the session opened in the replay panel
  sessFilter: "all", // Sessions list filter: all | struggling | completed | feedback
  replaySort: "desc", // replay event list order: "desc" (newest first) | "asc"
  _sessSig: null, // change signature so polling doesn't needlessly redraw the list
};

const $ = (id) => document.getElementById(id);

function storeToken(token) {
  state.token = token;
  localStorage.setItem("pp_token", token);
}

function clearSession() {
  localStorage.removeItem("pp_token");
  state.token = null;
}

const query = new URLSearchParams(window.location.search);
const oauthToken = query.get("oauth_token");
if (oauthToken) {
  storeToken(oauthToken);
  // The state object was created before the callback query was read. Keep it
  // in sync so this same page load enters the dashboard instead of showing
  // the sign-in screen until a manual refresh.
  state.token = oauthToken;
  history.replaceState({}, "", window.location.pathname);
}

// ---------- API helper ----------
async function api(pathname, { method = "GET", body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth && state.token) headers.Authorization = "Bearer " + state.token;
  const res = await fetch(pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed.");
  const refreshedToken = auth && res.headers.get("X-Session-Token");
  if (refreshedToken) storeToken(refreshedToken);
  return data;
}

// ---------- view switching ----------
function show(view) {
  for (const v of ["auth-view", "empty-view", "dash-view"]) $(v).classList.add("hidden");
  $(view).classList.remove("hidden");
  $("session-controls").classList.toggle("hidden", view === "auth-view");
}

// ---------- auth ----------
function renderAuthMode() {
  const signup = state.mode === "signup";
  $("auth-title").textContent = signup ? "Create account" : "Sign in";
  $("auth-sub").textContent = signup
    ? "Spin up a workspace for your games in seconds."
    : "Track what actually happens in your playtests.";
  $("auth-submit").textContent = signup ? "Create account" : "Sign in";
  $("switch-text").textContent = signup ? "Already have an account?" : "New here?";
  $("switch-link").textContent = signup ? "Sign in" : "Create an account";
  $("password").autocomplete = signup ? "new-password" : "current-password";
}

$("switch-link").addEventListener("click", (e) => {
  e.preventDefault();
  state.mode = state.mode === "login" ? "signup" : "login";
  $("auth-error").classList.add("hidden");
  renderAuthMode();
});

$("auth-submit").addEventListener("click", async () => {
  const email = $("email").value.trim();
  const password = $("password").value;
  const err = $("auth-error");
  err.classList.add("hidden");
  try {
    const path = state.mode === "signup" ? "/api/auth/signup" : "/api/auth/login";
    const data = await api(path, { method: "POST", body: { email, password }, auth: false });
    storeToken(data.token);
    await enterApp();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove("hidden");
  }
});

[$("email"), $("password")].forEach((el) =>
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("auth-submit").click();
  })
);

// Try the demo → one-click throwaway account with sample data. Each click
// creates a fresh, isolated user server-side; nothing is shared between
// visitors, and the token lives only in this browser's localStorage.
$("demo-btn").addEventListener("click", async () => {
  const err = $("auth-error");
  const btn = $("demo-btn");
  err.classList.add("hidden");
  btn.disabled = true;
  const original = btn.innerHTML;
  btn.textContent = "Spinning up your demo…";
  try {
    const data = await api("/api/auth/demo", { method: "POST", auth: false });
    storeToken(data.token);
    await enterApp();
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove("hidden");
    btn.disabled = false;
    btn.innerHTML = original;
  }
});

$("logout-btn").addEventListener("click", () => {
  clearSession();
  if (state.pollTimer) clearInterval(state.pollTimer);
  show("auth-view");
});

// ---------- games / dropdown ----------
function currentGame() {
  return state.games.find((g) => g.id === state.currentGameId);
}

async function loadGames() {
  state.games = await api("/api/games");
  renderDropdown();
}

// Stable, readable color + short label for an anonymized player_ref.
function playerColor(ref) {
  let h = 0;
  for (let i = 0; i < (ref || "").length; i++) h = (h * 31 + ref.charCodeAt(i)) % 360;
  return `hsl(${h} 70% 62%)`;
}
const playerLabel = (ref) => (ref ? ref.slice(0, 6) : "anon");
const serverLabel = (id) => (id === "studio" ? "Studio" : id);

function renderDropdown() {
  const g = currentGame();
  $("dd-current").textContent = g ? g.name : "Select game";

  const list = $("dd-list");
  list.innerHTML = "";
  for (const game of state.games) {
    const row = document.createElement("div");
    row.className = "dd-row" + (game.id === state.currentGameId ? " active" : "");
    row.setAttribute("role", "menuitem");

    const name = document.createElement("button");
    name.className = "dd-name";
    name.textContent = game.name;
    name.addEventListener("click", () => {
      selectGame(game.id);
      closeDropdown();
    });

    const actions = document.createElement("div");
    actions.className = "dd-actions";

    const edit = document.createElement("button");
    edit.className = "dd-icon";
    edit.title = "Rename";
    edit.setAttribute("aria-label", "Rename " + game.name);
    edit.innerHTML = "&#9998;"; // pencil
    edit.addEventListener("click", (e) => {
      e.stopPropagation();
      openRenameModal(game);
    });

    const del = document.createElement("button");
    del.className = "dd-icon danger";
    del.title = "Delete";
    del.setAttribute("aria-label", "Delete " + game.name);
    del.innerHTML = "&#128465;"; // trash
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      openDeleteModal(game);
    });

    actions.append(edit, del);
    row.append(name, actions);
    list.appendChild(row);
  }
}

function openDropdown() {
  $("dd-menu").classList.remove("hidden");
  $("dd-trigger").setAttribute("aria-expanded", "true");
}
function closeDropdown() {
  $("dd-menu").classList.add("hidden");
  $("dd-trigger").setAttribute("aria-expanded", "false");
}
$("dd-trigger").addEventListener("click", (e) => {
  e.stopPropagation();
  $("dd-menu").classList.contains("hidden") ? openDropdown() : closeDropdown();
});
document.addEventListener("click", (e) => {
  if (!$("game-dropdown").contains(e.target)) closeDropdown();
});

function selectGame(id) {
  state.currentGameId = id;
  state.filters = { event: "", player: "", server: "", from: "", to: "" };
  state.funnelFilters = { from: "", to: "" };
  if ($("funnel-filter-from")) $("funnel-filter-from").value = "";
  if ($("funnel-filter-to")) $("funnel-filter-to").value = "";
  state.sessions = null;
  state.selectedSession = null;
  state._sessSig = null;
  renderDropdown();
  startDashboard();
}

async function createGame() {
  closeDropdown();
  const name = await promptModal("New game", "Name your game", "e.g. Dungeon Crawler", "Create");
  if (!name || !name.trim()) return;
  const game = await api("/api/games", { method: "POST", body: { name: name.trim() } });
  await loadGames();
  state.currentGameId = game.id;
  renderDropdown();
  show("dash-view");
  startDashboard();
}

$("dd-newgame").addEventListener("click", createGame);
$("empty-new-game").addEventListener("click", createGame);

async function renameGame(game, newName) {
  await api(`/api/games/${game.id}`, { method: "PATCH", body: { name: newName } });
  await loadGames();
  renderDropdown();
}

async function deleteGame(game) {
  await api(`/api/games/${game.id}`, { method: "DELETE" });
  const wasCurrent = game.id === state.currentGameId;
  await loadGames();
  if (wasCurrent) {
    if (state.games.length) {
      selectGame(state.games[0].id);
    } else {
      if (state.pollTimer) clearInterval(state.pollTimer);
      state.currentGameId = null;
      show("empty-view");
    }
  }
}

// ---------- tabs ----------
const TAB_IDS = ["overall", "sessions", "events", "funnels", "connection"];

function switchTab(id) {
  state.tab = id;
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t.dataset.tab === id);
  for (const tid of TAB_IDS) $(`tab-${tid}`).classList.toggle("hidden", state.tab !== tid);
  if (state.tab === "sessions") loadSessions(); // make the first open snappy
  if (state.tab === "funnels") loadFunnels();
}

$("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  switchTab(btn.dataset.tab);
});

// ---------- filters ----------
$("filter-event").addEventListener("input", (e) => {
  state.filters.event = e.target.value.trim().toLowerCase();
  renderStream();
});
$("filter-player").addEventListener("change", (e) => {
  state.filters.player = e.target.value;
  renderStream();
});
$("filter-server").addEventListener("change", (e) => {
  state.filters.server = e.target.value;
  renderStream();
});
if ($("sess-filter-player")) {
  $("sess-filter-player").addEventListener("change", (e) => {
    state.filters.player = e.target.value;
    loadSessions();
  });
}
if ($("sess-filter-server")) {
  $("sess-filter-server").addEventListener("change", (e) => {
    state.filters.server = e.target.value;
    loadSessions();
  });
}
if ($("sess-filter-version")) {
  $("sess-filter-version").addEventListener("change", (e) => {
    state.filters.version = e.target.value;
    loadSessions();
  });
}
if ($("sess-search")) {
  $("sess-search").addEventListener("input", (e) => {
    state.filters.search = e.target.value;
    if (state.sessions?.sessions) {
      renderSessionList(state.sessions.sessions);
    }
  });
}
[$("sess-filter-from"), $("sess-filter-to")].forEach((el) => {
  if (el) {
    el.addEventListener("change", () => {
      state.filters.from = $("sess-filter-from")?.value || "";
      state.filters.to = $("sess-filter-to")?.value || "";
      loadSessions();
    });
  }
});
if ($("sess-filter-clear")) {
  $("sess-filter-clear").addEventListener("click", () => {
    state.filters = { event: "", player: "", server: "", version: "", search: "", from: "", to: "" };
    if ($("sess-search")) $("sess-search").value = "";
    if ($("sess-filter-player")) $("sess-filter-player").value = "";
    if ($("sess-filter-server")) $("sess-filter-server").value = "";
    if ($("sess-filter-version")) $("sess-filter-version").value = "";
    if ($("sess-filter-from")) $("sess-filter-from").value = "";
    if ($("sess-filter-to")) $("sess-filter-to").value = "";
    loadSessions();
  });
}
[$("filter-from"), $("filter-to")].forEach((el) =>
  el.addEventListener("change", () => {
    state.filters.from = $("filter-from").value;
    state.filters.to = $("filter-to").value;
    refreshStats();
  })
);
[$("funnel-filter-from"), $("funnel-filter-to")].forEach((el) => {
  if (el) {
    el.addEventListener("change", () => {
      state.funnelFilters.from = $("funnel-filter-from").value;
      state.funnelFilters.to = $("funnel-filter-to").value;
      loadFunnels();
    });
  }
});
$("filter-clear").addEventListener("click", () => {
  state.filters = { event: "", player: "", server: "", from: "", to: "" };
  $("filter-event").value = "";
  $("filter-player").value = "";
  $("filter-server").value = "";
  $("filter-from").value = "";
  $("filter-to").value = "";
  refreshStats();
});

// chart drag-zoom sets the date range; this clears just the dates back to full
// history. Both the Overall and Events charts share the same range + button.
function resetChartZoom() {
  state.filters.from = "";
  state.filters.to = "";
  $("filter-from").value = "";
  $("filter-to").value = "";
  refreshStats();
}
$("chart-reset").addEventListener("click", resetChartZoom);
$("chart-reset-2").addEventListener("click", resetChartZoom);

// ---------- sessions: list filter (All / Struggling) ----------
document.querySelectorAll(".sess-filter").forEach((btn) =>
  btn.addEventListener("click", () => {
    state.sessFilter = btn.dataset.sfilter;
    document.querySelectorAll(".sess-filter").forEach((b) => b.classList.toggle("active", b === btn));
    if (state.sessions) renderSessionList(state.sessions.sessions);
  })
);

// ---------- events table: sorting ----------
document.querySelectorAll(".et-head .sortable").forEach((h) =>
  h.addEventListener("click", () => {
    const key = h.dataset.sort;
    if (state.sort.key === key) {
      state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
    } else {
      state.sort.key = key;
      state.sort.dir = key === "time" ? "desc" : "asc";
    }
    renderStream();
  })
);

function renderSortArrows() {
  document.querySelectorAll(".et-head .sortable").forEach((h) => {
    const active = h.dataset.sort === state.sort.key;
    h.classList.toggle("active", active);
    h.querySelector(".sort-arrow").textContent = active ? (state.sort.dir === "asc" ? "↑" : "↓") : "";
  });
}

// ---------- events table: column show/hide ----------
function applyCols() {
  const table = $("events-table");
  for (const col of Object.keys(DEFAULT_COLS)) {
    table.classList.toggle(`hide-${col}`, !state.cols[col]);
    const box = document.querySelector(`#cols-menu input[data-col="${col}"]`);
    if (box) box.checked = state.cols[col];
  }
}
$("cols-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("cols-menu");
  const open = menu.classList.toggle("hidden");
  $("cols-btn").setAttribute("aria-expanded", String(!open));
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".cols-wrap")) $("cols-menu").classList.add("hidden");
});
document.querySelectorAll('#cols-menu input[data-col]').forEach((box) =>
  box.addEventListener("change", () => {
    state.cols[box.dataset.col] = box.checked;
    localStorage.setItem("pp_cols", JSON.stringify(state.cols));
    applyCols();
  })
);

function syncFilterOptions(s) {
  const pSel = $("filter-player");
  const sSel = $("filter-server");
  const players = s.players || [];
  const servers = s.servers || [];

  pSel.innerHTML =
    `<option value="">All players (${players.length})</option>` +
    players
      .map((p) => `<option value="${p.player_ref}">${escapeHtml(playerLabel(p.player_ref))} · ${p.sessions} sess.</option>`)
      .join("");
  pSel.value = state.filters.player;

  sSel.innerHTML =
    `<option value="">All servers (${servers.length})</option>` +
    servers
      .map((v) => `<option value="${escapeHtml(v.server_id)}">${escapeHtml(serverLabel(v.server_id))} · ${v.sessions} sess.</option>`)
      .join("");
  sSel.value = state.filters.server;

  syncCustomSelect(pSel);
  syncCustomSelect(sSel);
}

// ---------- dashboard ----------
async function refreshStats() {
  const game = currentGame();
  if (!game) return;
  let s;
  try {
    const params = new URLSearchParams();
    if (state.filters.from) params.set("from", state.filters.from);
    if (state.filters.to) params.set("to", state.filters.to);
    const suffix = params.size ? `?${params}` : "";
    s = await api(`/api/games/${game.id}/stats${suffix}`);
  } catch {
    return; // transient; next tick retries
  }
  state.latest = s;

  $("stat-sessions").textContent = s.sessions;
  $("stat-events").textContent = s.events;
  $("stat-feedback").textContent = s.feedback;

  // most-fired events (full aggregate)
  const max = Math.max(1, ...s.topEvents.map((e) => e.n));
  $("top-events").innerHTML =
    s.topEvents
      .map(
        (e) => `<li>
          <span class="ev-name">${escapeHtml(e.name)}</span>
          <span class="track"><span class="fill" style="width:${(e.n / max) * 100}%"></span></span>
          <span class="ev-count">${e.n}</span>
        </li>`
      )
      .join("") || `<li class="stream-empty">No events yet.</li>`;

  syncFilterOptions(s);
  renderStream();
  renderChart(s.series); // Overall tab
  renderChart(s.series, { hostId: "events-chart-2", hintId: "chart-hint-2", resetId: "chart-reset-2", gradId: "areaGrad2" }); // Events tab
  loadSessions();
}

function renderStream() {
  const s = state.latest;
  const stream = $("event-stream");
  if (!s) return;

  applyCols();
  renderSortArrows();

  const f = state.filters;
  const rows = (s.recentEvents || []).filter((e) => {
    if (f.event) {
      const q = f.event.toLowerCase();
      const name = String(e.name || "").toLowerCase();
      const pRef = String(e.player_ref || "").toLowerCase();
      const pLabel = String(playerLabel(e.player_ref) || "").toLowerCase();
      const sId = String(e.server_id || "").toLowerCase();
      const sLabel = String(serverLabel(e.server_id) || "").toLowerCase();
      const props = JSON.stringify(e.properties || {}).toLowerCase();
      const inAny = name.includes(q) || pRef.includes(q) || pLabel.includes(q) || sId.includes(q) || sLabel.includes(q) || props.includes(q);
      if (!inAny) return false;
    }
    if (f.player && e.player_ref !== f.player) return false;
    if (f.server && e.server_id !== f.server) return false;
    return true;
  });

  // sort by the active column
  const dir = state.sort.dir === "asc" ? 1 : -1;
  const keyFn = {
    time: (e) => e.server_ts,
    server: (e) => serverLabel(e.server_id).toLowerCase(),
    event: (e) => e.name.toLowerCase(),
  }[state.sort.key];
  rows.sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (ka < kb) return -1 * dir;
    if (ka > kb) return 1 * dir;
    return 0;
  });

  const total = (s.recentEvents || []).length;
  $("filter-count").textContent =
    rows.length === total ? `${total} events` : `${rows.length} of ${total}`;

  if (rows.length === 0) {
    stream.innerHTML =
      total === 0
        ? `<div class="stream-empty">Waiting for events… fire Telemetry.Track from a playtest.</div>`
        : `<div class="stream-empty">No events match these filters.</div>`;
    return;
  }

  stream.innerHTML = rows
    .map((e) => {
      const t = new Date(e.server_ts).toLocaleTimeString();
      const data = e.properties ? JSON.stringify(e.properties) : "—";
      const fbText = e.properties && (e.properties.content || e.properties.feedback || e.properties.msg)
        ? String(e.properties.content || e.properties.feedback || e.properties.msg)
        : (e.name === "feedback_submitted" ? data : "—");
      const color = playerColor(e.player_ref);
      return `<div class="et-row">
        <span class="et-cell col-time">${t}</span>
        <span class="et-cell col-player"><span class="badge player" style="color:${color};border-color:${color}44" title="Player ${escapeHtml(
        e.player_ref || "anon"
      )}">${escapeHtml(playerLabel(e.player_ref))}</span></span>
        <span class="et-cell col-server mono" title="${escapeHtml(e.server_id)}">${escapeHtml(serverLabel(e.server_id))}</span>
        <span class="et-cell col-event">${escapeHtml(e.name)}</span>
        <span class="et-cell col-data mono" title="${escapeHtml(data)}">${escapeHtml(data)}</span>
        <span class="et-cell col-feedback" title="${escapeHtml(fbText)}">${escapeHtml(fbText)}</span>
      </div>`;
    })
    .join("");
}

// ---------- overall: events-over-time chart ----------
const isoDate = (t) => new Date(t).toISOString().slice(0, 10); // UTC YYYY-MM-DD
function fmtChart(t, unit, long) {
  const d = new Date(t);
  if (unit === "day")
    return d.toLocaleDateString([], {
      weekday: long ? "short" : undefined,
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderChart(series, opts = {}) {
  const host = $(opts.hostId || "events-chart");
  if (!host) return;
  const hint = $(opts.hintId || "chart-hint");
  const resetBtn = $(opts.resetId || "chart-reset");
  const gradId = opts.gradId || "areaGrad";
  const buckets = (series && series.buckets) || [];
  const zoomed = !!(state.filters.from || state.filters.to);

  // The dashboard polls every 3s. Rebuilding the SVG (and rebinding listeners)
  // on every tick is what made scrolling stutter, so skip the redraw when the
  // data and zoom state are unchanged.
  const sig = JSON.stringify([series && series.unit, buckets.map((b) => [b.t, b.count]), zoomed]);
  if (host._chartSig === sig) return;
  host._chartSig = sig;

  resetBtn.classList.toggle("hidden", !zoomed);

  // tear down the previous chart's window-level drag listener before redrawing
  if (host._chartCleanup) host._chartCleanup();

  if (buckets.length === 0) {
    host.innerHTML = `<div class="stream-empty">No events in this range yet.</div>`;
    hint.textContent = "";
    return;
  }

  const unit = series.unit || "time";
  const W = 860, H = 220, padL = 38, padR = 16, padT = 16, padB = 30;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = buckets.length;
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));

  const x = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (c) => padT + innerH - (c / maxCount) * innerH;

  const linePts = buckets.map((b, i) => `${x(i)},${y(b.count)}`).join(" ");
  const areaPts = `${x(0)},${padT + innerH} ${linePts} ${x(n - 1)},${padT + innerH}`;

  const yTicks = [...new Set([0, Math.round(maxCount / 2), maxCount])];
  const grid = yTicks
    .map(
      (v) =>
        `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}" class="grid" />` +
        `<text x="${padL - 8}" y="${y(v) + 3}" class="ytick">${v}</text>`
    )
    .join("");

  // up to ~7 evenly spaced dated x-axis ticks
  const maxTicks = Math.min(7, n);
  const step = maxTicks <= 1 ? 0 : (n - 1) / (maxTicks - 1);
  const tickIdx = [...new Set(Array.from({ length: maxTicks }, (_, k) => Math.round(k * step)))];
  const xticks = tickIdx
    .map((i) => {
      const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
      return `<text x="${x(i)}" y="${H - 8}" class="xtick" text-anchor="${anchor}">${escapeHtml(fmtChart(buckets[i].t, unit))}</text>`;
    })
    .join("");

  const dots = buckets
    .map((b, i) => `<circle cx="${x(i)}" cy="${y(b.count)}" r="2.6" class="dot" />`)
    .join("");

  host.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="chart-svg" preserveAspectRatio="none" role="img" aria-label="Events over time">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--signal)" stop-opacity="0.35" />
          <stop offset="100%" stop-color="var(--signal)" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${grid}
      <polygon points="${areaPts}" fill="url(#${gradId})" />
      <polyline points="${linePts}" class="chart-line" />
      ${dots}
      <rect class="chart-sel hidden" y="${padT}" height="${innerH}" />
      <line class="chart-cursor hidden" y1="${padT}" y2="${padT + innerH}" />
      <circle class="chart-focus hidden" r="4" />
      <rect class="chart-capture" x="${padL}" y="${padT}" width="${innerW}" height="${innerH}" />
      ${xticks}
    </svg>
    <div class="chart-tip hidden"></div>`;

  const totalEv = buckets.reduce((a, b) => a + b.count, 0);
  hint.textContent = `${totalEv} event${totalEv === 1 ? "" : "s"}`;

  // ---- interactivity: hover tooltip + drag-to-zoom ----
  const svg = host.querySelector("svg");
  const cap = svg.querySelector(".chart-capture");
  const cursor = svg.querySelector(".chart-cursor");
  const focus = svg.querySelector(".chart-focus");
  const sel = svg.querySelector(".chart-sel");
  const tip = host.querySelector(".chart-tip");

  const svgX = (clientX) => {
    const r = svg.getBoundingClientRect();
    return r.width ? ((clientX - r.left) / r.width) * W : padL;
  };
  const idxAt = (clientX) => {
    const sx = Math.max(padL, Math.min(padL + innerW, svgX(clientX)));
    const frac = innerW ? (sx - padL) / innerW : 0;
    return Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));
  };

  function showTip(i) {
    const b = buckets[i];
    cursor.setAttribute("x1", x(i));
    cursor.setAttribute("x2", x(i));
    focus.setAttribute("cx", x(i));
    focus.setAttribute("cy", y(b.count));
    cursor.classList.remove("hidden");
    focus.classList.remove("hidden");
    tip.innerHTML =
      `<span class="tip-count">${b.count} event${b.count === 1 ? "" : "s"}</span>` +
      `<span class="tip-date">${escapeHtml(fmtChart(b.t, unit, true))}</span>`;
    tip.classList.remove("hidden");
    const frac = x(i) / W;
    tip.style.left = frac * 100 + "%";
    tip.classList.toggle("flip", frac > 0.6);
  }
  function hideTip() {
    cursor.classList.add("hidden");
    focus.classList.add("hidden");
    tip.classList.add("hidden");
  }

  let drag = null; // { clientX, i }
  cap.addEventListener("mousemove", (e) => {
    showTip(idxAt(e.clientX));
    if (drag) {
      const a = Math.max(padL, Math.min(svgX(drag.clientX), svgX(e.clientX)));
      const b = Math.min(padL + innerW, Math.max(svgX(drag.clientX), svgX(e.clientX)));
      sel.setAttribute("x", a);
      sel.setAttribute("width", Math.max(0, b - a));
      sel.classList.remove("hidden");
    }
  });
  cap.addEventListener("mouseleave", () => {
    if (!drag) hideTip();
  });
  cap.addEventListener("mousedown", (e) => {
    drag = { clientX: e.clientX, i: idxAt(e.clientX) };
    e.preventDefault();
  });

  function onUp(e) {
    if (!drag) return;
    const lo = Math.min(drag.i, idxAt(e.clientX));
    const hi = Math.max(drag.i, idxAt(e.clientX));
    const isClick = hi === lo;
    drag = null;
    sel.classList.add("hidden");
    if (isClick) {
      const dStr = isoDate(buckets[lo].t);
      state.filters.from = dStr;
      state.filters.to = dStr;
      if ($("filter-from")) $("filter-from").value = dStr;
      if ($("filter-to")) $("filter-to").value = dStr;
      if ($("sess-filter-from")) $("sess-filter-from").value = dStr;
      if ($("sess-filter-to")) $("sess-filter-to").value = dStr;
      switchTab("events");
      refreshStats();
      return;
    }
    const from = isoDate(buckets[lo].t);
    const to = isoDate(buckets[hi].t);
    state.filters.from = from;
    state.filters.to = to;
    if ($("filter-from")) $("filter-from").value = from;
    if ($("filter-to")) $("filter-to").value = to;
    if ($("sess-filter-from")) $("sess-filter-from").value = from;
    if ($("sess-filter-to")) $("sess-filter-to").value = to;
    refreshStats();
  }
  window.addEventListener("mouseup", onUp);
  host._chartCleanup = () => window.removeEventListener("mouseup", onUp);
}

// ---------- sessions: replay, struggle detection, drop-off ----------
const EVENT_KIND = {
  player_died: "bad",
  level_completed: "good",
  boss_encountered: "warn",
  session_started: "start",
  shop_opened: "info",
  item_picked_up: "info",
};
const eventKind = (name) => EVENT_KIND[name] || "neutral";

const OUTCOME = {
  completed: { label: "Completed", cls: "good" },
  ragequit: { label: "Rage-quit", cls: "bad" },
  left: { label: "Left", cls: "neutral" },
  active: { label: "Active", cls: "warn" },
};

const fmtDayTime = (t) =>
  new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtClock = (t) => new Date(t).toLocaleTimeString();
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

async function loadSessions() {
  const game = currentGame();
  if (!game) return;
  try {
    const params = new URLSearchParams();
    if (state.filters.from) params.set("from", state.filters.from);
    if (state.filters.to) params.set("to", state.filters.to);
    if (state.filters.server) params.set("server", state.filters.server);
    if (state.filters.version) params.set("version", state.filters.version);
    if (state.filters.player) params.set("player", state.filters.player);
    const suffix = params.size ? `?${params}` : "";
    state.sessions = await api(`/api/games/${game.id}/sessions${suffix}`);
  } catch {
    return; // transient; next tick retries
  }
  renderSessions();
}

function syncCustomSelect(selectEl) {
  if (!selectEl) return;
  let wrap = selectEl.previousElementSibling;
  if (!wrap || !wrap.classList.contains("c-select-wrap")) {
    wrap = document.createElement("div");
    wrap.className = "c-select-wrap";
    selectEl.classList.add("hidden");
    selectEl.parentNode.insertBefore(wrap, selectEl);
  }

  if (wrap.classList.contains("open")) return;

  const selectedOpt = selectEl.options[selectEl.selectedIndex] || selectEl.options[0];
  const label = selectedOpt ? selectedOpt.textContent : "";

  wrap.innerHTML = `
    <button class="c-select-trigger" type="button">
      <span class="c-select-label">${escapeHtml(label)}</span>
      <span class="c-select-arrow">▼</span>
    </button>
    <div class="c-select-menu hidden">
      ${Array.from(selectEl.options)
        .map(
          (opt) => `<div class="c-select-option ${opt.value === selectEl.value ? "selected" : ""}" data-value="${escapeHtml(opt.value)}">${escapeHtml(opt.textContent)}</div>`
        )
        .join("")}
    </div>
  `;

  const trig = wrap.querySelector(".c-select-trigger");
  const menu = wrap.querySelector(".c-select-menu");

  trig.onclick = (e) => {
    e.stopPropagation();
    document.querySelectorAll(".c-select-wrap.open").forEach((w) => {
      if (w !== wrap) {
        w.classList.remove("open");
        w.querySelector(".c-select-menu")?.classList.add("hidden");
      }
    });
    const isOpen = wrap.classList.toggle("open");
    menu.classList.toggle("hidden", !isOpen);
  };

  menu.onclick = (e) => {
    const item = e.target.closest(".c-select-option");
    if (!item) return;
    selectEl.value = item.dataset.value;
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));
    wrap.classList.remove("open");
    menu.classList.add("hidden");
    syncCustomSelect(selectEl);
  };
}

document.addEventListener("click", () => {
  document.querySelectorAll(".c-select-wrap.open").forEach((w) => {
    w.classList.remove("open");
    w.querySelector(".c-select-menu")?.classList.add("hidden");
  });
});

function syncSessionFilterOptions(data) {
  const pSel = $("sess-filter-player");
  const sSel = $("sess-filter-server");
  const vSel = $("sess-filter-version");

  const players = data.players || [];
  const servers = data.servers || [];
  const versions = data.versions || [];
  const total = data.health?.total || (data.sessions ? data.sessions.length : 0);

  if (pSel) {
    pSel.innerHTML =
      `<option value="">All players (${total})</option>` +
      players
        .map((p) => `<option value="${escapeHtml(p.player_ref)}">${escapeHtml(playerLabel(p.player_ref))} (${p.sessions})</option>`)
        .join("");
    pSel.value = state.filters.player || "";
    syncCustomSelect(pSel);
  }

  if (sSel) {
    sSel.innerHTML =
      `<option value="">All servers (${total})</option>` +
      servers
        .map((v) => `<option value="${escapeHtml(v.server_id)}">${escapeHtml(serverLabel(v.server_id))} (${v.sessions})</option>`)
        .join("");
    sSel.value = state.filters.server || "";
    syncCustomSelect(sSel);
  }

  if (vSel) {
    vSel.innerHTML =
      `<option value="">All versions (${total})</option>` +
      versions
        .map((v) => `<option value="${escapeHtml(v.version)}">v${escapeHtml(v.version)} (${v.sessions})</option>`)
        .join("");
    vSel.value = state.filters.version || "";
    syncCustomSelect(vSel);
  }
}

function renderSessions() {
  const data = state.sessions;
  if (!data) return;

  syncSessionFilterOptions(data);

  // The dashboard polls every 3s. Re-rendering the list on every tick would
  // reset its scroll position and drop hover state, so only redraw when the
  // data actually changed (a live playtest firing events, or a date zoom).
  const sig = JSON.stringify([
    data.health,
    data.dropoff,
    state.filters.server,
    state.filters.version,
    data.sessions.map((s) => [s.id, s.score, s.events.length, s.feedback.length, s.outcome]),
  ]);
  if (sig === state._sessSig) return;
  state._sessSig = sig;

  renderDropoff(data.dropoff);
  renderHealth(data.health);
  renderSessionList(data.sessions);

  const sel = data.sessions.find((s) => s.id === state.selectedSession);
  if (state.selectedSession && !sel) {
    // the open session fell out of the current range (e.g. after a zoom)
    state.selectedSession = null;
    $("session-detail").innerHTML = `<div class="stream-empty">Select a session on the left to replay it.</div>`;
  } else if (sel) {
    renderSessionDetail(sel); // keep an open replay in sync with fresh data
  }
}

function renderDropoff(dropoff) {
  const host = $("dropoff-bars");
  if (!dropoff || dropoff.length === 0) {
    host.innerHTML = `<li class="stream-empty">No sessions in this range yet.</li>`;
    return;
  }
  const max = Math.max(1, ...dropoff.map((d) => d.n));
  host.innerHTML = dropoff
    .map(
      (d) => `<li>
        <span class="ev-name k-${eventKind(d.name)}">${escapeHtml(d.name)}</span>
        <span class="track"><span class="fill" style="width:${(d.n / max) * 100}%"></span></span>
        <span class="ev-count">${d.n}</span>
      </li>`
    )
    .join("");
}

function renderHealth(h) {
  $("sess-health").innerHTML = `
    <div class="hstat"><span class="hnum">${h.total}</span><span class="hlbl">Sessions</span></div>
    <div class="hstat"><span class="hnum ${h.struggling ? "bad" : ""}">${h.struggling}</span><span class="hlbl">Struggling</span></div>
    <div class="hstat"><span class="hnum ${h.completionRate >= 50 ? "good" : "warn"}">${h.completionRate}%</span><span class="hlbl">Completed</span></div>`;
}

function renderSessionList(sessions) {
  const host = $("session-list");
  const q = (state.filters.search || "").trim().toLowerCase();

  const match = (s) => {
    if (state.sessFilter === "struggling" && !s.struggling) return false;
    if (state.sessFilter === "completed" && !s.completed) return false;
    if (state.sessFilter === "feedback" && s.feedback.length === 0) return false;

    if (q) {
      const pRef = (s.player_ref || "").toLowerCase();
      const pLabel = (playerLabel(s.player_ref) || "").toLowerCase();
      const sId = (s.server_id || "").toLowerCase();
      const sLabel = (serverLabel(s.server_id) || "").toLowerCase();
      const sessId = (s.id || "").toLowerCase();
      const region = (s.region || "").toLowerCase();
      const flags = (s.flags || []).join(" ").toLowerCase();
      const fbText = (s.feedback || []).map((f) => f.content).join(" ").toLowerCase();

      const inAny =
        pRef.includes(q) ||
        pLabel.includes(q) ||
        sId.includes(q) ||
        sLabel.includes(q) ||
        sessId.includes(q) ||
        region.includes(q) ||
        flags.includes(q) ||
        fbText.includes(q);

      if (!inAny) return false;
    }
    return true;
  };

  const filtered = sessions.filter(match);
  const total = state.sessions?.health?.total || sessions.length;
  $("sess-count").textContent =
    filtered.length === total ? `${total}` : `${filtered.length} of ${total}`;

  if (filtered.length === 0) {
    const empty =
      sessions.length === 0
        ? "No sessions in this range yet."
        : {
            struggling: "No struggling sessions — nice.",
            completed: "No completed sessions in this range.",
            feedback: "No sessions with feedback in this range.",
          }[state.sessFilter] || "No sessions match.";
    host.innerHTML = `<div class="stream-empty">${empty}</div>`;
    return;
  }

  host.innerHTML = filtered
    .map((s) => {
      const color = playerColor(s.player_ref);
      const oc = OUTCOME[s.outcome] || OUTCOME.left;
      const active = s.id === state.selectedSession ? " active" : "";
      const flagText = s.flags.length ? s.flags[0] : s.completed ? "Completed" : "No issues";
      return `<button class="sess-row${active}${s.struggling ? " is-struggling" : ""}" data-id="${escapeHtml(s.id)}" type="button">
        <span class="sess-row-head">
          <span class="badge player" style="color:${color};border-color:${color}44">${escapeHtml(playerLabel(s.player_ref))}</span>
          <span class="outcome-pill ${oc.cls}">${oc.label}</span>
        </span>
        <span class="sess-row-flag">${escapeHtml(flagText)}</span>
        <span class="sess-row-meta">${escapeHtml(fmtDayTime(s.started_at))} · ${escapeHtml(fmtDuration(s.duration))} · ${s.events.length} events${
        s.feedback.length ? ' · <span class="fb-dot">💬</span>' : ""
      }</span>
      </button>`;
    })
    .join("");

  host.querySelectorAll(".sess-row").forEach((row) =>
    row.addEventListener("click", () => selectSession(row.dataset.id))
  );
}

function selectSession(id) {
  state.selectedSession = id;
  document.querySelectorAll(".sess-row").forEach((r) => r.classList.toggle("active", r.dataset.id === id));
  const s = (state.sessions?.sessions || []).find((x) => x.id === id);
  renderSessionDetail(s);
}

function renderSessionDetail(s) {
  const host = $("session-detail");
  if (!s) {
    host.innerHTML = `<div class="stream-empty">Select a session on the left to replay it.</div>`;
    return;
  }
  const color = playerColor(s.player_ref);
  const oc = OUTCOME[s.outcome] || OUTCOME.left;

  const evs = s.events;
  const first = evs.length ? evs[0].ts : s.started_at;
  const last = evs.length ? evs[evs.length - 1].ts : s.started_at;
  const span = Math.max(0, last - first);
  // position along the track: by real time when the session spans time, else
  // spread evenly by index (demo/legacy data where all events share a stamp).
  const pos = (ts, i, n) => (span > 0 ? ((ts - first) / span) * 100 : n <= 1 ? 50 : (i / (n - 1)) * 100);

  const dots = evs
    .map(
      (e, i) =>
        `<button class="replay-dot k-${eventKind(e.name)}" style="left:${pos(e.ts, i, evs.length)}%" data-i="${i}" type="button" aria-label="${escapeHtml(
          e.name
        )}"></button>`
    )
    .join("");

  const fbMarks = s.feedback
    .map((f) => {
      const clamped = Math.min(Math.max(f.ts, first), last);
      return `<span class="replay-fb" style="left:${pos(clamped, 0, 1)}%" title="${escapeHtml(f.content)}">💬</span>`;
    })
    .join("");

  const flags = s.flags.length
    ? `<div class="detail-flags">${s.flags.map((f) => `<span class="flag-chip">${escapeHtml(f)}</span>`).join("")}</div>`
    : "";

  const fb = s.feedback.length
    ? `<div class="detail-fb">${s.feedback
        .map((f) => `<div class="fb-quote">💬 “${escapeHtml(f.content)}”</div>`)
        .join("")}</div>`
    : "";

  // The list can be sorted ascending/descending by time; keep each row's
  // original chronological index in data-i so hover still maps to the right dot.
  const ordered = evs.map((e, i) => ({ e, i }));
  if (state.replaySort === "desc") ordered.reverse();
  const list = ordered
    .map(({ e, i }) => {
      const data = e.properties ? JSON.stringify(e.properties) : "";
      let fbText = e.properties && (e.properties.content || e.properties.feedback || e.properties.msg)
        ? String(e.properties.content || e.properties.feedback || e.properties.msg)
        : (e.name === "feedback_submitted" ? data : "");
      if (!fbText && s.feedback && s.feedback.length > 0) {
        const match = s.feedback.find(
          (f) => Math.abs(f.ts - e.ts) < 5000 || (i === evs.length - 1 && Math.abs(f.ts - e.ts) < 60000)
        );
        if (match) fbText = match.content;
      }
      return `<div class="replay-ev k-${eventKind(e.name)}" data-i="${i}">
        <span class="re-time">${escapeHtml(fmtClock(e.ts))}</span>
        <span class="re-dot"></span>
        <span class="re-name">${escapeHtml(e.name)}</span>
        <span class="re-data mono" title="${escapeHtml(data)}">${escapeHtml(data)}</span>
        <span class="re-feedback" title="${escapeHtml(fbText)}">${escapeHtml(fbText)}</span>
      </div>`;
    })
    .join("");
  const sortArrow = state.replaySort === "asc" ? "↑" : "↓";

  host.innerHTML = `
    <div class="detail-head">
      <span class="badge player big" style="color:${color};border-color:${color}44">${escapeHtml(playerLabel(s.player_ref))}</span>
      <div class="detail-meta">
        <span class="outcome-pill ${oc.cls}">${oc.label}</span>
        ${s.region ? `<span class="dm region">🌎 ${escapeHtml(s.region)}</span>` : ""}
        <span class="dm" title="Server instance JobId">${escapeHtml(serverLabel(s.server_id))}</span>
        <span class="dm">${escapeHtml(fmtDayTime(s.started_at))}</span>
        <span class="dm">${escapeHtml(fmtDuration(s.duration))}</span>
        <span class="dm">${s.deaths} death${s.deaths === 1 ? "" : "s"}</span>
      </div>
    </div>
    ${flags}
    ${fb}
    <div class="replay">
      <div class="replay-track">
        <div class="replay-line"></div>
        ${dots}
        ${fbMarks}
      </div>
      <div class="replay-axis"><span>${escapeHtml(fmtClock(first))}</span><span>${escapeHtml(fmtClock(last))}</span></div>
    </div>
    <div class="replay-list">
      <div class="replay-list-head">
        <button class="rl-sort" id="replay-time-sort" type="button">Time <span class="sort-arrow">${sortArrow}</span></button>
        <span></span>
        <span>Event</span>
        <span>Data</span>
        <span>Feedback</span>
      </div>
      ${list}
    </div>
    <div class="replay-tip hidden"></div>`;

  const sortBtn = host.querySelector("#replay-time-sort");
  if (sortBtn)
    sortBtn.addEventListener("click", () => {
      state.replaySort = state.replaySort === "asc" ? "desc" : "asc";
      renderSessionDetail(s);
    });

  wireReplayHover(host, s);
}

// Link the timeline dots and the ordered event list: hovering either highlights
// both and shows a tooltip with the exact event, time, and properties.
function wireReplayHover(host, s) {
  const tip = host.querySelector(".replay-tip");
  const track = host.querySelector(".replay-track");
  const dots = [...host.querySelectorAll(".replay-dot")]; // chronological order
  const rows = [...host.querySelectorAll(".replay-ev")]; // may be reversed
  const rowByIdx = new Map(rows.map((r) => [+r.dataset.i, r]));

  const show = (i) => {
    const e = s.events[i];
    const dot = dots[i];
    if (!e || !dot) return;
    const data = e.properties ? JSON.stringify(e.properties) : "";
    tip.innerHTML =
      `<span class="tip-name k-${eventKind(e.name)}">${escapeHtml(e.name)}</span>` +
      `<span class="tip-date">${escapeHtml(fmtClock(e.ts))}</span>` +
      (data ? `<span class="tip-data mono">${escapeHtml(data)}</span>` : "");
    const hostRect = host.getBoundingClientRect();
    const trackRect = track.getBoundingClientRect();
    const dotRect = dot.getBoundingClientRect();
    const cx = dotRect.left - hostRect.left + dotRect.width / 2;
    tip.style.left = cx + "px";
    tip.style.top = trackRect.top - hostRect.top + "px";
    tip.classList.toggle("flip", cx > hostRect.width * 0.6);
    tip.classList.remove("hidden");
    dot.classList.add("hot");
    rowByIdx.get(i)?.classList.add("hot");
  };
  const hide = (i) => {
    tip.classList.add("hidden");
    dots[i]?.classList.remove("hot");
    rowByIdx.get(i)?.classList.remove("hot");
  };

  dots.forEach((d, i) => {
    d.addEventListener("mouseenter", () => show(i));
    d.addEventListener("mouseleave", () => hide(i));
    d.addEventListener("focus", () => show(i));
    d.addEventListener("blur", () => hide(i));
  });
  rows.forEach((r) => {
    const i = +r.dataset.i;
    r.addEventListener("mouseenter", () => show(i));
    r.addEventListener("mouseleave", () => hide(i));
  });
}

// ---------- connection panel ----------
function renderKeyPanel() {
  const game = currentGame();
  if (!game) return;
  $("endpoint").textContent = window.location.origin;
  $("api-key").textContent = game.api_key;
  applyKeyBlur();
}

function applyKeyBlur() {
  $("api-key").classList.toggle("blurred", !state.revealKey);
  $("reveal-key").textContent = state.revealKey ? "Hide" : "Reveal";
}

$("reveal-key").addEventListener("click", () => {
  state.revealKey = !state.revealKey;
  applyKeyBlur();
});

$("copy-key").addEventListener("click", async () => {
  const game = currentGame();
  if (!game) return;
  await navigator.clipboard.writeText(game.api_key);
  $("copy-key").textContent = "Copied";
  setTimeout(() => ($("copy-key").textContent = "Copy"), 1500);
});

$("rotate-key").addEventListener("click", async () => {
  const game = currentGame();
  if (!game) return;
  const ok = await confirmModal(
    "Rotate API key?",
    "Games using the old key will stop reporting until you paste the new one in.",
    "Rotate key"
  );
  if (!ok) return;
  const { api_key } = await api(`/api/games/${game.id}/rotate-key`, { method: "POST" });
  game.api_key = api_key;
  renderKeyPanel();
});

// ---------- feedback ----------
state.customTags = [];

function renderCustomTags() {
  const host = $("fb-tag-list");
  if (!host) return;
  host.innerHTML = state.customTags
    .map(
      (tag) => `<span class="fb-tag-pill">
        <span class="remove-tag" data-tag="${escapeHtml(tag)}">×</span>
        <span class="tag-label">${escapeHtml(tag)}</span>
      </span>`
    )
    .join("");
}

function addCustomTag(raw) {
  const clean = String(raw).replace(/[^a-zA-Z0-9\s_-]/g, "").trim();
  if (clean && !state.customTags.includes(clean)) {
    state.customTags.push(clean);
    renderCustomTags();
    runSummary();
  }
}

function removeCustomTag(tag) {
  state.customTags = state.customTags.filter((t) => t !== tag);
  renderCustomTags();
  runSummary();
}

async function runSummary() {
  const game = currentGame();
  if (!game) return;
  const out = $("summary-out");
  const typed = ($("fb-keywords")?.value || "").trim();
  if (typed) {
    addCustomTag(typed);
    if ($("fb-keywords")) $("fb-keywords").value = "";
    return;
  }
  const keywords = state.customTags.join(",");
  $("summarize-btn").disabled = true;
  $("summarize-btn").textContent = "Analyzing…";
  out.innerHTML = `<p class="muted">Crunching feedback…</p>`;
  try {
    const r = await api(`/api/games/${game.id}/summarize`, {
      method: "POST",
      body: { keywords },
    });
    state.summarizedGameId = game.id;
    renderSummary(r);
  } catch (e) {
    out.innerHTML = `<p class="error">${escapeHtml(e.message)}</p>`;
  } finally {
    $("summarize-btn").disabled = false;
    $("summarize-btn").textContent = "Summarize feedback";
  }
}

$("summarize-btn").addEventListener("click", runSummary);

if ($("fb-keywords")) {
  $("fb-keywords").addEventListener("input", (e) => {
    if (e.target.value.includes(",")) {
      const parts = e.target.value.split(",");
      const last = parts.pop();
      for (const p of parts) addCustomTag(p);
      e.target.value = last;
    }
  });
  $("fb-keywords").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addCustomTag(e.target.value);
      e.target.value = "";
    }
  });
}

if ($("fb-tag-list")) {
  $("fb-tag-list").addEventListener("click", (e) => {
    const rm = e.target.closest(".remove-tag");
    if (rm) {
      removeCustomTag(rm.dataset.tag);
    }
  });
}

function renderSummary(r) {
  const out = $("summary-out");
  if (!r.themes || r.themes.length === 0) {
    out.innerHTML = `<p class="muted">${escapeHtml(r.note || "No themes found yet.")}</p>`;
    return;
  }
  out.innerHTML =
    r.themes
      .map(
        (t) => `<div class="theme">
          <div class="theme-head">
            <span class="theme-title">${escapeHtml(t.title)}</span>
            <span class="sev ${t.severity}">${t.severity}</span>
            <span class="theme-count">×${t.count}</span>
          </div>
          <div class="theme-quote">“${escapeHtml(t.quote || "")}”</div>
        </div>`
      )
      .join("") + (r.note ? `<p class="summary-note">${escapeHtml(r.note)}</p>` : "");
}

function initFeedbackTooltip() {
  let tip = $("fb-bubble-tooltip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "fb-bubble-tooltip";
    tip.className = "fb-bubble-tooltip";
    document.body.appendChild(tip);
  }

  document.addEventListener("mouseover", (e) => {
    const target = e.target.closest(".re-feedback, .replay-fb, .fb-quote, .fb-dot");
    if (!target) return;
    const text = target.getAttribute("title") || target.dataset.feedback || target.textContent;
    if (!text || text === "—") return;
    const cleanText = text.replace(/^💬\s*“?|”?$/g, "").trim();
    if (!cleanText) return;

    tip.innerHTML = `<div class="fb-tip-quote">💬 “${escapeHtml(cleanText)}”</div>`;
    const rect = target.getBoundingClientRect();
    tip.style.left = `${rect.left + rect.width / 2}px`;
    tip.style.top = `${rect.top - 8}px`;
    tip.classList.add("visible");
  });

  document.addEventListener("mouseout", (e) => {
    const target = e.target.closest(".re-feedback, .replay-fb, .fb-quote, .fb-dot");
    if (target && tip) {
      tip.classList.remove("visible");
    }
  });
}

// ---------- funnels ----------
const DEMO_FUNNEL = {
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
  range: {
    from: "2026-08-01",
    to: new Date().toISOString().slice(0, 10),
  }
};

async function loadFunnels() {
  const game = currentGame();
  if (!game) {
    renderFunnels(DEMO_FUNNEL);
    return;
  }
  try {
    let url = `/api/games/${game.id}/funnels`;
    const params = new URLSearchParams();
    if (state.funnelFilters.from) params.append("from", state.funnelFilters.from);
    if (state.funnelFilters.to) params.append("to", state.funnelFilters.to);
    const query = params.toString();
    if (query) url += `?${query}`;

    const data = await api(url);
    renderFunnels(data || DEMO_FUNNEL);
  } catch {
    renderFunnels(DEMO_FUNNEL);
  }
}

function renderFunnels(data) {
  const cohortEl = $("funnel-cohort");
  const svg = $("funnel-svg");
  const labelsHost = $("funnel-stage-labels");
  const cardsHost = $("funnel-cards-grid");
  const canvas = $("funnel-canvas");
  const chartWrap = $("funnel-chart-container");
  if (!data || !data.steps || data.steps.length === 0) return;

  if (data.range) {
    if ($("funnel-filter-from")) $("funnel-filter-from").value = data.range.from || "";
    if ($("funnel-filter-to")) $("funnel-filter-to").value = data.range.to || "";
  }

  const steps = data.steps;
  const cohort = data.totalCohort || (steps.length ? steps[0].count : 1);
  if (cohortEl) cohortEl.textContent = `Cohort: ${cohort} players`;

  const numSteps = steps.length;
  const isScrollable = numSteps > 7;
  const stepWidth = isScrollable ? 160 : 1000 / numSteps;
  const totalWidth = numSteps * stepWidth;
  const height = 240;

  if (chartWrap) {
    chartWrap.style.width = "100%";
    chartWrap.style.minWidth = "0px";
  }
  if (canvas) {
    canvas.style.width = isScrollable ? `${totalWidth}px` : "100%";
    canvas.style.minWidth = isScrollable ? `${totalWidth}px` : "100%";
  }

  let svgPaths = `
    <defs>
      <linearGradient id="funnel-grad-primary" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#2d8a4e" stop-opacity="0.95" />
        <stop offset="100%" stop-color="#4ade80" stop-opacity="0.75" />
      </linearGradient>
      <linearGradient id="funnel-grad-subsequent" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#4ade80" stop-opacity="0.55" />
        <stop offset="100%" stop-color="#86efac" stop-opacity="0.25" />
      </linearGradient>
    </defs>
  `;

  steps.forEach((s, i) => {
    const nextS = steps[i + 1];
    const leftX = i * stepWidth;
    const rightX = (i + 1) * stepWidth;

    const leftRatio = Math.max(0.02, s.count / cohort);
    const rightRatio = nextS ? Math.max(0.02, nextS.count / cohort) : leftRatio;

    const leftH = height * leftRatio;
    const rightH = height * rightRatio;

    const leftTop = (height - leftH) / 2;
    const leftBot = leftTop + leftH;
    const rightTop = (height - rightH) / 2;
    const rightBot = rightTop + rightH;

    const points = `${leftX},${leftTop} ${rightX},${rightTop} ${rightX},${rightBot} ${leftX},${leftBot}`;
    const fill = i === 0 ? "url(#funnel-grad-primary)" : "url(#funnel-grad-subsequent)";

    const fbTipText = `${s.name}: ${s.count} (${s.pctTotal}% of cohort) · ${s.pctPrevious}% from previous step`;
    svgPaths += `<polygon class="funnel-polygon" points="${points}" fill="${fill}" data-feedback="${escapeHtml(fbTipText)}" />`;

    if (i < numSteps - 1) {
      svgPaths += `<line x1="${rightX}" y1="0" x2="${rightX}" y2="${height}" stroke="rgba(255,255,255,0.14)" stroke-width="1.5" stroke-dasharray="3" />`;
    }
  });

  svgPaths += `<text x="24" y="${height / 2}" dominant-baseline="central" text-anchor="start" font-family="Inter, system-ui, sans-serif" font-size="54" font-weight="900" fill="#ffffff" style="filter: drop-shadow(0 4px 12px rgba(0,0,0,0.95)); pointer-events: none;">${cohort}</text>`;

  if (svg) {
    svg.setAttribute("viewBox", `0 0 ${totalWidth} ${height}`);
    svg.style.width = `${totalWidth}px`;
    svg.innerHTML = svgPaths;
  }

  if (labelsHost) {
    labelsHost.style.width = `${totalWidth}px`;
    labelsHost.innerHTML = steps
      .map(
        (s, i) => `<div class="funnel-stage-col ${i === 0 ? "is-first" : ""}" style="width: ${stepWidth}px;">
          <div class="funnel-stage-top">
            <span class="funnel-stage-name">${escapeHtml(s.name)}</span>
          </div>
          <div class="funnel-stage-bot">
            ${i === 0 ? "" : `<span class="funnel-stage-pct">${s.pctPrevious}%</span><span class="funnel-stage-count">${s.count}</span>`}
          </div>
        </div>`
      )
      .join("");
  }

  if (cardsHost) {
    cardsHost.innerHTML = steps
      .map(
        (s) => `<div class="funnel-step-card">
          <span class="funnel-step-num">Step ${s.step}</span>
          <span class="funnel-step-title">${escapeHtml(s.name)}</span>
          <span class="funnel-step-desc">${escapeHtml(s.desc || "Tracked funnel event progression.")}</span>
          <div class="funnel-step-stats">
            <span class="funnel-step-count">${s.count}</span>
            <span class="funnel-step-rate">${s.pctTotal}% total</span>
          </div>
        </div>`
      )
      .join("");
  }
}

function startDashboard() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  initFeedbackTooltip();
  renderKeyPanel();
  refreshStats();
  loadFunnels();
  // Auto-crunch feedback the moment a game opens (and on hot reload), so the
  // summary is populated without waiting for a click. Button still re-runs it.
  const game = currentGame();
  if (game && state.summarizedGameId !== game.id) runSummary();
  state.pollTimer = setInterval(refreshStats, 3000); // live feel without websockets
}

// ---------- modals ----------
const backdrop = $("modal-backdrop");
const modalEl = $("modal");

function closeModal() {
  backdrop.classList.add("hidden");
  modalEl.innerHTML = "";
}
backdrop.addEventListener("click", (e) => {
  if (e.target === backdrop) closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !backdrop.classList.contains("hidden")) closeModal();
});

function promptModal(title, label, placeholder, confirmText, initial = "") {
  return new Promise((resolve) => {
    modalEl.innerHTML = `
      <h3 class="modal-title">${escapeHtml(title)}</h3>
      <label class="field-label">${escapeHtml(label)}</label>
      <input id="modal-input" class="modal-input" placeholder="${escapeHtml(placeholder)}" />
      <div class="modal-actions">
        <button class="btn ghost" id="modal-cancel">Cancel</button>
        <button class="btn primary" id="modal-ok">${escapeHtml(confirmText)}</button>
      </div>`;
    backdrop.classList.remove("hidden");
    const input = $("modal-input");
    input.value = initial;
    input.focus();
    input.select();
    const done = (val) => {
      closeModal();
      resolve(val);
    };
    $("modal-ok").addEventListener("click", () => done(input.value));
    $("modal-cancel").addEventListener("click", () => done(null));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(input.value);
    });
  });
}

function confirmModal(title, message, confirmText, danger = false) {
  return new Promise((resolve) => {
    modalEl.innerHTML = `
      <h3 class="modal-title">${escapeHtml(title)}</h3>
      <p class="modal-msg">${escapeHtml(message)}</p>
      <div class="modal-actions">
        <button class="btn ghost" id="modal-cancel">Cancel</button>
        <button class="btn ${danger ? "danger" : "primary"}" id="modal-ok">${escapeHtml(confirmText)}</button>
      </div>`;
    backdrop.classList.remove("hidden");
    $("modal-ok").focus();
    const done = (val) => {
      closeModal();
      resolve(val);
    };
    $("modal-ok").addEventListener("click", () => done(true));
    $("modal-cancel").addEventListener("click", () => done(false));
  });
}

async function openRenameModal(game) {
  closeDropdown();
  const name = await promptModal("Rename game", "Game name", "Game name", "Save", game.name);
  if (name && name.trim() && name.trim() !== game.name) {
    try {
      await renameGame(game, name.trim());
    } catch (e) {
      await confirmModal("Couldn’t rename", e.message, "OK");
    }
  }
}

// Two-step delete: confirm, then require typing the exact game name.
function openDeleteModal(game) {
  closeDropdown();
  modalEl.innerHTML = `
    <h3 class="modal-title">Delete “${escapeHtml(game.name)}”?</h3>
    <p class="modal-msg">This permanently removes the game and <strong>all</strong> its sessions, events, and feedback. This can’t be undone.</p>
    <label class="field-label">Type <span class="confirm-name">${escapeHtml(game.name)}</span> to confirm</label>
    <input id="modal-input" class="modal-input" placeholder="${escapeHtml(game.name)}" autocomplete="off" />
    <div class="modal-actions">
      <button class="btn ghost" id="modal-cancel">Cancel</button>
      <button class="btn danger" id="modal-ok" disabled>Delete game</button>
    </div>`;
  backdrop.classList.remove("hidden");
  const input = $("modal-input");
  const okBtn = $("modal-ok");
  input.focus();
  const check = () => {
    okBtn.disabled = input.value !== game.name;
  };
  input.addEventListener("input", check);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !okBtn.disabled) okBtn.click();
  });
  $("modal-cancel").addEventListener("click", closeModal);
  okBtn.addEventListener("click", async () => {
    if (input.value !== game.name) return;
    closeModal();
    try {
      await deleteGame(game);
    } catch (e) {
      await confirmModal("Couldn’t delete", e.message, "OK");
    }
  });
}

// ---------- boot ----------
async function enterApp() {
  try {
    await loadGames();
  } catch {
    clearSession();
    show("auth-view");
    return;
  }
  if (state.games.length === 0) {
    show("empty-view");
  } else {
    state.currentGameId = state.games[0].id;
    renderDropdown();
    show("dash-view");
    startDashboard();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

renderAuthMode();
if (query.get("auth_error") === "oauth") {
  $("auth-error").textContent = "Sign-in could not be completed. Please try again.";
  $("auth-error").classList.remove("hidden");
}
if (state.token) enterApp();
else show("auth-view");
