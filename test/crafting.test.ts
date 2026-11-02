import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMock } from "../mock/server.ts";
import { RateLimiter } from "../src/server/rateLimiter.ts";
import { Game, type Schemas } from "../src/server/gameClient.ts";
import { Poller, type Snapshot } from "../src/server/poller.ts";
import { Automation, planAll } from "../src/server/automation.ts";
import { buildSuggestions } from "../src/server/builds.ts";
import { detectProblems } from "../src/server/detect.ts";
import { clearOrders } from "../src/server/orders.ts";
import { DEFAULT_PROBE_SETTINGS, type AutomationSettings } from "../src/shared/automation.ts";
import type { CraftGoal } from "../src/shared/crafting.ts";

const goal = (item: string, quantity: number, once = false): CraftGoal => ({ id: `g-${item}`, item, quantity, once, addedAt: new Date().toISOString() });
const settings = (queue: CraftGoal[], over: Partial<AutomationSettings> = {}): AutomationSettings => ({
  mode: "auto", inspectConstructs: false, naming: false, crafting: true, craftQueue: { "1": queue },
  defaults: { ...DEFAULT_PROBE_SETTINGS, mining: false }, probes: {}, lockedNames: [], ...over,
});

async function setup() {
  clearOrders();
  const mock = await startMock(0);
  const game = new Game(mock.url, "vng_mock", new RateLimiter(0.3));
  const poller = new Poller(game, { minIntervalMs: 1000, maxIntervalMs: 60_000 });
  await poller.pollOnce();
  return { mock, game, poller };
}

/** Prime with room, every Manny idle aboard, and optional metals in storage. */
function roomy(s: Snapshot, metals = 0): Snapshot {
  const snap = structuredClone(s);
  const prime = snap.probes[0];
  const inv = (prime.detail as Schemas["Probe"]).inventory!;
  inv.usedCapacity = 0.2;
  inv.freeCapacity = 0.8;
  inv.resourceStocks = metals
    ? [{ id: "s", type: "metals", name: "Metals", amount: metals, containerSpace: metals, capacityUnit: "earth_container_equivalent", containers: [] }]
    : [];
  prime.mannies = prime.mannies!.map((m, i) => ({
    ...m, id: `mny_${i}`, name: `manny-${i}`, currentTask: null, task: [], location: { type: "probe", sector: null }, canReceiveOrders: true,
    cargo: { ...m.cargo, metals: 0, ice: 0, deuterium: 0, organicCompounds: 0 },
  }));
  return snap;
}

test("crafting expands the recipe tree and turns missing metals into a mining shortfall", async () => {
  const { mock, poller } = await setup();
  try {
    const recipes = mock.world.recipes;
    // Prime has 5 motors and 3 steel bars; 7 motors needs 2 more → 2 micro conductors → 0.01 metals.
    const r = planAll({ snapshot: roomy(poller.snapshot), settings: settings([goal("electric_motor", 7)]), inspected: new Set(), busy: new Set(), recipes });
    assert.equal(r.actions.length, 0, "nothing can start without metals");
    const st = r.crafting[0];
    assert.equal(st.have, 5);
    assert.equal(st.done, false);
    assert.equal(st.steps.find((x) => x.item === "electric_motor")?.status, "needs_ingredients");
    assert.equal(st.steps.find((x) => x.item === "micro_conductor")?.status, "needs_resources");
    assert.ok(Math.abs((st.shortfalls.metals ?? 0) - 0.01) < 1e-9);

    // With metals aboard, the printer starts one conductor (it runs one craft at a time).
    const r2 = planAll({ snapshot: roomy(poller.snapshot, 1), settings: settings([goal("electric_motor", 7)]), inspected: new Set(), busy: new Set(), recipes });
    assert.deepEqual(r2.actions.map((a) => a.plan.kind), ["print"]);
    assert.ok(r2.crafting[0].steps.some((x) => x.item === "micro_conductor" && x.status === "printer_busy"));
  } finally {
    await mock.close();
  }
});

test("mining is asked for what the crafting queue is short of", async () => {
  const { mock, poller } = await setup();
  try {
    const s = settings([goal("waypoint_bookmark", 3)], { defaults: { ...DEFAULT_PROBE_SETTINGS, targets: { metals: 0, ice: 0, carbon_compounds: 0, deuteriumPercent: 0 } } });
    const r = planAll({ snapshot: roomy(poller.snapshot), settings: s, inspected: new Set(), busy: new Set(), recipes: mock.world.recipes });
    const mine = r.actions.find((a) => a.plan.kind === "mine");
    assert.ok(mine, "metals for the bookmarks are mined even with zero stock targets");
    assert.deepEqual((mine!.plan as { resources: string[] }).resources, ["metals"]);
    assert.match(mine!.why, /crafting queue/);
  } finally {
    await mock.close();
  }
});

