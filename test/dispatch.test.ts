import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMock } from "../mock/server.ts";
import { RateLimiter } from "../src/server/rateLimiter.ts";
import { Game, type Schemas } from "../src/server/gameClient.ts";
import { Poller, type Snapshot } from "../src/server/poller.ts";
import { Stations, stationStatus } from "../src/server/stations.ts";
import { planDispatch } from "../src/server/dispatch.ts";
import type { SectorKnowledge } from "../src/server/discovery.ts";
import { clearOrders } from "../src/server/orders.ts";
import { DEFAULT_STATION, type StationConfig, type StationsData, type Trip } from "../src/shared/stations.ts";

type Probe = Schemas["Probe"];
const box = (id: string, kind: "probe" | "container", cap: number, used: number, rules: Schemas["StorageContainerRules"] = {}) => ({
  id, kind, label: id, sortOrder: kind === "probe" ? 0 : 1, capacity: cap, usedCapacity: used, freeCapacity: cap - used,
  capacityUnit: "earth_container_equivalent" as const, rules,
});
const HANDOFF = { priority: ["metals", "ice", "carbon_compounds"], strictExclusion: ["manny"] };

async function setup() {
  clearOrders();
  const mock = await startMock(0);
  const game = new Game(mock.url, "vng_mock", new RateLimiter(0.3));
  const poller = new Poller(game, { minIntervalMs: 1000, maxIntervalMs: 60_000 });
  await poller.pollOnce();
  return { mock, game, poller };
}

/** Prime is the station and default probe on SCUT network 7; Scout is a docked Hauler with two empty hand-off containers. */
function world(s: Snapshot): Snapshot {
  const snap = structuredClone(s);
  for (const v of snap.probes) v.mannies = v.mannies?.map((m) => ({ ...m, currentTask: null, task: [], location: { type: "probe", sector: null }, canReceiveOrders: true })) ?? null;
  snap.probes[0].sector = { ...snap.probes[0].sector!, scutCoverageStatus: "covered", scutNetworks: [{ id: 7, name: "Home net" }] };
  const scout = snap.probes[1].detail as Probe;
  delete scout.movement;
  scout.status = "orbiting";
  scout.fuel.deuterium = 90;
  scout.systems!.integrityPercent = 90;
  scout.inventory!.containers = [box("probe-core", "probe", 1, 0.3, { priority: ["manny"] }), box("h1", "container", 0.25, 0, HANDOFF), box("h2", "container", 0.25, 0, HANDOFF)];
  scout.inventory!.freeCapacity = 0.7 + 0.5;
  return snap;
}

const SECTORS: SectorKnowledge[] = [
  { sector: { x: 2, y: 0, z: 0 }, scannedAt: "", resources: { ice: 9 }, scutNetworkIds: [9], coverage: "covered", hazards: [] },
  { sector: { x: -1, y: 1, z: 0 }, scannedAt: "", resources: { ice: 9 }, scutNetworkIds: [7], coverage: "covered", hazards: ["black_hole"] },
  { sector: { x: 1, y: 1, z: 0 }, scannedAt: "", resources: { ice: 2 }, scutNetworkIds: [7], coverage: "covered", hazards: [] },
];
const cfg = (over: Partial<StationConfig> = {}): StationConfig => ({
  probeId: 1, ...structuredClone(DEFAULT_STATION), targets: [{ kind: "resource", resource: "ice", min: 5 }], createdAt: "", ...over,
});
const data = (over: Partial<StationConfig> = {}): StationsData => ({ stations: [cfg(over)], members: { "2": { stationId: 1, role: "Hauler", joinedAt: "" } }, log: [] });

function plan(snap: Snapshot, d: StationsData, trips: Trip[] = [], cost: Record<string, number> = { generic: 10 }, now = Date.now()) {
  return planDispatch({ snapshot: snap, data: d, status: stationStatus(snap, d), trips, handoffs: [], sectors: SECTORS, costPerSector: cost, busy: new Set(), now });
}

test("a station short of ice sends its docked Hauler to the nearest safe sector on the network", async () => {
  const { mock, poller } = await setup();
  try {
    const snap = world(poller.snapshot);
    const r = plan(snap, data());
    assert.equal(r.ops.length, 1);
    const op = r.ops[0];
    assert.ok(op.plan.kind === "trip_move" && op.plan.leg === "out");
    assert.deepEqual(op.plan.kind === "trip_move" && op.plan.target, { x: 1, y: 1, z: 0 }, "not the black-hole sector, not the other network");
    assert.match(op.why, /ice 0\.388 \/ 5 ECE/);
    assert.ok(r.noMining.has(2));
  } finally {
    await mock.close();
  }
});

