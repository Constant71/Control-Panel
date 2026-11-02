import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "../mock/server.ts";
import { RateLimiter } from "../src/server/rateLimiter.ts";
import { Game, type Schemas } from "../src/server/gameClient.ts";
import { Poller, type Snapshot } from "../src/server/poller.ts";
import { planStationMiners } from "../src/server/stationMiner.ts";
import { planService } from "../src/server/stationOps.ts";
import { planDispatch } from "../src/server/dispatch.ts";
import { stationStatus } from "../src/server/stations.ts";
import { clearOrders } from "../src/server/orders.ts";
import { DEFAULT_STATION, type StationsData } from "../src/shared/stations.ts";

type Probe = Schemas["Probe"];
const box = (id: string, kind: "probe" | "container", cap: number, used: number, rules: Schemas["StorageContainerRules"] = {}) => ({
  id, kind, label: id, sortOrder: kind === "probe" ? 0 : 1, capacity: cap, usedCapacity: used, freeCapacity: cap - used,
  capacityUnit: "earth_container_equivalent" as const, rules,
});
const HANDOFF = { priority: ["metals", "ice", "carbon_compounds"], strictExclusion: ["manny"] };

async function setup() {
  clearOrders();
  const mock = await startMock(0);
  const poller = new Poller(new Game(mock.url, "vng_mock", new RateLimiter(0.3)), { minIntervalMs: 1000, maxIntervalMs: 60_000 });
  await poller.pollOnce();
  return { mock, poller };
}

/** Prime is the station (short of ice); Scout is its Miner, docked, with two empty hand-off containers and 3 idle Mannies. */
function world(s: Snapshot): Snapshot {
  const snap = structuredClone(s);
  for (const v of snap.probes) v.mannies = v.mannies?.map((m) => ({ ...m, currentTask: null, task: [], location: { type: "probe", sector: null }, canReceiveOrders: true })) ?? null;
  snap.probes[0].sector = { ...snap.probes[0].sector!, scutCoverageStatus: "covered", scutNetworks: [{ id: 7, name: "Home net" }] };
  snap.probes[1].sector = structuredClone(snap.probes[0].sector);
  snap.probes[1].mannies!.push({ ...snap.probes[1].mannies![0], id: "extra-manny", name: "Extra" });
  const scout = snap.probes[1].detail as Probe;
  delete scout.movement;
  scout.status = "orbiting";
  scout.inventory!.containers = [box("probe-core", "probe", 1, 0.3, { priority: ["manny"] }), box("h1", "container", 0.25, 0, HANDOFF), box("h2", "container", 0.25, 0, HANDOFF)];
  scout.inventory!.freeCapacity = 0.7 + 0.5;
  return snap;
}
const data = (): StationsData => ({
  stations: [{ probeId: 1, ...structuredClone(DEFAULT_STATION), targets: [{ kind: "resource", resource: "ice", min: 5 }], createdAt: "" }],
  members: { "2": { stationId: 1, role: "Miner", joinedAt: "" } }, log: [],
});

test("a Miner mines what the station is short of in the station's sector, keeping one Manny idle", async () => {
  const { mock, poller } = await setup();
  try {
    const snap = world(poller.snapshot);
    const d = data();
    const r = planStationMiners({ snapshot: snap, data: d, status: stationStatus(snap, d), busy: new Set() });
    const mines = r.ops.filter((o) => o.plan.kind === "trip_mine");
    assert.equal(mines.length, 2, "3 idle Mannies, 1 kept back");
    assert.ok(mines.every((o) => o.plan.kind === "trip_mine" && o.plan.resource === "ice" && o.plan.probeId === 2));
    assert.ok(r.noMining.has(2));

    // Nothing short: it waits.
    const met: StationsData = { ...d, stations: [{ ...d.stations[0], targets: [{ kind: "resource", resource: "ice", min: 0.1 }] }] };
    const idle = planStationMiners({ snapshot: snap, data: met, status: stationStatus(snap, met), busy: new Set() });
    assert.equal(idle.ops.length, 0);
    assert.match(idle.notes[1].join(" "), /meets every raw resource target/);
  } finally {
    await mock.close();
  }
});

test("a Miner never goes on trips, hands over full containers like a Hauler, and isn't fuelled by the station", async () => {
  const { mock, poller } = await setup();
  try {
    const snap = world(poller.snapshot);
    const d = data();
    const trips = planDispatch({ snapshot: snap, data: d, status: stationStatus(snap, d), trips: [], handoffs: [], sectors: [
      { sector: { x: 1, y: 1, z: 0 }, scannedAt: "", resources: { ice: 9 }, scutNetworkIds: [7], coverage: "covered", hazards: [] },
    ], costPerSector: {}, busy: new Set(), now: Date.now() });
    assert.ok(!trips.ops.some((o) => o.plan.kind === "trip_move"));

    const scout = snap.probes[1].detail as Probe;
    scout.inventory!.containers[1].usedCapacity = 0.24;
    scout.inventory!.containers[1].freeCapacity = 0.01;
    (snap.probes[0].detail as Probe).inventory!.freeCapacity = 0.9;
    scout.fuel.deuterium = 10;
    const ops = planService({ snapshot: snap, data: d, handoffs: [], busy: new Set(), recentRefuels: new Set() });
    assert.ok(ops.some((o) => o.plan.kind === "detach" && o.plan.containerId === "h1" && o.plan.toProbeId === 1));
    assert.ok(!ops.some((o) => o.plan.kind === "refuel" && o.plan.targetProbeId === 2));
  } finally {
    await mock.close();
  }
});
