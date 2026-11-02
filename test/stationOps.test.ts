import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMock } from "../mock/server.ts";
import { RateLimiter } from "../src/server/rateLimiter.ts";
import { Game, type Schemas } from "../src/server/gameClient.ts";
import { Poller, type Snapshot } from "../src/server/poller.ts";
import { Stations } from "../src/server/stations.ts";
import { planService, trackHandoffs } from "../src/server/stationOps.ts";
import { clearOrders } from "../src/server/orders.ts";
import { DEFAULT_STATION, type Handoff, type StationConfig, type StationsData } from "../src/shared/stations.ts";

type Probe = Schemas["Probe"];
const box = (id: string, label: string, kind: "probe" | "container", cap: number, used: number, rules: Schemas["StorageContainerRules"] = {}) => ({
  id, kind, label, sortOrder: kind === "probe" ? 0 : 1, capacity: cap, usedCapacity: used, freeCapacity: cap - used,
  capacityUnit: "earth_container_equivalent" as const, rules,
});

async function setup() {
  clearOrders();
  const mock = await startMock(0);
  const game = new Game(mock.url, "vng_mock", new RateLimiter(0.3));
  const poller = new Poller(game, { minIntervalMs: 1000, maxIntervalMs: 60_000 });
  await poller.pollOnce();
  return { mock, game, poller };
}

/** Prime (station, full tank) and Scout (Hauler) both stopped in sector 0,0,0, every Manny aboard and idle. */
function docked(s: Snapshot): Snapshot {
  const snap = structuredClone(s);
  for (const v of snap.probes) v.mannies = v.mannies?.map((m) => ({ ...m, currentTask: null, task: [], location: { type: "probe", sector: null }, canReceiveOrders: true })) ?? null;
  const prime = snap.probes[0].detail as Probe;
  prime.fuel.deuterium = 100;
  const scout = snap.probes[1].detail as Probe;
  delete scout.movement;
  scout.status = "orbiting";
  scout.inventory!.containers = [
    box("probe-core", "Probe", "probe", 1, 0.3, { priority: ["manny"] }),
    box("container-full", "Hold A", "container", 0.25, 0.24, { priority: ["metals"], strictExclusion: ["manny"] }),
  ];
  return snap;
}

const station = (over: Partial<StationConfig> = {}): StationConfig => ({ probeId: 1, ...structuredClone(DEFAULT_STATION), createdAt: "", ...over });
const data = (over: Partial<StationConfig> = {}, role: "Hauler" | "Tanker" = "Hauler"): Pick<StationsData, "stations" | "members"> =>
  ({ stations: [station(over)], members: { "2": { stationId: 1, role, joinedAt: "" } } });

test("a docked Hauler hands over its full container, gets empties back and is topped up", async () => {
  const { mock, poller } = await setup();
  try {
    const snap = docked(poller.snapshot);
    let ops = planService({ snapshot: snap, data: data(), handoffs: [], busy: new Set(), recentRefuels: new Set() });
    assert.ok(!ops.some((o) => o.plan.kind === "detach" && o.plan.purpose === "empty"),
      "Prime has 0.03 ECE free: giving away an empty 0.25 container would leave no room for its Manny out mining");
    (snap.probes[0].detail as Probe).inventory!.freeCapacity = 0.8;
    ops = planService({ snapshot: snap, data: data(), handoffs: [], busy: new Set(), recentRefuels: new Set() });
    const full = ops.find((o) => o.plan.kind === "detach" && o.plan.purpose === "full");
    assert.ok(full, "the 96% full hand-off container goes to the station");
    assert.deepEqual([full!.plan.probeId, (full!.plan as { toProbeId: number }).toProbeId], [2, 1]);
    const empties = ops.filter((o) => o.plan.kind === "detach" && o.plan.purpose === "empty");
    assert.equal(empties.length, 2, "Scout ends with 0 extra containers after the hand-off, so it gets 2 empties");
    assert.ok(empties.every((o) => o.plan.probeId === 1));
    const refuel = ops.find((o) => o.plan.kind === "refuel");
    assert.ok(refuel);
    assert.equal(refuel!.plan.kind === "refuel" && refuel!.plan.amount, 39.99, "capped by the station's 60% floor (100 - 60 - 0.01)");
  } finally {
    await mock.close();
  }
});

