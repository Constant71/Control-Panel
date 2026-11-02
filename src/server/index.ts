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
import { Manual, type ManualRequest } from "./manual.js";
import { CommsTracker } from "./comms.js";
import { Stations, StationError } from "./stations.js";
import type { MemberRole, StationConfig } from "../shared/stations.js";
import { OPERATIONS, SPEC_VERSION } from "../shared/operations.gen.js";
import { redact, diagnosticsFilename } from "./diagnostics.js";
import type { AutomationSettings } from "../shared/automation.js";
import type { AutoFixMode } from "../shared/problems.js";
import type { PanelOrder } from "../shared/activity.js";
import { flushStores, storageHealth } from "./store.js";

const config = loadConfig();
const STARTED_AT = new Date().toISOString();
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

// Station fuel belongs to the Stations feature; the fixer leaves it alone (see Stations.fuelManaged).
const fixer = new Fixer(game, config.dataDir, () => poller.refreshSoon(3000), Date.now, config.dropCargoBeforeDeadlineMs, () => stations.fuelManaged());
const discovery = new DiscoveryTracker(game, config.dataDir, {
  scansPerCycle: config.sectorScansPerCycle,
  rescanMs: config.sectorRescanMs,
  blueprintCheckMs: config.blueprintCheckMs,
});

const automation = new Automation(game, config.dataDir, () => poller.refreshSoon(3000));
const manual = new Manual(game, config.dataDir, () => poller.refreshSoon(2000));
const comms = new CommsTracker(game);
const stations = new Stations(game, config.dataDir, {
  setRole: async (probeId, role) => {
    await automation.updateSettings({ probes: { [String(probeId)]: { role } } });
  },
  snapshot: () => poller.snapshot,
  onActed: () => poller.refreshSoon(2000),
  mode: () => automation.settings.mode,
  sectors: () => discovery.sectorKnowledge(),
  costPerSector: () => automation.costPerSector,
  hold: (noExplore, noMining) => {
    automation.stationHold = { noExplore, noMining };
  },
  goals: (byProbe) => {
    automation.stationGoals = byProbe;
  },
});

// After every refresh: fix first (urgent), then automation, then scan for discoveries.
let hooks: Promise<void> = Promise.resolve();
poller.on("snapshot", (snapshot) => {
  hooks = hooks
    .then(() => fixer.onSnapshot(snapshot))
    .then(() => stations.onSnapshot(snapshot))
    .then(() => automation.onSnapshot(snapshot))
    .then(() => discovery.onSnapshot(snapshot))
    .then(() => comms.onSnapshot(snapshot))
    .catch((err) => app.log.error(err, "post-poll hooks failed"));
});

/** Latest order the panel gave each Manny in the last day (automation, auto-fix, or you), with its reason. */
function lastOrders(): Record<string, PanelOrder> {
  const out: Record<string, PanelOrder & { t: number }> = {};
  const cutoff = Date.now() - 86_400_000;
  const add = (mannyId: string | null | undefined, o: PanelOrder) => {
    const t = new Date(o.at).getTime();
    if (!mannyId || t < cutoff || (out[mannyId] && out[mannyId].t >= t)) return;
    out[mannyId] = { ...o, t };
  };
  for (const e of automation.log)
    if (e.ok && !e.dryRun) add(e.mannyId, { at: e.at, by: e.actionId.startsWith("confirm:") ? "you" : "automation", label: e.label, why: e.why ?? "" });
  for (const e of fixer.log)
    if (e.ok && !e.dryRun) add(e.mannyId, { at: e.at, by: e.initiator === "you" ? "you" : "auto-fix", label: e.label, why: e.why ?? e.problemTitle });
  return Object.fromEntries(Object.entries(out).map(([k, { t: _t, ...o }]) => [k, o]));
}

