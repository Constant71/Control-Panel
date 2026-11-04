import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "../mock/server.ts";
import { RateLimiter } from "../src/server/rateLimiter.ts";
import { Game, type Schemas } from "../src/server/gameClient.ts";
import { Poller, type Snapshot } from "../src/server/poller.ts";
import { planDepots, hiddenIdFor, depotFree } from "../src/server/depot.ts";
import { planAll } from "../src/server/automation.ts";
import { clearOrders } from "../src/server/orders.ts";
import { DEFAULT_STATION, type Depot, type StationConfig } from "../src/shared/stations.ts";
import { DEFAULT_PROBE_SETTINGS, type AutomationSettings } from "../src/shared/automation.ts";

type Probe = Schemas["Probe"];
const box = (id: string, label: string, kind: "probe" | "container", cap: number, used: number) => ({
  id, kind, label, sortOrder: kind === "probe" ? 0 : 1, capacity: cap, usedCapacity: used, freeCapacity: cap - used,
  capacityUnit: "earth_container_equivalent" as const, rules: {},
});

async function setup() {
  clearOrders();
  const mock = await startMock(0);
  const game = new Game(mock.url, "vng_mock", new RateLimiter(0.3));
  const poller = new Poller(game, { minIntervalMs: 1000, maxIntervalMs: 60_000 });
  await poller.pollOnce();
  return { mock, poller };
}

/** Prime stopped with 4 idle Mannies aboard, a 1 ECE core and an empty 0.5 ECE extra container. */
function home(s: Snapshot): Snapshot {
  const snap = structuredClone(s);
  const v = snap.probes[0];
  v.mannies = Array.from({ length: 4 }, (_, i) => ({ ...v.mannies![0], id: `m${i}`, name: `M${i}`, currentTask: null, task: [], location: { type: "probe", sector: null }, canReceiveOrders: true }));
  const P = v.detail as Probe;
  delete P.movement;
  P.status = "orbiting";
  P.inventory!.containers = [box("probe-core", "Probe", "probe", 1, 0.2), box("container-itm_x", "Extra", "container", 0.5, 0)];
  P.inventory!.freeCapacity = 1.3;
  P.inventory!.items = P.inventory!.items.filter((i) => i.container?.id !== "container-itm_x");
  for (const st of P.inventory!.resourceStocks) st.containers = (st.containers ?? []).filter((c) => c.container.id !== "container-itm_x");
  return snap;
}

const station = (over: Partial<StationConfig> = {}): StationConfig => ({ probeId: 1, ...structuredClone(DEFAULT_STATION), createdAt: "", ...over });
const at = (ms: number) => new Date(ms).toISOString();

