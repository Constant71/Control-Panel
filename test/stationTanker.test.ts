import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "../mock/server.ts";
import { RateLimiter } from "../src/server/rateLimiter.ts";
import { Game, type Schemas } from "../src/server/gameClient.ts";
import { Poller, type Snapshot } from "../src/server/poller.ts";
import { planStationTankers } from "../src/server/stationTanker.ts";
import { planService } from "../src/server/stationOps.ts";
import type { SectorKnowledge } from "../src/server/discovery.ts";
import { clearOrders } from "../src/server/orders.ts";
import { DEFAULT_STATION, type StationsData, type Trip } from "../src/shared/stations.ts";

type Probe = Schemas["Probe"];

async function setup() {
  clearOrders();
  const mock = await startMock(0);
  const poller = new Poller(new Game(mock.url, "vng_mock", new RateLimiter(0.3)), { minIntervalMs: 1000, maxIntervalMs: 60_000 });
  await poller.pollOnce();
  return { mock, poller };
}

/** Prime is the station (default probe, network 7); Scout is its Station Tanker, docked, everyone aboard. */
function world(s: Snapshot, deuteriumAtHome: boolean): Snapshot {
  const snap = structuredClone(s);
  for (const v of snap.probes) v.mannies = v.mannies?.map((m) => ({ ...m, currentTask: null, task: [], location: { type: "probe", sector: null }, canReceiveOrders: true })) ?? null;
  const sector = { ...snap.probes[0].sector!, scutCoverageStatus: "covered" as const, scutNetworks: [{ id: 7, name: "Home net" }] };
  if (!deuteriumAtHome) sector.objects = (sector.objects ?? []).filter((o) => !JSON.stringify(o).includes("deuterium"));
  snap.probes[0].sector = sector;
  snap.probes[1].sector = structuredClone(sector);
  const prime = snap.probes[0].detail as Probe;
  prime.fuel.deuterium = 50;
  prime.fuel.maxDeuterium = 100;
  const scout = snap.probes[1].detail as Probe;
  delete scout.movement;
  scout.status = "orbiting";
  scout.fuel.deuterium = 300;
  scout.fuel.maxDeuterium = 400;
  scout.systems!.integrityPercent = 90;
  return snap;
}
const data = (): StationsData => ({
  stations: [{ probeId: 1, ...structuredClone(DEFAULT_STATION), createdAt: "" }],
  members: { "2": { stationId: 1, role: "StationTanker", joinedAt: "" } }, log: [],
});
const SECTORS: SectorKnowledge[] = [
  { sector: { x: 1, y: 1, z: 0 }, scannedAt: "", resources: { deuterium: 3 }, scutNetworkIds: [7], coverage: "covered", hazards: [] },
  { sector: { x: 1, y: 0, z: 1 }, scannedAt: "", resources: { deuterium: 9 }, scutNetworkIds: [7], coverage: "covered", hazards: ["black_hole"] },
];
const plan = (snap: Snapshot, trips: Trip[] = [], opts: { cost?: Record<string, number>; refuels?: Set<string>; now?: number } = {}) =>
  planStationTankers({
    snapshot: snap, data: data(), trips, sectors: SECTORS, costPerSector: opts.cost ?? { generic: 10 }, busy: new Set(),
    recentRefuels: opts.refuels ?? new Set(), now: opts.now ?? Date.now(),
  });

test("with deuterium at home, the Station Tanker gives the station everything and mines more, and never leaves", async () => {
  const { mock, poller } = await setup();
  try {
    const snap = world(poller.snapshot, true);
    const r = plan(snap);
    const give = r.ops.find((o) => o.plan.kind === "refuel");
    assert.ok(give && give.plan.kind === "refuel" && give.plan.probeId === 2 && give.plan.targetProbeId === 1);
    assert.equal(give.plan.kind === "refuel" && give.plan.amount, 50, "fills the station to full");
    const mines = r.ops.filter((o) => o.plan.kind === "trip_mine");
    assert.ok(mines.length >= 1 && mines.every((o) => o.plan.kind === "trip_mine" && o.plan.resource === "deuterium"));
    assert.ok(!r.ops.some((o) => o.plan.kind === "trip_move"));
    assert.ok(r.noMining.has(2), "the regular mining automation leaves it alone");

    // An emptier station gets all but 1 point (the transfer must stay below the tanker's deuterium).
    (snap.probes[1].detail as Probe).fuel.deuterium = 20;
    const all = plan(snap).ops.find((o) => o.plan.kind === "refuel");
    assert.equal(all?.plan.kind === "refuel" && all.plan.amount, 19);

    // Full station: nothing to give, still mining toward a full tank.
    (snap.probes[0].detail as Probe).fuel.deuterium = 100;
    const idle = plan(snap);
    assert.ok(!idle.ops.some((o) => o.plan.kind === "refuel") && idle.ops.some((o) => o.plan.kind === "trip_mine"));
  } finally {
    await mock.close();
  }
});