test("Mannies are never handed over, and a moving Hauler only gets its safety rules", async () => {
  const { mock, poller } = await setup();
  try {
    const snap = docked(poller.snapshot);
    const scout = snap.probes[1].detail as Probe;
    scout.inventory!.containers.push(box("container-new", "Hold B", "container", 0.25, 0));
    scout.inventory!.items.push({ id: "mny-in-box", type: "manny", name: "Stowaway", containerSpace: 0.05, container: { id: "container-full", kind: "container", label: "Hold A", sortOrder: 1 } });
    let ops = planService({ snapshot: snap, data: data(), handoffs: [], busy: new Set(), recentRefuels: new Set() });
    assert.ok(!ops.some((o) => o.plan.kind === "detach" && o.plan.containerId === "container-full"), "a container holding a Manny stays");
    const rules = ops.find((o) => o.plan.kind === "rules" && o.plan.containerId === "container-new");
    assert.ok(rules && rules.plan.kind === "rules" && rules.plan.rules.strictExclusion?.includes("manny"));

    scout.status = "cruising";
    ops = planService({ snapshot: snap, data: data(), handoffs: [], busy: new Set(), recentRefuels: new Set() });
    assert.deepEqual(ops.map((o) => o.plan.kind), ["rules"]);
  } finally {
    await mock.close();
  }
});

test("a docked Tanker tops the station up but keeps its own reserve", async () => {
  const { mock, poller } = await setup();
  try {
    const snap = docked(poller.snapshot);
    (snap.probes[0].detail as Probe).fuel.deuterium = 40;
    const tanker = snap.probes[1].detail as Probe;
    tanker.fuel = { deuterium: 300, maxDeuterium: 400 };
    const ops = planService({ snapshot: snap, data: data({}, "Tanker"), handoffs: [], busy: new Set(), recentRefuels: new Set() });
    const r = ops.find((o) => o.plan.kind === "refuel");
    assert.ok(r && r.plan.kind === "refuel");
    assert.deepEqual([r.plan.probeId, r.plan.targetProbeId, r.plan.amount], [2, 1, 60]);
    assert.ok(!ops.some((o) => o.plan.kind === "detach"), "tankers don't swap containers");
  } finally {
    await mock.close();
  }
});

test("hand-offs: sent with attach_to_probe, tracked to arrival, recovered if left in the sector", async () => {
  const { mock, game, poller } = await setup();
  try {
    const dir = await mkdtemp(path.join(tmpdir(), "panel-"));
    let snap = docked(poller.snapshot);
    const stations = new Stations(game, dir, { setRole: async () => {}, snapshot: () => snap, mode: () => "auto" });
    await stations.load();
    await stations.makeStation(1);
    await stations.setMember(2, 1, "Hauler");
    await stations.onSnapshot(snap);
    const detach = mock.posts().find((p) => p.path === "/api/probe/2/mannies/mny_s1/detach-storage-container" || /\/api\/probe\/2\/mannies\/.+\/detach-storage-container/.test(p.path));
    assert.deepEqual(detach?.body, { containerId: "container-full", mode: "attach_to_probe", objectId: "1" });
    assert.ok(mock.posts().some((p) => /transfer-deuterium-to-probe$/.test(p.path)));
    const h = stations.handoffs.find((x) => x.containerId === "container-full")!;
    assert.equal(h.state, "sent");

    // Left drifting: a new detached container appears in the station's sector → the station recovers it.
    snap = structuredClone(snap);
    (snap.probes[1].detail as Probe).inventory!.containers.splice(1, 1);
    snap.probes[0].sector = { ...(snap.probes[0].sector ?? {}), objects: [{ id: "detached-1", type: "detached_container", name: "Hold A", summary: "" }] } as never;
    clearOrders();
    await stations.onSnapshot(snap);
    assert.ok(mock.posts().some((p) => /\/api\/probe\/1\/mannies\/.+\/recover-storage-container$/.test(p.path) && (p.body as { objectId: string }).objectId === "detached-1"));
    assert.equal(stations.handoffs.find((x) => x.containerId === "container-full")!.state, "recovering");

    // It shows up in the station's inventory: done.
    const after = structuredClone(snap);
    (after.probes[0].detail as Probe).inventory!.containers.push(box("container-full", "Hold A", "container", 0.25, 0.24));
    const changes = trackHandoffs(after, stations.handoffs as Handoff[], Date.now());
    assert.ok(changes.some((c) => c.h.containerId === "container-full" && c.h.state === "done"));
  } finally {
    await mock.close();
  }
});