test("the depot cycle: hide an empty container on the richest asteroid, wait while it fills, bring it home full, empty it", async () => {
  const { mock, poller } = await setup();
  try {
    const now = Date.now();
    let snap = home(poller.snapshot);
    let plan = planDepots({ snapshot: snap, stations: [station()], depots: [], handoffs: [], busy: new Set(), now });
    const hide = plan.ops[0];
    assert.ok(hide && hide.plan.kind === "depot_hide");
    assert.equal(hide.plan.kind === "depot_hide" && hide.plan.containerId, "container-itm_x");
    assert.equal(hide.plan.kind === "depot_hide" && hide.plan.asteroidId, "asteroid-metal-1", "3 ECE of metals beats 2 of ice");
    assert.equal(hiddenIdFor("container-itm_x"), "detached-container-container-itm_x", "the spec's example id");

    assert.equal(planDepots({ snapshot: snap, stations: [station({ depot: false })], depots: [], handoffs: [], busy: new Set(), now }).ops.length, 0, "off");
    assert.equal(planDepots({ snapshot: snap, stations: [station()], depots: [], handoffs: [], busy: new Set(), now, reserved: new Set(["container-itm_x"]) }).ops.length, 0,
      "a container a hand-off is using is left alone");

    const base: Depot = {
      stationId: 1, containerId: "container-itm_x", objectId: "detached-container-container-itm_x", asteroidId: "asteroid-metal-1", asteroidName: "Metal 3b91",
      capacity: 0.5, state: "hiding", at: at(now - 600_000), updatedAt: at(now - 600_000), contents: 0, readAt: null, note: null,
    };
    // Detached: the container left the inventory and nobody is detaching any more.
    (snap.probes[0].detail as Probe).inventory!.containers.pop();
    (snap.probes[0].detail as Probe).inventory!.containers.push(box("container-itm_y", "Extra 2", "container", 0.5, 0));
    plan = planDepots({ snapshot: snap, stations: [station()], depots: [base], handoffs: [], busy: new Set(), now });
    assert.equal(plan.changes[0].depot?.state, "active");
    const second = plan.ops[0];
    assert.ok(second?.plan.kind === "depot_hide" && second.plan.containerId === "container-itm_y", "and a second container goes out (4 at once by default)");

    const active = { ...base, state: "active" as const, contents: 0.2 };
    const miner = { ...snap.probes[0].mannies![0], id: "mx", currentTask: "mining", task: { targetAmount: 0.1, depositedAmount: 0.02, targetContainer: { id: base.objectId } } };
    snap.probes[0].mannies!.push(miner as never);
    assert.ok(Math.abs(depotFree(active, snap) - 0.22) < 1e-9, "0.5 - 0.2 inside - 0.08 on its way");
    plan = planDepots({ snapshot: snap, stations: [station()], depots: [active], handoffs: [], busy: new Set(), now });
    assert.ok(!plan.ops.some((o) => o.plan.kind === "depot_recover"));
    assert.match(plan.notes[1], /Mining into the depot/);

    const full = { ...active, contents: 0.49 };
    plan = planDepots({ snapshot: snap, stations: [station()], depots: [full], handoffs: [], busy: new Set(), now });
    assert.ok(!plan.ops.some((o) => o.plan.kind === "depot_recover"), "never recovered while a Manny mines into it (recovery would drop its cargo)");
    snap.probes[0].mannies!.pop();
    plan = planDepots({ snapshot: snap, stations: [station()], depots: [full], handoffs: [], busy: new Set(), now });
    assert.ok(plan.ops.some((o) => o.plan.kind === "depot_recover"));

    // Back aboard holding 0.49 ECE of metals: moved into the core.
    snap = home(poller.snapshot);
    const P = snap.probes[0].detail as Probe;
    const metals = P.inventory!.resourceStocks.find((r) => r.type === "metals")!;
    metals.containers = [...(metals.containers ?? []), { container: { id: "container-itm_x", kind: "container", label: "Extra", sortOrder: 1 }, amount: 0.49, containerSpace: 0.49, capacityUnit: "earth_container_equivalent" }];
    plan = planDepots({ snapshot: snap, stations: [station()], depots: [{ ...full, state: "recovering" }], handoffs: [], busy: new Set(), now });
    assert.equal(plan.changes[0].depot?.state, "emptying");
    plan = planDepots({ snapshot: snap, stations: [station()], depots: [{ ...full, state: "emptying" }], handoffs: [], busy: new Set(), now });
    const move = plan.ops.find((o) => o.plan.kind === "depot_empty");
    assert.ok(move && move.plan.kind === "depot_empty" && move.plan.toContainerId === "probe-core" && move.plan.amount === 0.49);
  } finally {
    await mock.close();
  }
});

