// server.js — Playtest Pulse API + static dashboard host.
//
// Two trust boundaries live here:
//   1. Developer dashboard  -> JWT bearer auth (requireAuth)
//   2. Game telemetry ingest -> per-game API key (checkApiKey)
// They are intentionally separate: a leaked game key can never read another
// dev's dashboard, and a stolen dashboard token can't be used as an SDK key.

import express from "express";
import session from "express-session";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as GitHubStrategy } from "passport-github2";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { users, games, ingest, stats } from "./db.js";
import { hashPassword, verifyPassword, signToken, requireAuth } from "./auth.js";
import { summarizeFeedback } from "./summarize.js";

const DEMO_EMAIL = "demo@playtestpulse.dev";
const DEMO_PASSWORD = "demopassword123";

// Scenario templates give the demo realistic playtests instead of random noise:
// boss rage-quits, clean clears, mid-run deaths, early bail-outs. Each is an
// ordered event list; `ended` marks a session the player left. Feedback, when
// present, is written at the end of the run so it lands next to the moment it
// describes on the session replay timeline.
const DEMO_SCENARIOS = [
  {
    events: ["session_started", "level_started", "boss_encountered", "player_died", "player_died", "player_died", "player_died"],
    ended: true,
    feedback: "The boss on level 3 is too hard; I died eight times.",
  },
  {
    events: ["session_started", "level_started", "item_picked_up", "boss_encountered", "level_completed", "shop_opened"],
    ended: true,
  },
  {
    events: ["session_started", "level_started", "player_died", "item_picked_up", "player_died", "boss_encountered", "level_completed"],
    ended: true,
    feedback: "More checkpoints would make failed runs less frustrating.",
  },
  {
    events: ["session_started", "level_started", "player_died", "player_died"],
    ended: true,
    feedback: "Movement felt laggy in the cave when enemies spawned.",
  },
  {
    events: ["session_started", "level_started", "item_picked_up", "shop_opened", "item_picked_up", "level_completed"],
    ended: true,
  },
  {
    events: ["session_started", "level_started", "item_picked_up", "level_completed", "level_started", "boss_encountered", "level_completed"],
    ended: true,
  },
];

async function ensureDemoWorkspace() {
  let demoUser = users.byEmail(DEMO_EMAIL);
  if (!demoUser) demoUser = users.create(DEMO_EMAIL, await hashPassword(DEMO_PASSWORD));

  let demoGame = games.byUser(demoUser.id).find((game) => game.name === "Dungeon Crawler (Demo)");
  if (!demoGame) demoGame = games.create(demoUser.id, "Dungeon Crawler (Demo)");
  if (stats.overview(demoGame.id).events > 0) return;

  const servers = ["srv-us-east-01", "srv-eu-west-02", "srv-ap-southeast-03"];
  const REGIONS = { "srv-us-east-01": "US East", "srv-eu-west-02": "EU West", "srv-ap-southeast-03": "Asia Pacific" };
  // Spread sessions across the last ~4 weeks so the Overall chart shows a real
  // dated timeline (with quiet days). `daysAgo` places each session's day;
  // `plan` picks its scenario, seeding several rage-quits and clean clears so
  // the Sessions tab has struggle signals and drop-off variety to show.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MIN = 60 * 1000;
  const daysAgo = [27, 27, 25, 22, 22, 20, 18, 15, 15, 13, 10, 7, 7, 4, 1];
  const plan = [0, 3, 1, 2, 4, 0, 5, 1, 3, 2, 4, 0, 5, 2, 1];
  const baseNow = Date.now();
  for (let session = 0; session < daysAgo.length; session++) {
    const scenario = DEMO_SCENARIOS[plan[session]];
    // backdate the batch to its assigned day; server_ts (used by the Overall
    // day chart) is this instant for the whole batch.
    const sessionStart = baseNow - daysAgo[session] * DAY_MS + (session % 6) * 90 * MIN;
    // give each event its own client_ts a little later than the last, so the
    // replay timeline spreads out and rage bursts are measurable.
    let cursor = sessionStart;
    const events = scenario.events.map((name, i) => {
      if (i > 0) cursor += 20 * 1000 + ((session + i) % 4) * 15 * 1000; // 20–65s apart
      return {
        name,
        client_ts: cursor,
        properties: name === "session_started" ? { place_version: 42 } : { level: 1 + ((session + i) % 4) },
      };
    });
    const feedback = scenario.feedback ? [{ content: scenario.feedback, client_ts: cursor }] : [];
    const serverId = servers[session % servers.length];
    ingest(
      demoGame.id,
      {
        session_id: `demo-session-${session + 1}`,
        player_id: 100000 + session,
        server_id: serverId,
        region: REGIONS[serverId],
        events,
        feedback,
        ended: scenario.ended,
      },
      { serverTs: sessionStart }
    );
  }
}

await ensureDemoWorkspace();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const APP_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
const oauthEnabled = (provider) => Boolean(process.env[`${provider}_CLIENT_ID`] && process.env[`${provider}_CLIENT_SECRET`]);
app.set("trust proxy", 1);
app.use(session({
  secret: process.env.OAUTH_SESSION_SECRET || process.env.JWT_SECRET || "dev-only-oauth-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === "production", sameSite: "lax", httpOnly: true, maxAge: 10 * 60 * 1000 },
}));
app.use(passport.initialize());
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function callback(provider) {
  return `${APP_URL}/api/auth/${provider}/callback`;
}

function finishOAuth(provider) {
  return (_req, _accessToken, _refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value;
    if (!email) return done(new Error(`Your ${provider} account does not provide an email address.`));
    return done(null, users.findOrCreateOAuth({ email, provider, providerId: profile.id, displayName: profile.displayName }));
  };
}