test("no trip without a network, without fuel, or while Mannies are out", async () => {
  const { mock, poller } = await setup();
  try {
    let snap = world(poller.snapshot);
    snap.probes[0].sector!.scutNetworks = [];
    let r = plan(snap, data());
    assert.equal(r.ops.length, 0);
    assert.match(r.notes[1].join(" "), /SCUT network/);

    snap = world(poller.snapshot);
    (snap.probes[1].detail as Probe).fuel.deuterium = 30; // 30 - 20 < 20% margin
    r = plan(snap, data());
    assert.equal(r.ops.length, 0);
    assert.match(r.notes[1].join(" "), /round trip costs about 20/);

    r = plan(world(poller.snapshot), data(), [], {}); // move cost unknown, 90% is enough
    assert.equal(r.ops.length, 1);

    snap = world(poller.snapshot);
    snap.probes[1].mannies![0] = { ...snap.probes[1].mannies![0], currentTask: "mining", location: { type: "sector", sector: { relative: { x: 0, y: 0, z: 0 } } } };
    r = plan(snap, data());
    assert.equal(r.ops.length, 0);
    assert.match(r.notes[1].join(" "), /once its 1 busy Manny is done/);
    assert.ok(r.noMining.has(2), "no new mining while it waits to leave");
  } finally {
    await mock.close();
  }
});

test("a trip mines the resource, waits for its Mannies, flies home, and ends after the hand-over", async () => {
  const { mock, poller } = await setup();
  try {
    const now = Date.now();
    const iso = new Date(now - 60_000).toISOString();
    const trip: Trip = {
      id: "t1", stationId: 1, haulerId: 2, target: { x: 1, y: 1, z: 0 }, home: { x: 0, y: 0, z: 0 }, resource: "ice", reason: "ice 0.4 / 5 ECE",
      state: "outbound", startedAt: iso, updatedAt: iso, arrivedAt: null, note: null,
    };
    const snap = world(poller.snapshot);
    const scout = snap.probes[1].detail as Probe;
    scout.sector = { relative: { x: 1, y: 1, z: 0 } };
    snap.probes[1].sector = structuredClone(mock.world.sector); // the mock sector has an ice asteroid
    let r = plan(snap, data(), [trip]);
    assert.equal(trip.state, "mining");

    r = plan(snap, data(), [trip]);
    const mines = r.ops.filter((o) => o.plan.kind === "trip_mine");
    assert.equal(mines.length, 1, "Scout has 2 Mannies and keeps 1 idle");
    assert.ok(mines[0].plan.kind === "trip_mine" && mines[0].plan.resource === "ice" && mines[0].plan.objectId === "asteroid-ice-1");

    scout.inventory!.containers[1].usedCapacity = 0.25;
    scout.inventory!.containers[2].usedCapacity = 0.2;
    snap.probes[1].mannies![0] = { ...snap.probes[1].mannies![0], currentTask: "returning", location: { type: "sector", sector: { relative: { x: 1, y: 1, z: 0 } } } };
    r = plan(snap, data(), [trip]);
    assert.ok(!r.ops.some((o) => o.plan.kind === "trip_move"));
    assert.match(trip.note ?? "", /Waiting for 1 Manny/);

    snap.probes[1].mannies![0] = { ...snap.probes[1].mannies![0], currentTask: null, location: { type: "probe", sector: null } };
    r = plan(snap, data(), [trip]);
    const home = r.ops.find((o) => o.plan.kind === "trip_move");
    assert.ok(home && home.plan.kind === "trip_move" && home.plan.leg === "home");

    trip.state = "returning";
    scout.sector = { relative: { x: 0, y: 0, z: 0 } };
    plan(snap, data(), [trip]);
    assert.equal(trip.state, "handing_over");
    scout.inventory!.containers.splice(1, 2);
    plan(snap, data(), [trip]);
    assert.equal(trip.state, "done");
  } finally {
    await mock.close();
  }
});

test("Stations sends the trip move and records the trip; the regular automation is told to hold", async () => {
  const { mock, game, poller } = await setup();
  try {
    const snap = world(poller.snapshot);
    const dir = await mkdtemp(path.join(tmpdir(), "panel-"));
    let held: Set<number> = new Set();
    const stations = new Stations(game, dir, {
      setRole: async () => {}, snapshot: () => snap, mode: () => "auto", sectors: () => SECTORS, costPerSector: () => ({ generic: 10 }),
      hold: (_x, noMining) => { held = noMining; },
    });
    await stations.load();
    await stations.makeStation(1);
    await stations.updateStation(1, { targets: [{ kind: "resource", resource: "ice", min: 5 }] });
    await stations.setMember(2, 1, "Hauler");
    await stations.onSnapshot(snap);
    const move = mock.posts().find((p) => p.path === "/api/probe/2/move");
    assert.deepEqual(move?.body, { target: { x: 1, y: 1, z: 0 } });
    assert.equal(stations.trips.length, 1);
    assert.equal(stations.trips[0].state, "outbound");
    assert.ok(held.has(2));
    assert.ok(!mock.posts().some((p) => /transfer-deuterium-to-probe$/.test(p.path) && (p.body as { targetProbeId: number }).targetProbeId === 2),
      "no refuel is started on a Hauler that is leaving");
  } finally {
    await mock.close();
  }
});