test("mining goes into the depot for metals, ice and carbon, never deuterium, and needs no cargo room aboard", async () => {
  const { mock, poller } = await setup();
  try {
    const snap = home(poller.snapshot);
    const P = snap.probes[0].detail as Probe;
    const mannySpace = Math.max(0, ...P.inventory!.items.filter((i) => i.type === "manny").map((i) => i.containerSpace)) || 0.05;
    P.inventory!.freeCapacity = mannySpace + 0.005; // room for one Manny to dock, none for cargo
    for (const s of P.inventory!.resourceStocks) s.amount = 0;
    const settings: AutomationSettings = {
      mode: "auto", inspectConstructs: false, naming: false, crafting: true, craftQueue: {}, defaults: { ...DEFAULT_PROBE_SETTINGS, keepIdle: 1 }, probes: {}, lockedNames: [],
    };
    const mines = (depots = {}) => planAll({ snapshot: snap, settings, inspected: new Set(), busy: new Set(), depots }).actions.filter((a) => a.plan.kind === "mine");
    assert.ok(!mines().some((a) => a.plan.kind === "mine" && a.plan.resources[0] !== "deuterium"), "no room aboard: no cargo mining");
    const withDepot = mines({ "1": [
      { objectId: "detached-container-container-itm_x", asteroidId: "asteroid-metal-1", free: 0.05 },
      { objectId: "detached-container-container-itm_y", asteroidId: "asteroid-metal-1", free: 0.4 },
    ] });
    const metal = withDepot.find((a) => a.plan.kind === "mine" && a.plan.resources[0] === "metals");
    assert.ok(metal && metal.plan.kind === "mine" && metal.plan.targetContainerId === "detached-container-container-itm_y" && metal.plan.objectId === "asteroid-metal-1");
    assert.ok(withDepot.every((a) => a.plan.kind !== "mine" || a.plan.resources[0] !== "deuterium" || !a.plan.targetContainerId), "deuterium never goes into the depot");
  } finally {
    await mock.close();
  }
});

test("depots hidden together keep their own ids, and a mixed-up record is put right from the sector scan", async () => {
  const { mock, poller } = await setup();
  try {
    const now = Date.now();
    const snap = home(poller.snapshot);
    const v = snap.probes[0];
    const P = v.detail as Probe;
    // Two Mannies detach at once, each reporting its own hidden object.
    const detacher = (id: string, objectId: string) => ({ ...v.mannies![0], id, currentTask: "detaching_storage_container", task: { artificialObjectDetected: { objectId } } });
    v.mannies!.push(detacher("ma", "detached-container-container-itm_a") as never, detacher("mb", "detached-container-container-itm_b") as never);
    const hiding = (c: string, mannyId: string): Depot => ({
      stationId: 1, containerId: c, objectId: hiddenIdFor(c), asteroidId: "asteroid-metal-1", asteroidName: "Metal", capacity: 1,
      state: "hiding", at: at(now), updatedAt: at(now), contents: 0, readAt: null, note: null, mannyId,
    });
    let plan = planDepots({ snapshot: snap, stations: [station()], depots: [hiding("container-itm_a", "ma"), hiding("container-itm_b", "mb")], handoffs: [], busy: new Set(), now });
    assert.ok(!plan.changes.some((c) => c.depot && c.depot.objectId !== hiddenIdFor(c.containerId)), "no depot takes another Manny's object id");

    // The 2026-11-03 state: four records all pointing at container 12's object; 12 is back aboard, the others are hidden.
    v.mannies = v.mannies!.filter((m) => m.currentTask === null);
    const wrong = hiddenIdFor("container-itm_12");
    P.inventory!.containers.push(box("container-itm_12", "Cargo 12", "container", 1, 0));
    const ids = ["container-itm_5", "container-itm_11", "container-itm_13"];
    v.sector = { ...(v.sector ?? {}), objects: [...((v.sector?.objects ?? []) as object[]), ...ids.map((c) => ({ id: hiddenIdFor(c), type: "detached_container", mode: "hidden_on_asteroid" }))] } as never;
    const active = (c: string): Depot => ({ ...hiding(c, ""), objectId: wrong, state: "active", contents: 1, lost: true, mannyId: undefined });
    plan = planDepots({ snapshot: snap, stations: [station()], depots: [...ids, "container-itm_12"].map(active), handoffs: [], busy: new Set(), now });
    for (const c of ids) {
      const ch = plan.changes.find((x) => x.containerId === c);
      assert.equal(ch?.depot?.objectId, hiddenIdFor(c));
      assert.equal(ch?.depot?.lost, false);
      assert.equal(ch?.depot?.contents, null, "read again");
    }
    assert.equal(plan.changes.find((x) => x.containerId === "container-itm_12")?.depot, null, "the one aboard stops being a depot");
  } finally {
    await mock.close();
  }
});
