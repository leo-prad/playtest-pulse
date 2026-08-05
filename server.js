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
const DEMO_FEEDBACK = [
  "The boss on level 3 is too hard; I died eight times.",
  "Movement felt laggy in the cave when enemies spawned.",
  "The dungeon lighting looks great, but I need a tutorial for blocking.",
  "The loot system is addictive, though inventory is clunky mid-fight.",
  "More checkpoints would make failed runs less frustrating.",
];
const DEMO_EVENT_NAMES = ["level_started", "player_died", "item_picked_up", "boss_encountered", "level_completed", "shop_opened"];

async function ensureDemoWorkspace() {
  let demoUser = users.byEmail(DEMO_EMAIL);
  if (!demoUser) demoUser = users.create(DEMO_EMAIL, await hashPassword(DEMO_PASSWORD));

  let demoGame = games.byUser(demoUser.id).find((game) => game.name === "Dungeon Crawler (Demo)");
  if (!demoGame) demoGame = games.create(demoUser.id, "Dungeon Crawler (Demo)");
  if (stats.overview(demoGame.id).events > 0) return;

  const servers = ["srv-us-east-01", "srv-eu-west-02", "srv-ap-southeast-03"];
  // Spread the 15 demo sessions across the last ~4 weeks so the Overall chart
  // shows a real dated timeline (with quiet days) instead of one instant. Each
  // entry is "days ago"; clustering several sessions on some days and leaving
  // others empty gives the line natural peaks and valleys.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const daysAgo = [27, 27, 25, 22, 22, 20, 18, 15, 15, 13, 10, 7, 7, 4, 1];
  const baseNow = Date.now();
  for (let session = 0; session < 15; session++) {
    const events = [{ name: "session_started", properties: { place_version: 42 } }];
    for (let event = 0; event < 6 + (session % 4); event++) {
      const name = DEMO_EVENT_NAMES[(session + event) % DEMO_EVENT_NAMES.length];
      events.push({ name, properties: { level: 1 + ((session + event) % 5) } });
    }
    // backdate the whole batch to its assigned day (spread within the day a bit)
    const serverTs = baseNow - daysAgo[session] * DAY_MS + (session % 6) * 90 * 60 * 1000;
    ingest(
      demoGame.id,
      {
        session_id: `demo-session-${session + 1}`,
        player_id: 100000 + session,
        server_id: servers[session % servers.length],
        events,
        feedback: session % 2 === 0 ? [{ content: DEMO_FEEDBACK[session % DEMO_FEEDBACK.length] }] : [],
        ended: true,
      },
      { serverTs }
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
