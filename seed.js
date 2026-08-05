// seed.js — populate a demo workspace with realistic playtest traffic.
// Doubles as a lightweight load simulator. Run with the server already up:
//     npm run seed
//
// Creates (or reuses) a demo developer account, a "Dungeon Crawler (Demo)"
// game, and streams sessions/events/feedback through the real /ingest endpoint —
// exactly as the Luau SDK would.

const BASE = process.env.BASE || "http://localhost:3000";
const DEMO_EMAIL = "demo@playtestpulse.dev";
const DEMO_PASSWORD = "demopassword123";

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const FEEDBACK = [
  "the boss on level 3 is way too hard, died like 8 times",
  "level 3 boss is impossible, no way to dodge the attacks",
  "boss fights are brutal but satisfying when you win",
  "movement feels laggy sometimes, especially in the cave",
  "there was noticeable lag when lots of enemies spawned",
  "combat felt laggy near the end",
  "love the art style, the dungeon lighting is gorgeous",
  "art is amazing, really atmospheric",
  "the visuals are beautiful honestly",
  "controls are confusing, couldn't figure out how to block",
  "took me forever to learn the controls, needs a tutorial",
  "add a tutorial please, jumped in with no idea what to do",
  "really fun, played for an hour straight",
  "great game, will definitely come back",
  "the loot system is addictive",
  "inventory is clunky to use mid-fight",
  "wish there were more checkpoints, losing progress hurts",
];

const EVENTS = [
  { name: "level_started", props: () => ({ level: 1 + Math.floor(Math.random() * 5) }) },
  { name: "player_died", props: () => ({ level: 1 + Math.floor(Math.random() * 5), cause: rand(["boss", "trap", "mob"]) }) },
  { name: "item_picked_up", props: () => ({ item: rand(["health_potion", "rare_sword", "gold", "key"]) }) },
  { name: "boss_encountered", props: () => ({ boss: rand(["Cave Warden", "Bone King", "Shadow Hydra"]) }) },
  { name: "level_completed", props: () => ({ level: 1 + Math.floor(Math.random() * 5), seconds: 60 + Math.floor(Math.random() * 400) }) },
  { name: "shop_opened", props: () => ({}) },
];

async function req(pathname, { method = "GET", body, token, apiKey } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  if (apiKey) headers["x-api-key"] = apiKey;
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${pathname} -> ${res.status} ${data.error || ""}`);
  return data;
}

async function getToken() {
  try {
    const d = await req("/api/auth/signup", { method: "POST", body: { email: DEMO_EMAIL, password: DEMO_PASSWORD } });
    return d.token;
  } catch {
    const d = await req("/api/auth/login", { method: "POST", body: { email: DEMO_EMAIL, password: DEMO_PASSWORD } });
    return d.token;
  }
}

async function main() {
  console.log("Seeding demo data at", BASE);
  const token = await getToken();

  const existing = await req("/api/games", { token });
  let game = existing.find((g) => g.name === "Dungeon Crawler (Demo)");
  if (!game) game = await req("/api/games", { method: "POST", body: { name: "Dungeon Crawler (Demo)" }, token });
  const apiKey = game.api_key;
  console.log("Game ready:", game.name);

  // A few fake live-server ids so the "filter by server" view has variety.
  const SERVERS = ["srv-us-east-01", "srv-eu-west-02", "srv-ap-southeast-03"];

  const SESSIONS = 15;
  for (let i = 0; i < SESSIONS; i++) {
    const playerId = 100000 + Math.floor(Math.random() * 900000);
    const eventCount = 4 + Math.floor(Math.random() * 8);
    const events = [{ name: "session_start", properties: { place_version: 42 }, client_ts: Date.now() }];
    for (let e = 0; e < eventCount; e++) {
      const def = rand(EVENTS);
      events.push({ name: def.name, properties: def.props(), client_ts: Date.now() });
    }

    const feedback = Math.random() < 0.6 ? [{ content: rand(FEEDBACK) }] : [];

    const result = await req("/ingest", {
      method: "POST",
      apiKey,
      body: {
        player_id: playerId,
        server_id: rand(SERVERS),
        started_at: Date.now(),
        events,
        feedback,
        ended: true,
      },
    });
    process.stdout.write(`  session ${i + 1}/${SESSIONS}  (+${result.events} events, +${result.feedback} feedback)\r`);
    await wait(40);
  }

  console.log("\nDone. Sign in at", BASE, "with:");
  console.log("  email:", DEMO_EMAIL);
  console.log("  password:", DEMO_PASSWORD);
}

main().catch((e) => {
  console.error("\nSeed failed:", e.message);
  console.error("Is the server running? Start it with: npm start");
  process.exit(1);
});
