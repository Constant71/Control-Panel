import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "../mock/server.ts";
import { RateLimiter } from "../src/server/rateLimiter.ts";
import { Game, type Schemas } from "../src/server/gameClient.ts";
import { Poller, type Snapshot } from "../src/server/poller.ts";
import { Automation, planAutomation, mineableTargets } from "../src/server/automation.ts";
import { planRenames, containerLabel, probeNames } from "../src/server/naming.ts";
import { clearOrders } from "../src/server/orders.ts";
import { DEFAULT_PROBE_SETTINGS, type AutomationSettings } from "../src/shared/automation.ts";

const settings = (over: Partial<AutomationSettings> = {}): AutomationSettings => ({
  mode: "auto", inspectConstructs: true, naming: false, defaults: { ...DEFAULT_PROBE_SETTINGS }, probes: {}, lockedNames: [], ...over,
});

async function setup() {
  clearOrders();
  const mock = await startMock(0);
  const game = new Game(mock.url, "vng_mock", new RateLimiter(0.3));
  const poller = new Poller(game, { minIntervalMs: 1000, maxIntervalMs: 60_000 });
  await poller.pollOnce();
  return { mock, game, poller };
}

/** Prime with plenty of room, no Mannies outside, and four idle Mannies. */
function roomy(s: Snapshot): Snapshot {
  const snap = structuredClone(s);
  const prime = snap.probes[0];
  const d = prime.detail as Schemas["Probe"];
  d.inventory!.usedCapacity = 0.2;
  d.inventory!.freeCapacity = 0.8;
  d.inventory!.resourceStocks = [];
  prime.mannies = prime.mannies!.map((m, i) => ({
    ...m, id: `mny_${i}`, name: `manny-${i}`, currentTask: null, task: [], location: { type: "probe", sector: null }, canReceiveOrders: true,
    cargo: { ...m.cargo, metals: 0, ice: 0, deuterium: 0, organicCompounds: 0 },
  }));
  return snap;
}

test("finds mineable targets in asteroids and solar-system minableTargets", async () => {
  const { mock, poller } = await setup();
  try {
    const ids = mineableTargets(poller.snapshot.probes[0].sector).map((t) => t.id).sort();
    assert.deepEqual(ids, ["asteroid-ice-1", "asteroid-metal-1"]);
  } finally {
    await mock.close();
  }
});

test("mines what is furthest below target, keeps a Manny idle, inspects constructs first", async () => {
  const { mock, poller } = await setup();
  try {
    const plan = planAutomation({ snapshot: roomy(poller.snapshot), settings: settings(), inspected: new Set(), busy: new Set() });
    assert.equal(plan[0].plan.kind, "inspect", "construct inspection comes first");
    const mines = plan.filter((a) => a.plan.kind === "mine");
    assert.equal(plan.length, 4, "5 idle Mannies minus 1 kept idle");
    const first = mines[0].plan as Extract<typeof mines[0]["plan"], { kind: "mine" }>;
    assert.deepEqual(first.resources, ["metals"], "metals target 0.3 is the biggest gap");
    assert.equal(first.objectId, "asteroid-metal-1");
    assert.ok(first.targetAmount <= 0.1);
    const kinds = mines.map((a) => (a.plan as { resources: string[] }).resources[0]);
    assert.ok(kinds.includes("ice"), "spreads across resources as gaps close");
    assert.ok(!kinds.includes("carbon_compounds"), "no target has carbon, so none is ordered");
  } finally {
    await mock.close();
  }
});

test("never sends Mannies out without room for all of them to dock", async () => {
  const { mock, poller } = await setup();
  try {
    // Real mock state: hull 97% full and three Mannies outside.
    const plan = planAutomation({ snapshot: poller.snapshot, settings: settings({ inspectConstructs: false }), inspected: new Set(), busy: new Set() });
    assert.equal(plan.filter((a) => a.plan.kind === "mine").length, 0);

    const tight = roomy(poller.snapshot);
    const inv = (tight.probes[0].detail as Schemas["Probe"]).inventory!;
    inv.freeCapacity = 0.1; // room for about one Manny (0.02) plus 0.08 cargo
    const p2 = planAutomation({ snapshot: tight, settings: settings({ inspectConstructs: false }), inspected: new Set(), busy: new Set() });
    const total = p2
      .filter((a) => a.plan.kind === "mine" && (a.plan as { resources: string[] }).resources[0] !== "deuterium")
      .reduce((s, a) => s + 0.02 + (a.plan as { targetAmount: number }).targetAmount, 0);
    assert.ok(total <= 0.1 + 1e-9, `planned ${total} ECE must fit in 0.1`);
  } finally {
    await mock.close();
  }
});

