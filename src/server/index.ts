import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { RateLimiter } from "./rateLimiter.js";
import { Game } from "./gameClient.js";
import { Poller } from "./poller.js";
import { Fixer } from "./fixer.js";
import { DiscoveryTracker } from "./discovery.js";
import { Automation } from "./automation.js";
import type { AutomationSettings } from "../shared/automation.js";
import type { AutoFixMode } from "../shared/problems.js";

const config = loadConfig();
if (!config.gameApiKey) {
  console.error("GAME_API_KEY is not set. Create one in the game (POST /api/me/api-key) and put it in .env.");
  process.exit(1);
}

const limiter = new RateLimiter(config.rateReserveFraction);
const game = new Game(config.gameBaseUrl, config.gameApiKey, limiter);
const poller = new Poller(game, {
  minIntervalMs: config.minPollIntervalMs,
  maxIntervalMs: config.maxPollIntervalMs,
  dataDir: config.dataDir,
});

const fixer = new Fixer(game, config.dataDir, () => poller.refreshSoon(3000), Date.now, config.dropCargoBeforeDeadlineMs);
const discovery = new DiscoveryTracker(game, config.dataDir, {
  scansPerCycle: config.sectorScansPerCycle,
  rescanMs: config.sectorRescanMs,
  blueprintCheckMs: config.blueprintCheckMs,
});

const automation = new Automation(game, config.dataDir, () => poller.refreshSoon(3000));

// After every refresh: fix first (urgent), then automation, then scan for discoveries.
let hooks: Promise<void> = Promise.resolve();
poller.on("snapshot", (snapshot) => {
  hooks = hooks
    .then(() => fixer.onSnapshot(snapshot))
    .then(() => automation.onSnapshot(snapshot))
    .then(() => discovery.onSnapshot(snapshot))
    .catch((err) => app.log.error(err, "post-poll hooks failed"));
});

function panelState() {
  return {
    snapshot: poller.snapshot,
    rate: limiter.snapshot(),
    fixMode: fixer.mode,
    problems: fixer.problems,
    unreadDiscoveries: discovery.discoveries().filter((d) => !d.read && d.present).length,
    automationMode: automation.settings.mode,
  };
}

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

if (config.panelPassword) {
  const expected = "Basic " + Buffer.from(`panel:${config.panelPassword}`).toString("base64");
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/panel-api/health") return;
    if (req.headers.authorization !== expected) {
      reply.header("WWW-Authenticate", 'Basic realm="Probe Control Panel"').code(401).send("Login required");
    }
  });
}

app.get("/panel-api/health", async () => ({ ok: true, lastPollFinishedAt: poller.snapshot.lastPollFinishedAt }));

app.get("/panel-api/state", async () => panelState());

app.get("/panel-api/problems", async () => ({
  mode: fixer.mode,
  problems: fixer.problems,
  attempts: fixer.attempts,
  log: fixer.log.slice(-300).reverse(),
}));

app.post<{ Body: { mode?: AutoFixMode } }>("/panel-api/fix-mode", async (req, reply) => {
  const mode = req.body?.mode;
  if (mode !== "auto" && mode !== "dry_run" && mode !== "off") return reply.code(400).send({ error: "mode must be auto, dry_run or off" });
  await fixer.setMode(mode);
  return { mode };
});

app.post<{ Body: { problemKey?: string; fixId?: string } }>("/panel-api/fix", async (req, reply) => {
  const { problemKey, fixId } = req.body ?? {};
  if (!problemKey || !fixId) return reply.code(400).send({ error: "problemKey and fixId are required" });
  return { entry: await fixer.runManually(problemKey, fixId) };
});

app.get("/panel-api/automation", async () => ({
  settings: automation.settings,
  plan: automation.lastPlan,
  renames: automation.renames,
  renamedCount: Object.keys(automation.originalNames).length,
  log: automation.log.slice(-300).reverse(),
}));

app.post<{ Body: Partial<AutomationSettings> }>("/panel-api/automation/settings", async (req) => ({
  settings: await automation.updateSettings(req.body ?? {}),
}));

app.post("/panel-api/automation/revert-names", async () => ({ reverted: await automation.revertNames(poller.snapshot) }));

app.get("/panel-api/discoveries", async () => ({ discoveries: discovery.discoveries(), scans: discovery.scans() }));

app.post<{ Body: { keys?: string[] | "all" } }>("/panel-api/discoveries/read", async (req) => {
  await discovery.markRead(req.body?.keys ?? "all");
  return { ok: true };
});

app.get("/panel-api/api-log", async () => ({ entries: game.log.slice().reverse() }));

app.post("/panel-api/refresh", async () => {
  poller.refreshSoon(0);
  return { ok: true };
});

// Server-sent events: push every new snapshot to open pages.
app.get("/panel-api/events", (req, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = () => {
    reply.raw.write(`event: state\ndata: ${JSON.stringify(panelState())}\n\n`);
  };
  send();
  poller.on("snapshot", send);
  fixer.on("changed", send);
  discovery.on("changed", send);
  automation.on("changed", send);
  const ping = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
  req.raw.on("close", () => {
    clearInterval(ping);
    poller.off("snapshot", send);
    fixer.off("changed", send);
    discovery.off("changed", send);
    automation.off("changed", send);
  });
});

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = [path.resolve(here, "../../web"), path.resolve(here, "../../dist/web")].find((p) =>
  existsSync(path.join(p, "index.html")),
);
if (webRoot) {
  await app.register(fastifyStatic, { root: webRoot });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/panel-api/")) return reply.code(404).send({ error: "not found" });
    return reply.sendFile("index.html");
  });
}

await Promise.all([poller.loadPersisted(), fixer.load(), discovery.load(), automation.load()]);
poller.start();
await app.listen({ host: "0.0.0.0", port: config.port });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    poller.stop();
    await app.close();
    process.exit(0);
  });
}
