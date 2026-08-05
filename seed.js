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
  "The boss on level 3 is way too hard, I died like 8 times in a row",
  "Level 3 boss is nearly impossible, no window to dodge the heavy attack",
  "Boss fight difficulty is brutal, but really satisfying when you finally win",
  "Boss phase 2 is way too fast compared to phase 1",
  "More checkpoints would make failed runs less frustrating",
  "Wish there were checkpoints before boss rooms so I don't lose progress",
  "Need more checkpoints in level 4, walking back takes 3 minutes",
  "Checkpoints feel too far apart in the cave zone",
  "Movement feels laggy sometimes, especially in the cavern section",
  "There was noticeable combat lag when lots of skeleton mobs spawned",
  "Network lag spikes whenever a new player joins the server",
  "Framerate dropped severely during the boss particle attack",
  "Controls are confusing, couldn't figure out how to block or parry",
  "Took me forever to figure out the controls, needs a proper tutorial",
  "Please add a tutorial at the start, I had no idea how to spellcast",
  "Tutorial prompt disappeared too fast before I could read it",
  "Loot drops are super addictive and rewarding!",
  "Loot chests are hard to spot in dark dungeon areas",
  "Inventory menu is clunky to navigate while fighting mobs",
  "Inventory auto-sort button would be a lifesaver",
  "Love the art style, dungeon lighting looks gorgeous and atmospheric",
  "Graphics and particle effects look amazing honestly",
  "Camera angle gets stuck behind walls in tight hallways",
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

  const SERVERS = ["srv-us-east-01", "srv-eu-west-02", "srv-ap-southeast-03"];
  const SESSIONS = 16;

  for (let i = 0; i < SESSIONS; i++) {
    const playerId = 100000 + Math.floor(Math.random() * 900000);
    const events = [{ name: "session_start", properties: { place_version: 42 }, client_ts: Date.now() }];

    // Add funnel_step progression events based on index
    events.push({ name: "funnel_step", properties: { step: 1, name: "Visited Game", desc: "Launched playtest session" }, client_ts: Date.now() });

    if (i < 13) {
      events.push({ name: "funnel_step", properties: { step: 2, name: "Started Stage", desc: "Began dungeon exploration" }, client_ts: Date.now() });
    }
    if (i < 9) {
      events.push({ name: "funnel_step", properties: { step: 3, name: "Reached Boss", desc: "Encountered level boss" }, client_ts: Date.now() });
    }
    if (i < 5) {
      events.push({ name: "funnel_step", properties: { step: 4, name: "Defeated Boss", desc: "Vanquished dungeon boss" }, client_ts: Date.now() });
    }
    if (i < 3) {
      events.push({ name: "funnel_step", properties: { step: 5, name: "Completed Run", desc: "Successfully escaped dungeon" }, client_ts: Date.now() });
    }

    const eventCount = 3 + Math.floor(Math.random() * 6);
    for (let e = 0; e < eventCount; e++) {
      const def = rand(EVENTS);
      events.push({ name: def.name, properties: def.props(), client_ts: Date.now() });
    }

    const feedback = Math.random() < 0.75 ? [{ content: rand(FEEDBACK) }] : [];

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