if (oauthEnabled("GOOGLE")) {
  passport.use("google", new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: callback("google"),
  }, finishOAuth("google")));
}
if (oauthEnabled("GITHUB")) {
  passport.use("github", new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: callback("github"),
  }, finishOAuth("github")));
}

function startOAuth(provider, scope) {
  return (req, res, next) => {
    if (!oauthEnabled(provider.toUpperCase())) return res.status(503).json({ error: `${provider} sign-in is not configured yet.` });
    return passport.authenticate(provider, { scope, session: false, state: true })(req, res, next);
  };
}
function completeOAuth(provider) {
  return (req, res, next) => passport.authenticate(provider, { session: false, failureRedirect: "/?auth_error=oauth" }, (err, user) => {
    if (err || !user) return res.redirect("/?auth_error=oauth");
    return res.redirect(`/?oauth_token=${encodeURIComponent(signToken(user))}`);
  })(req, res, next);
}

app.get("/api/auth/google", startOAuth("google", ["profile", "email"]));
app.get("/api/auth/google/callback", completeOAuth("google"));
app.get("/api/auth/github", startOAuth("github", ["read:user", "user:email"]));
app.get("/api/auth/github/callback", completeOAuth("github"));

// ---------------------------------------------------------------- auth
app.post("/api/auth/signup", async (req, res) => {
  const { email, password } = req.body || {};
  if (!EMAIL_RE.test(email || ""))
    return res.status(400).json({ error: "Enter a valid email address." });
  if (!password || password.length < 8)
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  if (users.byEmail(email))
    return res.status(409).json({ error: "An account with that email already exists." });

  const user = users.create(email, await hashPassword(password));
  res.json({ token: signToken(user), email: user.email });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const user = users.byEmail(email || "");
  if (!user || !(await verifyPassword(password || "", user.password_hash)))
    return res.status(401).json({ error: "Email or password is incorrect." });
  res.json({ token: signToken(user), email: user.email });
});

// ---------------------------------------------------------------- games
app.get("/api/games", requireAuth, (req, res) => {
  res.json(games.byUser(req.user.id));
});

app.post("/api/games", requireAuth, (req, res) => {
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Give the game a name." });
  res.json(games.create(req.user.id, name.slice(0, 80)));
});

app.patch("/api/games/:id", requireAuth, (req, res) => {
  const game = games.byIdForUser(req.params.id, req.user.id);
  if (!game) return res.status(404).json({ error: "Game not found." });
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "Give the game a name." });
  res.json(games.rename(game.id, name.slice(0, 80)));
});

app.delete("/api/games/:id", requireAuth, (req, res) => {
  const game = games.byIdForUser(req.params.id, req.user.id);
  if (!game) return res.status(404).json({ error: "Game not found." });
  games.remove(game.id);
  res.json({ ok: true });
});

app.post("/api/games/:id/rotate-key", requireAuth, (req, res) => {
  const game = games.byIdForUser(req.params.id, req.user.id);
  if (!game) return res.status(404).json({ error: "Game not found." });
  res.json({ api_key: games.rotateKey(game.id) });
});

app.get("/api/games/:id/stats", requireAuth, (req, res) => {
  const game = games.byIdForUser(req.params.id, req.user.id);
  if (!game) return res.status(404).json({ error: "Game not found." });
  const { from, to } = req.query;
  const validDate = (value) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!validDate(from) || !validDate(to))
    return res.status(400).json({ error: "Dates must use YYYY-MM-DD." });
  if (from && to && from > to)
    return res.status(400).json({ error: "Start date must be before end date." });
  res.json(stats.overview(game.id, { from, to }));
});

app.get("/api/games/:id/sessions", requireAuth, (req, res) => {
  const game = games.byIdForUser(req.params.id, req.user.id);
  if (!game) return res.status(404).json({ error: "Game not found." });
  const { from, to } = req.query;
  const validDate = (value) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!validDate(from) || !validDate(to))
    return res.status(400).json({ error: "Dates must use YYYY-MM-DD." });
  if (from && to && from > to)
    return res.status(400).json({ error: "Start date must be before end date." });
  res.json(stats.sessions(game.id, { from, to }));
});

app.post("/api/games/:id/summarize", requireAuth, async (req, res) => {
  const game = games.byIdForUser(req.params.id, req.user.id);
  if (!game) return res.status(404).json({ error: "Game not found." });
  res.json(await summarizeFeedback(stats.feedbackText(game.id)));
});

// ------------------------------------------------------------- ingestion
// The endpoint the Luau SDK talks to. Authenticated by API key, not JWT.
// Rate-limited so a runaway loop in someone's game can't hammer the service.
const ingestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 240, // 4 batches/sec sustained per IP — generous for playtests
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Slow down — too many batches. Increase your SDK flush interval." },
});

function checkApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key) return res.status(401).json({ error: "Missing x-api-key header." });
  const game = games.byKey(key);
  if (!game) return res.status(403).json({ error: "Invalid API key." });
  req.game = game;
  next();
}

app.post("/ingest", ingestLimiter, checkApiKey, (req, res) => {
  const batch = req.body || {};
  if (!Array.isArray(batch.events) && !Array.isArray(batch.feedback))
    return res.status(400).json({ error: "Batch needs an events or feedback array." });
  try {
    const result = ingest(req.game.id, batch);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: "Could not store batch: " + err.message });
  }
});

// health check (handy once deployed)
app.get("/healthz", (_req, res) => res.json({ ok: true, googleOAuth: oauthEnabled("GOOGLE"), githubOAuth: oauthEnabled("GITHUB") }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Playtest Pulse running -> http://localhost:${PORT}`);
});