test("the station never fuels its Station Tanker", async () => {
  const { mock, poller } = await setup();
  try {
    const snap = world(poller.snapshot, true);
    (snap.probes[0].detail as Probe).fuel.deuterium = 100;
    (snap.probes[1].detail as Probe).fuel.deuterium = 5;
    const ops = planService({ snapshot: snap, data: data(), handoffs: [], busy: new Set(), recentRefuels: new Set() });
    assert.ok(!ops.some((o) => o.plan.kind === "refuel"));
  } finally {
    await mock.close();
  }
});

test("without deuterium at home it keeps 20%, then flies to the nearest safe deuterium sector to collect", async () => {
  const { mock, poller } = await setup();
  try {
    const snap = world(poller.snapshot, false);
    let r = plan(snap);
    const give = r.ops.find((o) => o.plan.kind === "refuel");
    assert.equal(give?.plan.kind === "refuel" && give.plan.amount, 50, "plenty above the 80-point reserve");
    assert.ok(!r.ops.some((o) => o.plan.kind === "trip_move"), "doesn't leave while it still has fuel to give");

    (snap.probes[1].detail as Probe).fuel.deuterium = 80.5; // 20% of 400 = 80 kept
    r = plan(snap);
    assert.ok(!r.ops.some((o) => o.plan.kind === "refuel"));
    const out = r.ops.find((o) => o.plan.kind === "trip_move");
    assert.ok(out && out.plan.kind === "trip_move" && out.plan.leg === "out" && out.plan.tripKind === "deuterium");
    assert.deepEqual(out.plan.kind === "trip_move" && out.plan.target, { x: 1, y: 1, z: 0 }, "not the black-hole sector");

    // A round trip costing more than 20% raises the reserve.
    (snap.probes[1].detail as Probe).fuel.deuterium = 120;
    r = plan(snap, [], { cost: { generic: 60 } });
    const g2 = r.ops.find((o) => o.plan.kind === "refuel");
    assert.ok(!g2, "120 fuel is below the 121 needed for the 120-point round trip, so nothing is given");

    // A Manny out: waits.
    (snap.probes[1].detail as Probe).fuel.deuterium = 80.5;
    snap.probes[1].mannies![0] = { ...snap.probes[1].mannies![0], currentTask: "mining", location: { type: "sector", sector: { relative: { x: 0, y: 0, z: 0 } } } };
    r = plan(snap);
    assert.ok(!r.ops.some((o) => o.plan.kind === "trip_move"));
    assert.match(r.notes[1].join(" "), /once its 1 busy Manny is aboard/);
  } finally {
    await mock.close();
  }
});

test("a collecting trip mines deuterium until the tank is full, waits for its Mannies, and comes home", async () => {
  const { mock, poller } = await setup();
  try {
    const now = Date.now();
    const iso = new Date(now - 60_000).toISOString();
    const snap = world(poller.snapshot, false);
    const scout = snap.probes[1].detail as Probe;
    scout.sector = { relative: { x: 1, y: 1, z: 0 } };
    snap.probes[1].sector = structuredClone(mock.world.sector); // has a deuterium asteroid
    scout.fuel.deuterium = 70;
    const trip: Trip = {
      id: "d1", stationId: 1, haulerId: 2, target: { x: 1, y: 1, z: 0 }, home: { x: 0, y: 0, z: 0 }, resource: "deuterium", reason: "Prime at 50% fuel",
      state: "outbound", startedAt: iso, updatedAt: iso, arrivedAt: null, note: null, kind: "deuterium",
    };
    plan(snap, [trip], { now });
    assert.equal(trip.state, "mining");
    let r = plan(snap, [trip], { now });
    assert.ok(r.ops.some((o) => o.plan.kind === "trip_mine" && o.plan.resource === "deuterium" && o.plan.tripId === "d1"));
    assert.ok(!r.ops.some((o) => o.plan.kind === "refuel"), "no giving away from home");

    scout.fuel.deuterium = 399;
    snap.probes[1].mannies![0] = { ...snap.probes[1].mannies![0], currentTask: "returning", location: { type: "sector", sector: { relative: { x: 1, y: 1, z: 0 } } } };
    r = plan(snap, [trip], { now });
    assert.ok(!r.ops.some((o) => o.plan.kind === "trip_move"));
    assert.match(trip.note ?? "", /Waiting for 1 Manny/);

    snap.probes[1].mannies![0] = { ...snap.probes[1].mannies![0], currentTask: null, location: { type: "probe", sector: null } };
    r = plan(snap, [trip], { now });
    const home = r.ops.find((o) => o.plan.kind === "trip_move");
    assert.ok(home && home.plan.kind === "trip_move" && home.plan.leg === "home");

    trip.state = "returning";
    scout.sector = { relative: { x: 0, y: 0, z: 0 } };
    plan(snap, [trip], { now });
    assert.equal(trip.state, "done");
  } finally {
    await mock.close();
  }
});