test("a container held by a craft gets its reservation moved, then the hand-off is retried", async () => {
  const mock = await startMock(0, { fail: { "/detach-storage-container": { status: 409, code: "storage_container_reserved" } } });
  try {
    clearOrders();
    const game = new Game(mock.url, "vng_mock", new RateLimiter(0.3));
    const poller = new Poller(game, { minIntervalMs: 1000, maxIntervalMs: 60_000 });
    await poller.pollOnce();
    const snap = docked(poller.snapshot);
    const dir = await mkdtemp(path.join(tmpdir(), "panel-"));
    const stations = new Stations(game, dir, { setRole: async () => {}, snapshot: () => snap, mode: () => "auto" });
    await stations.load();
    await stations.makeStation(1);
    await stations.setMember(2, 1, "Hauler");
    await stations.onSnapshot(snap);
    const paths = mock.posts().map((p) => p.path);
    const i = paths.findIndex((p) => p.endsWith("container-full/crafting-reservations/reassign"));
    assert.ok(i > 0, "reassign was called");
    assert.ok(paths.slice(i + 1).some((p) => p.endsWith("/detach-storage-container")), "then the detach was retried");
    assert.ok(stations.log.some((e) => !e.ok && /retrying in 10 min/.test(e.message ?? "")), "still refused: logged, backed off");
  } finally {
    await mock.close();
  }
});

test("group probes with a printer build Mannies for a short station, borrow station Mannies, and send new ones home", async () => {
  const { planHelpers, helperGoals } = await import("../src/server/production.ts");
  const { mock, poller } = await setup();
  try {
    const snap = docked(poller.snapshot);
    const [sv, hv] = snap.probes;
    const mk = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ ...sv.mannies![0], id: `${prefix}${i}`, name: `${prefix}${i}` }));
    sv.mannies = mk("s", 20);
    hv.mannies = mk("h", 6);
    const S = sv.detail as Probe;
    const H = hv.detail as Probe;
    S.inventory!.freeCapacity = 10;
    H.inventory!.capacity = 3;
    H.inventory!.freeCapacity = 2;
    H.inventory!.items = H.inventory!.items.filter((i) => i.type !== "atomic_3d_printer");
    const d = data({ mode: "parts", mannyTarget: 12 });
    const queue = (id: number) => (id === 1 ? [{ id: "q", item: "manny", quantity: 50, once: true, addedAt: "" }] : []);

    let plan = planHelpers(d.stations, d, snap, queue);
    assert.equal(plan.want[1], 50, "a Manny line in the station's own queue counts");
    assert.equal(plan.builders.size, 0);
    assert.match(plan.notes[2], /no atomic printer/);

    H.inventory!.items.push({ id: "printer", type: "atomic_3d_printer", name: "Atomic printer", containerSpace: 0.3 } as never);
    plan = planHelpers(d.stations, d, snap, queue);
    assert.equal(plan.builders.get(2), 1);
    assert.equal(helperGoals(plan, snap)["2"][0].quantity, 7, "one Manny at a time: always one more than it has");
    assert.equal(planHelpers(d.stations, d, snap, () => []).builders.size, 0, "20 Mannies already meet the station's target of 12");
    assert.equal(planHelpers([{ ...d.stations[0], helperBuilds: false }], d, snap, queue).builders.size, 0, "switched off");

    let ops = planService({ snapshot: snap, data: d, handoffs: [], busy: new Set(), recentRefuels: new Set(), helpers: plan });
    const lend = ops.find((o) => o.plan.kind === "manny_move");
    assert.ok(lend && lend.plan.kind === "manny_move" && lend.plan.probeId === 1 && lend.plan.targetProbeId === 2, "the station lends a Manny");

    hv.mannies = mk("h", 13); // 6 Hauler + 6 lent + 1 just built
    ops = planService({ snapshot: snap, data: d, handoffs: [], busy: new Set(), recentRefuels: new Set(), helpers: plan });
    const home = ops.find((o) => o.plan.kind === "manny_move");
    assert.ok(home && home.plan.kind === "manny_move" && home.plan.probeId === 2 && home.plan.targetProbeId === 1, "the new Manny goes to the station");

    hv.mannies = mk("h", 12);
    ops = planService({ snapshot: snap, data: d, handoffs: [], busy: new Set(), recentRefuels: new Set(), helpers: plan });
    assert.ok(!ops.some((o) => o.plan.kind === "manny_move"), "at its target: nothing moves either way");
  } finally {
    await mock.close();
  }
});
