# Playtest Pulse

**Drop-in playtest telemetry & feedback analytics for game developers.**
A Luau SDK streams gameplay events and player feedback from a Roblox game to a
Node backend; a live dashboard shows what's happening, and an LLM turns raw
feedback into ranked, quoted themes.

**[Open the live demo](https://playtest-pulse.onrender.com)**

Playtest Pulse is built as a playtest debugging layer—not a replacement for
Roblox's aggregate analytics. It connects player behavior, feedback, and
session-level telemetry so a developer can answer: **what should we fix next?**

### Highlights

- Google and GitHub sign-in, plus email/password accounts
- Isolated workspaces with per-game API keys and JWT-protected dashboards
- Batched Roblox telemetry ingestion with retry behavior and rate limiting
- Live event stream, game management, feedback themes, and connection setup

| Sign in | Dashboard |
| --- | --- |
| ![Playtest Pulse sign-in with Google and GitHub](docs/sign-in.png) | ![Playtest Pulse dashboard](docs/dashboard.png) |

> Built to answer a question every solo game dev asks after a playtest:
> *"What actually happened in there, and what did people hate?"* — right now
> that data lives in a mess of Discord messages and gut feeling.

---

## Run it locally (about 60 seconds)

```bash
npm install
npm start
```

Open **http://localhost:3000**, create an account, and create a game to get an
API key.

Want a populated dashboard immediately? Click **Try the demo →** on the sign-in
screen. Every click spins up a private, throwaway account with 15 sessions of
realistic dungeon-crawler telemetry and feedback — isolated per browser, so
nothing you do is visible to anyone else. Click **Summarize feedback** to
cluster it into themes.

Reset everything with `npm run reset`.

---

## Architecture

```
 ┌────────────────┐   HTTP POST /ingest     ┌──────────────────────┐
 │  Roblox game   │  (x-api-key, batched)   │   Node / Express API │
 │  Telemetry SDK │ ─────────────────────►  │ auth · games · ingest│
 └────────────────┘                         │  stats · summarize   │
                                            └──────────┬───────────┘
 ┌────────────────┐   JWT (dashboard)                  │
 │  Dashboard SPA │ ◄──────────────────────────────────┤
 │  live polling  │                                    ▼
 └────────────────┘                            ┌──────────────┐
                                               │  JSON store  │
        ┌───────────────────────┐              └──────────────┘
        │  LLM feedback themes   │◄── on-demand, with local fallback
        └───────────────────────┘
```

**Two trust boundaries, on purpose:**

- **Dashboard** → developer accounts authenticated with bcrypt + JWT.
- **Ingestion** → per-game API key (`x-api-key`), rate-limited.

A leaked game key can never read another dev's dashboard; a stolen dashboard
token is not a valid SDK key.

## Data model (`db.js`)

`users` → `games` (one API key each) → `sessions` → `events` / `feedback`.

Decisions worth noting:

- **API key on `games`, not `users`** — revoke per-game without nuking the account.
- **`events.properties` is JSON** — SDK sends arbitrary event shapes with no
  migration; trade-off is weaker typing on deep queries.
- **`client_ts` + `server_ts`** — never trust the client clock; keep what the
  client *claims* and what the server *observed*.
- **`player_ref` is a pseudonymous per-game hash** — the raw Roblox UserId is
  never stored, and namespacing by `game_id` means the same player hashes
  differently per game, preventing cross-game correlation. It is
  *pseudonymized, not anonymized*: the digest is deterministic (that's what
  makes session grouping and per-player erasure possible) and `game_id` is a
  namespace rather than a secret key, so it remains personal data under GDPR
  and is treated as such in [the privacy policy](public/privacy.html).
- **Batch ingest is a transaction** — a game never persists half a batch.

## The SDK (`sdk/Telemetry.luau`)

Server-side Luau module. Batches events per player and flushes on an interval
via `HttpService`, retries on transient failure (buffer only clears on server
ACK), and auto-closes sessions on `PlayerRemoving` and `BindToClose`.

```lua
local Telemetry = require(ServerScriptService.Telemetry)
Telemetry.Configure({ endpoint = "https://your-app.example.com", apiKey = "pk_..." })
Telemetry.init()

Telemetry.StartSession(player)
Telemetry.Track(player, "level_started", { level = 3 })
Telemetry.SubmitFeedback(player, "the boss felt unfair")
```

See `sdk/ExampleUsage.server.luau` for realistic wiring.

### For developers using the SDK

Developers integrating the Playtest Pulse SDK into a Roblox game are
responsible for disclosing analytics collection to their players in accordance
with Roblox's Terms of Service and applicable law (GDPR, CCPA, and similar).
**Playtest Pulse acts as a data processor; the integrating developer is the
data controller.** In practice, that means adding a short line to your game's
description or in-game info page ("We use Playtest Pulse for gameplay
analytics"), and honoring player deletion requests via the RTBF endpoint
below. See [`public/privacy.html`](public/privacy.html) for what Playtest
Pulse itself stores and does not store.

## Right-to-be-forgotten (RTBF)

Wipe every trace of one player from one game — the player's sessions, every
event on those sessions, and every feedback comment they left. Scoped to the
game whose API key is presented, so a leaked key can only ever affect that
game's own data.

```
DELETE /player/:player_ref
Headers: x-api-key: pk_...
```

`player_ref` is the anonymized 16-hex-char hash that appears in the
dashboard's Sessions view — the SDK also has it in its per-player buffer, so
an in-game "delete my data" button can call this endpoint on the player's
behalf. Response includes counts of what was removed:

```json
{ "ok": true, "player_ref": "a1b2c3...", "removed": { "sessions": 3, "events": 47, "feedback": 2 } }
```

## LLM feedback summarizer (`summarize.js`)

Set `ANTHROPIC_API_KEY` to get LLM-extracted themes (title, recurrence count,
severity, representative quote). With no key set, it falls back to a local
keyword-frequency pass so the feature always works — deliberate graceful
degradation.

> **Privacy note — this is a data-processing decision, not just a feature flag.**
> With the key set, invoking the summarizer sends up to the 100 most recent
> feedback entries for that game — verbatim player-written text — to the
> Anthropic API, making Anthropic a sub-processor. With no key set, the analysis
> runs locally and **no feedback text leaves your infrastructure**. If you
> deploy with the key, make sure your privacy policy discloses it (ours does,
> in [§8](public/privacy.html)) and that it matches your actual deployment.

## Tech

Node + Express · dependency-free JSON store behind a swappable repository interface (drop-in Postgres for prod) · bcrypt + JWT ·
express-rate-limit · vanilla JS dashboard (no build step) · Luau SDK.

## Roadmap

- WebSocket live stream (replace 3s polling)
- Cached `feedback_summaries` table to avoid re-summarizing unchanged batches
- Funnel + retention views (session → level_started → level_completed)
- In-game feedback prompt UI component shipped with the SDK