function panelState() {
  return {
    snapshot: poller.snapshot,
    rate: limiter.snapshot(),
    fixMode: fixer.mode,
    problems: fixer.problems,
    unreadDiscoveries: discovery.discoveries().filter((d) => !d.read && d.present).length,
    automationMode: automation.settings.mode,
    readySuggestions: automation.suggestions.filter((x) => x.ready && x.kind !== "move_probe").length,
    pendingMoves: automation.suggestions.filter((x) => x.kind === "move_probe").length,
    orders: lastOrders(),
    unreadMessages: comms.unreadCount,
    stationIds: stations.stations.map((x) => x.probeId),
    storageError: storageHealth.error,
    stationMembers: stations.members,
    stationWarnings: stations.status().reduce((n, x) => n + x.checks.filter((c) => !c.ok).length, 0),
    unreadByProbe: Object.fromEntries(Object.entries(comms.unread).map(([k, v]) => [k, v.length])),
    planned: automation.lastPlan.map((a) => ({
      probeId: "probeId" in a.plan ? a.plan.probeId : null, mannyId: "mannyId" in a.plan ? a.plan.mannyId : null, label: a.label, why: a.why,
    })),
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

app.get("/panel-api/health", async () => ({
  ok: true, lastPollFinishedAt: poller.snapshot.lastPollFinishedAt, version: process.env.PANEL_VERSION ?? "dev", startedAt: STARTED_AT,
}));

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

app.get("/panel-api/crafting", async () => ({
  enabled: automation.settings.crafting,
  mode: automation.settings.mode,
  recipes: automation.recipes,
  queue: automation.settings.craftQueue,
  statuses: automation.crafting,
  suggestions: automation.suggestions,
  holds: automation.holds(poller.snapshot),
}));

app.post<{ Body: { probeId?: number; goals?: unknown[] } }>("/panel-api/crafting/queue", async (req, reply) => {
  const { probeId, goals } = req.body ?? {};
  if (!Number.isInteger(probeId) || !Array.isArray(goals)) return reply.code(400).send({ error: "probeId and goals are required" });
  return { goals: await automation.setQueue(probeId!, goals as never[]) };
});

app.post<{ Body: { suggestionId?: string } }>("/panel-api/crafting/queue-missing", async (req, reply) => {
  const goals = await automation.queueMissing(String(req.body?.suggestionId ?? ""));
  if (!goals) return reply.code(404).send({ error: "That suggestion no longer applies." });
  return { goals };
});

// Build suggestions only ever run from here, after Merchant presses Confirm.
app.post<{ Body: { id?: string } }>("/panel-api/suggestions/confirm", async (req, reply) => {
  if (!req.body?.id) return reply.code(400).send({ error: "id is required" });
  return { entry: await automation.confirmSuggestion(req.body.id) };
});

app.get("/panel-api/exploration", async () => ({
  mode: automation.settings.mode,
  status: automation.exploration,
  suggestions: automation.suggestions.filter((x) => x.kind === "move_probe"),
}));

// Manual console: every operation in the spec, checked against the catalog before it is sent.
app.get("/panel-api/operations", async () => ({ specVersion: SPEC_VERSION, operations: OPERATIONS }));
app.get("/panel-api/manual-log", async () => ({ log: manual.log.slice().reverse() }));
app.post<{ Body: ManualRequest }>("/panel-api/call", async (req, reply) => {
  if (!req.body?.opId) return reply.code(400).send({ error: "opId is required" });
  const res = await manual.call(req.body);
  if (/messages/.test(req.body.opId) && req.body.opId !== "GET /api/probe/{probeId}/messages") comms.invalidate(Number(req.body.path?.probeId));
  return res;
});

// Stations (panel-only designation; see src/server/stations.ts).
const stationCall = async (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, fn: () => Promise<unknown>) => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StationError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
};
app.get("/panel-api/stations", async () => ({
  stations: stations.status(),
  log: stations.log.slice(-200).reverse(),
  // How the crafting planner is doing on each station's production goals.
  production: automation.crafting.filter((g) => g.goal.id.startsWith("station:")),
}));
app.post<{ Body: { probeId?: number } }>("/panel-api/stations/create", async (req, reply) =>
  stationCall(reply, async () => ({ station: await stations.makeStation(Number(req.body?.probeId)) })));
app.post<{ Body: { probeId?: number } }>("/panel-api/stations/remove", async (req, reply) =>
  stationCall(reply, async () => (await stations.removeStation(Number(req.body?.probeId)), { ok: true })));
app.post<{ Body: { probeId?: number; patch?: Partial<StationConfig> } }>("/panel-api/stations/update", async (req, reply) =>
  stationCall(reply, async () => ({ station: await stations.updateStation(Number(req.body?.probeId), req.body?.patch ?? {}) })));
app.post<{ Body: { probeId?: number; stationId?: number | null; role?: MemberRole | null } }>("/panel-api/stations/member", async (req, reply) =>
  stationCall(reply, async () => {
    const b = req.body ?? {};
    await stations.setMember(Number(b.probeId), b.stationId == null ? null : Number(b.stationId), b.role ?? null);
    return { ok: true };
  }));
app.post<{ Body: { probeId?: number } }>("/panel-api/stations/make-default", async (req, reply) =>
  stationCall(reply, async () => stations.makeDefault(Number(req.body?.probeId))));
app.post<{ Body: { probeId?: number; target?: { x: number; y: number; z: number } } }>("/panel-api/stations/flee", async (req, reply) =>
  stationCall(reply, async () => {
    const t = req.body?.target;
    if (!t) throw new StationError(400, "Pick a destination.");
    await stations.confirmFlee(Number(req.body?.probeId), { x: Number(t.x), y: Number(t.y), z: Number(t.z) });
    return { ok: true, message: "Flee confirmed: Mannies outside in this sector are recalled first, then the station moves." };
  }));
app.post<{ Body: { probeId?: number } }>("/panel-api/stations/flee-cancel", async (req, reply) =>
  stationCall(reply, async () => (await stations.cancelFlee(Number(req.body?.probeId)), { ok: true, message: "Flee cancelled." })));

app.get("/panel-api/discoveries", async () => ({ discoveries: discovery.discoveries(), scans: discovery.scans() }));

app.post<{ Body: { keys?: string[] | "all" } }>("/panel-api/discoveries/read", async (req) => {
  await discovery.markRead(req.body?.keys ?? "all");
  return { ok: true };
});

// One-file debug export (System page). Everything the panel saw and did, with secrets removed.
app.get("/panel-api/diagnostics", async (_req, reply) => {
  const bundle = {
    exportedAt: new Date().toISOString(),
    specVersion: SPEC_VERSION,
    gameBaseUrl: config.gameBaseUrl,
    state: panelState(),
    snapshot: poller.snapshot,
    apiLog: game.log,
    problems: { mode: fixer.mode, problems: fixer.problems, attempts: fixer.attempts, log: fixer.log.slice(-300) },
    automation: {
      settings: automation.settings, plan: automation.lastPlan, log: automation.log.slice(-300),
      crafting: automation.crafting, suggestions: automation.suggestions, exploration: automation.exploration,
    },
    stations: { status: stations.status(), log: stations.log.slice(-200), trips: stations.trips, handoffs: stations.handoffs },
    discoveries: { discoveries: discovery.discoveries(), scans: discovery.scans() },
    manualLog: manual.log.slice(-200),
  };
  reply.header("Content-Disposition", `attachment; filename="${diagnosticsFilename()}"`);
  reply.type("application/json");
  return JSON.stringify(redact(bundle, [config.gameApiKey, config.panelPassword]), null, 1);
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
  comms.on("changed", send);
  stations.on("changed", send);
  const ping = setInterval(() => reply.raw.write(": ping\n\n"), 25_000);
  req.raw.on("close", () => {
    clearInterval(ping);
    poller.off("snapshot", send);
    fixer.off("changed", send);
    discovery.off("changed", send);
    automation.off("changed", send);
    comms.off("changed", send);
    stations.off("changed", send);
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

await Promise.all([poller.loadPersisted(), fixer.load(), discovery.load(), automation.load(), manual.load(), stations.load()]);
poller.start();
await app.listen({ host: "0.0.0.0", port: config.port });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    poller.stop();
    await app.close();
    await flushStores(); // finish queued saves so nothing set just before a restart is lost
    process.exit(0);
  });
}