test("mining disabled per probe and moving probes are left alone", async () => {
  const { mock, poller } = await setup();
  try {
    const s = settings({ inspectConstructs: false, probes: { "1": { mining: false } } });
    assert.equal(planAutomation({ snapshot: roomy(poller.snapshot), settings: s, inspected: new Set(), busy: new Set() }).length, 0);
  } finally {
    await mock.close();
  }
});

test("engine sends mine and inspect orders once, logs them, and dry run sends nothing", async () => {
  const { mock, game, poller } = await setup();
  try {
    const a = new Automation(game, undefined, () => {});
    await a.updateSettings({ mode: "dry_run" });
    await a.onSnapshot(roomy(poller.snapshot));
    assert.equal(mock.posts().length, 0);
    assert.ok(a.log.every((e) => e.dryRun));

    await a.updateSettings({ mode: "auto" });
    await a.onSnapshot(roomy(poller.snapshot));
    const posts = mock.posts();
    assert.ok(posts.some((p) => p.path.endsWith("/inspect-sector-object")));
    const mine = posts.find((p) => p.path.endsWith("/mine"))!;
    assert.deepEqual(Object.keys(mine.body as object).sort(), ["objectId", "resources", "targetAmount"]);
    const before = posts.length;
    await a.onSnapshot(roomy(poller.snapshot));
    assert.equal(mock.posts().length, before, "just-ordered Mannies and inspected constructs are not ordered again");
  } finally {
    await mock.close();
  }
});

test("naming: probes by role, Mannies by probe code, containers by their rules", async () => {
  const { mock, poller } = await setup();
  try {
    const names = probeNames([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], (id) => (id === 1 ? "Station" : id === 4 ? "Scout" : "Hauler"));
    assert.deepEqual([...names.values()].map((n) => n.name), ["Station-Alpha", "Hauler-01", "Hauler-02", "Scout-01"]);
    assert.equal(names.get(2)!.code, "H01");

    const base = { id: "c", kind: "container", label: "x", sortOrder: 1, capacity: 1, usedCapacity: 0, freeCapacity: 1, capacityUnit: "earth_container_equivalent" } as Schemas["StorageContainer"];
    assert.equal(containerLabel({ ...base, kind: "probe", rules: {} }), "Core");
    assert.equal(containerLabel({ ...base, rules: { priority: ["manny"] } }), "Home · Mannies");
    assert.equal(containerLabel({ ...base, rules: { priority: ["metals"], strictExclusion: ["manny"] } }), "Hand-off · Metals");
    assert.equal(containerLabel({ ...base, rules: { priority: ["ice"] } }), "Cargo · Ice");

    const plan = planRenames(poller.snapshot, () => "Hauler", new Set(["manny:mny_a1"]));
    const prime = plan.filter((r) => r.probeId === 1);
    assert.equal(prime.find((r) => r.kind === "probe")!.planned, "Hauler-01");
    const mannyNames = prime.filter((r) => r.kind === "manny").map((r) => r.planned);
    assert.equal(new Set(mannyNames).size, mannyNames.length, "Manny names are unique");
    assert.ok(mannyNames.every((n) => /^H01-M\d\d$/.test(n)));
    assert.equal(prime.find((r) => r.entity === "manny:mny_a1")!.locked, true);
    assert.equal(plan.find((r) => r.probeId === 3)!.reachable, false, "unreachable probes wait");
  } finally {
    await mock.close();
  }
});

test("naming engine renames, records originals, skips locks, and reverts", async () => {
  const { mock, game, poller } = await setup();
  try {
    const a = new Automation(game, undefined, () => {});
    await a.updateSettings({ naming: true, mode: "auto", inspectConstructs: false, defaults: { ...DEFAULT_PROBE_SETTINGS, mining: false }, lockedNames: ["probe:2"] });
    await a.onSnapshot(poller.snapshot);
    const patches = mock.posts().filter((p) => p.path.startsWith("PATCH"));
    assert.equal(patches.length, 5, "max 5 renames per refresh");
    assert.ok(!patches.some((p) => p.path === "PATCH /api/probe/2"), "locked probe untouched");
    assert.equal(a.originalNames["probe:1"], "Prime");
    const reverted = await a.revertNames(poller.snapshot);
    assert.equal(reverted, 5);
    assert.ok(mock.posts().some((p) => p.path === "PATCH /api/probe/1" && (p.body as { name: string }).name === "Prime"));
    assert.equal(a.settings.naming, false, "revert switches naming off");
  } finally {
    await mock.close();
  }
});
