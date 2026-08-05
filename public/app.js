// app.js — Playtest Pulse dashboard client. Vanilla JS, no build step.

const DEFAULT_COLS = { time: true, player: true, server: true, data: true };

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
  filters: { event: "", player: "", server: "", from: "", to: "" },
  sort: { key: "time", dir: "desc" }, // Events table sort (time = newest first)
  cols: loadCols(), // which Events columns are visible (persisted)
  summarizedGameId: null, // game whose feedback we've already auto-crunched this session
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
const TAB_IDS = ["overall", "events", "connection"];
$("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  state.tab = btn.dataset.tab;
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t === btn);
  for (const id of TAB_IDS) $(`tab-${id}`).classList.toggle("hidden", state.tab !== id);
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
[$("filter-from"), $("filter-to")].forEach((el) =>
  el.addEventListener("change", () => {
    state.filters.from = $("filter-from").value;
    state.filters.to = $("filter-to").value;
    refreshStats();
  })
);
$("filter-clear").addEventListener("click", () => {
  state.filters = { event: "", player: "", server: "", from: "", to: "" };
  $("filter-event").value = "";
  $("filter-player").value = "";
  $("filter-server").value = "";
  $("filter-from").value = "";
  $("filter-to").value = "";
  refreshStats();
});

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
  renderChart(s.series);
}

function renderStream() {
  const s = state.latest;
  const stream = $("event-stream");
  if (!s) return;

  applyCols();
  renderSortArrows();

  const f = state.filters;
  const rows = (s.recentEvents || []).filter((e) => {
    if (f.event && !e.name.toLowerCase().includes(f.event)) return false;
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
      const color = playerColor(e.player_ref);
      return `<div class="et-row">
        <span class="et-cell col-time">${t}</span>
        <span class="et-cell col-player"><span class="badge player" style="color:${color};border-color:${color}44" title="Player ${escapeHtml(
        e.player_ref || "anon"
      )}">${escapeHtml(playerLabel(e.player_ref))}</span></span>
        <span class="et-cell col-server mono" title="${escapeHtml(e.server_id)}">${escapeHtml(serverLabel(e.server_id))}</span>
        <span class="et-cell col-event">${escapeHtml(e.name)}</span>
        <span class="et-cell col-data mono" title="${escapeHtml(data)}">${escapeHtml(data)}</span>
      </div>`;
    })
    .join("");
}

// ---------- overall: events-over-time chart ----------
function renderChart(series) {
  const host = $("events-chart");
  const hint = $("chart-hint");
  const buckets = (series && series.buckets) || [];
  if (buckets.length === 0) {
    host.innerHTML = `<div class="stream-empty">No events in this range yet.</div>`;
    hint.textContent = "";
    return;
  }

  const W = 640;
  const H = 180;
  const padL = 34;
  const padR = 10;
  const padT = 12;
  const padB = 22;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const maxCount = Math.max(1, ...buckets.map((b) => b.count));
  const n = buckets.length;
  const x = (i) => padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (c) => padT + innerH - (c / maxCount) * innerH;

  const linePts = buckets.map((b, i) => `${x(i)},${y(b.count)}`).join(" ");
  const areaPts = `${padL},${padT + innerH} ${linePts} ${x(n - 1)},${padT + innerH}`;

  // y gridlines at 0, mid, max
  const yTicks = [0, Math.round(maxCount / 2), maxCount];
  const grid = yTicks
    .map(
      (v) =>
        `<line x1="${padL}" y1="${y(v)}" x2="${W - padR}" y2="${y(v)}" class="grid" />` +
        `<text x="${padL - 6}" y="${y(v) + 3}" class="ytick">${v}</text>`
    )
    .join("");

  const dots = buckets
    .map((b, i) => `<circle cx="${x(i)}" cy="${y(b.count)}" r="2.2" class="dot"><title>${b.count} events</title></circle>`)
    .join("");

  const fmt = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const xStart = fmt(buckets[0].t);
  const xEnd = fmt(buckets[n - 1].t);

  host.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="chart-svg" preserveAspectRatio="none" role="img" aria-label="Events over time">
      <defs>
        <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--signal)" stop-opacity="0.35" />
          <stop offset="100%" stop-color="var(--signal)" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${grid}
      <polygon points="${areaPts}" fill="url(#areaGrad)" />
      <polyline points="${linePts}" class="chart-line" />
      ${dots}
      <text x="${padL}" y="${H - 6}" class="xtick">${escapeHtml(xStart)}</text>
      <text x="${W - padR}" y="${H - 6}" class="xtick end">${escapeHtml(xEnd)}</text>
    </svg>`;
  const totalEv = buckets.reduce((a, b) => a + b.count, 0);
  hint.textContent = `${totalEv} events`;
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
async function runSummary() {
  const game = currentGame();
  if (!game) return;
  const out = $("summary-out");
  $("summarize-btn").disabled = true;
  $("summarize-btn").textContent = "Analyzing…";
  out.innerHTML = `<p class="muted">Crunching feedback…</p>`;
  try {
    const r = await api(`/api/games/${game.id}/summarize`, { method: "POST" });
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

function startDashboard() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  renderKeyPanel();
  refreshStats();
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
