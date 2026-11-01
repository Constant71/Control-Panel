import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { RateLimiter } from "./rateLimiter.js";
import { Game } from "./gameClient.js";
import { Poller, type Snapshot } from "./poller.js";

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

app.get("/panel-api/state", async () => ({
  snapshot: poller.snapshot,
  rate: limiter.snapshot(),
}));

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
  const send = (snapshot: Snapshot) => {
    reply.raw.write(`event: state\ndata: ${JSON.stringify({ snapshot, rate: limiter.snapshot() })}\n\n`);
  };
  send(poller.snapshot);
  poller.on("snapshot", send);
  const ping = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
  req.raw.on("close", () => {
    clearInterval(ping);
    poller.off("snapshot", send);
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

await poller.loadPersisted();
poller.start();
await app.listen({ host: "0.0.0.0", port: config.port });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    poller.stop();
    await app.close();
    process.exit(0);
  });
}