test("build suggestions list what is missing and are ready only with a full kit", async () => {
  const { mock, poller } = await setup();
  try {
    const snap = roomy(poller.snapshot);
    let sugs = buildSuggestions({ snapshot: snap, improvements: {}, busy: new Set() });
    const generic = sugs.find((x) => x.id === "assemble:1:generic")!;
    assert.equal(generic.ready, false);
    assert.deepEqual(generic.missing.map((l) => [l.item, l.need]), [["scut_relay", 1]]);
    assert.deepEqual(generic.containerIds, ["container-itm_empty1", "container-itm_empty2"]);
    assert.ok(generic.why.length >= 3 && generic.risks.some((r) => /forgotten/.test(r)));
    assert.ok(!sugs.some((x) => x.probeId === 2 && x.ready), "a moving probe is never ready to assemble");

    (snap.probes[0].detail as Schemas["Probe"]).inventory!.items.push({ id: "relay", type: "scut_relay", name: "SCUT relay", containerSpace: 0.12 });
    sugs = buildSuggestions({ snapshot: snap, improvements: {}, busy: new Set() });
    assert.equal(sugs.find((x) => x.id === "assemble:1:generic")!.ready, true);
    assert.equal(sugs.find((x) => x.id === "assemble:1:deuterium_tanker")!.ready, false);
  } finally {
    await mock.close();
  }
});

test("automation orders crafts once, drops finished one-off goals, and only assembles on confirmation", async () => {
  const { mock, game, poller } = await setup();
  try {
    const dir = await mkdtemp(path.join(tmpdir(), "panel-"));
    const auto = new Automation(game, dir, () => {});
    await auto.load();
    await auto.updateSettings({ inspectConstructs: false, defaults: { ...DEFAULT_PROBE_SETTINGS, mining: false } });
    await auto.onSnapshot(roomy(poller.snapshot)); // loads recipes
    assert.ok(auto.recipes.length > 0);

    await auto.setQueue(1, [goal("steel_plate", 1), goal("steel_bar", 3, true)]);
    await auto.onSnapshot(roomy(poller.snapshot));
    const crafts = mock.posts().filter((p) => p.path.endsWith("/craft"));
    assert.equal(crafts.length, 1);
    assert.deepEqual(crafts[0].body, { recipe: "steel_plate" });
    assert.equal(auto.settings.craftQueue["1"].length, 2, "steel bars are short after the plate claims two");

    await auto.onSnapshot(roomy(poller.snapshot));
    assert.equal(mock.posts().filter((p) => p.path.endsWith("/craft")).length, 1, "the tracked craft isn't ordered twice");

    // Nothing was assembled automatically.
    assert.equal(mock.posts().filter((p) => p.path.endsWith("/assemble-probe")).length, 0);
    const notReady = await auto.confirmSuggestion("assemble:1:generic");
    assert.equal(notReady.ok, false);
    assert.match(notReady.message ?? "", /scut relay/);

    const snap = roomy(poller.snapshot);
    (snap.probes[0].detail as Schemas["Probe"]).inventory!.items.push({ id: "relay", type: "scut_relay", name: "SCUT relay", containerSpace: 0.12 });
    await auto.onSnapshot(snap);
    const entry = await auto.confirmSuggestion("assemble:1:generic");
    assert.equal(entry.ok, true);
    const asm = mock.posts().filter((p) => p.path.endsWith("/assemble-probe"));
    assert.equal(asm.length, 1);
    assert.deepEqual(asm[0].body, { model: "generic", containerIds: ["container-itm_empty1", "container-itm_empty2"] });

    const queued = await auto.queueMissing("assemble:1:deuterium_tanker");
    assert.ok(queued!.some((g) => g.item === "steel_plate" && g.quantity === 10), "existing goal raised to the kit amount");
    assert.ok(queued!.some((g) => g.item === "integrated_circuit" && g.quantity === 1 && g.once), "new parts are one-off goals");
  } finally {
    await mock.close();
  }
});

test("a probe moving away from a Manny's assembly is a critical problem, cancelled while still preparing", async () => {
  const { mock, poller } = await setup();
  try {
    const snap = structuredClone(poller.snapshot);
    const scout = snap.probes[1];
    scout.mannies![0] = { ...scout.mannies![0], currentTask: "assembling_probe", location: { type: "sector", sector: { relative: { x: 0, y: 0, z: 0 } } } };
    let p = detectProblems(snap).find((x) => x.code === "assembly_probe_moving")!;
    assert.equal(p.severity, "critical");
    assert.equal(p.fixes.length, 0, "past preparation the API can't cancel the move");

    (scout.detail as Schemas["Probe"]).movement!.status = "preparing";
    p = detectProblems(snap).find((x) => x.code === "assembly_probe_moving")!;
    assert.deepEqual(p.fixes.map((f) => f.endpoint), ["DELETE /api/probe/2/move"]);
  } finally {
    await mock.close();
  }
});

test("the time estimate is the printer's serial work or the Mannies' shared work, whichever is longer", async () => {
  const { etaFor, miningRate } = await import("../src/server/crafting.ts");
  // One Manny from the game's default recipes: about 17.3 h of Manny crafts and 9 h of printing.
  const manny = 17.33 * 3600, printer = 9 * 3600;
  const thirty = etaFor(30 * (manny + printer), 30 * printer, 0, 19);
  assert.equal(thirty.limitedBy, "printer");
  assert.equal(Math.round(thirty.seconds / 86400), 11, "30 Mannies on one printer take about 11 days, not 33");
  const few = etaFor(manny + printer, printer, 0, 2);
  assert.equal(few.limitedBy, "mannies");

  const start = "2026-11-02T05:46:48+00:00", end = "2026-11-02T07:36:48+00:00"; // 0.1 ECE in 6600 s, as in a live task
  const m = { currentTask: "mining", taskStartTime: start, taskEstimatedEndTime: end, task: { targetAmount: 0.1 } } as unknown as Schemas["Manny"];
  assert.ok(Math.abs(miningRate([m])! - 0.1 / 6600) < 1e-12);
  assert.equal(miningRate([]), null);
});
