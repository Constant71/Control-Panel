import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMock } from "../mock/server.ts";
import { RateLimiter } from "../src/server/rateLimiter.ts";
import { Game, type Schemas } from "../src/server/gameClient.ts";
import { Poller, type Snapshot } from "../src/server/poller.ts";
import { Stations, sectorOf } from "../src/server/stations.ts";
import { dangerReasons, fleeCard } from "../src/server/flee.ts";
import type { SectorKnowledge } from "../src/server/discovery.ts";
import { clearOrders } from "../src/server/orders.ts";
import { DEFAULT_STATION, type StationConfig } from "../src/shared/stations.ts";

type Probe = Schemas["Probe"];
type Alert = Schemas["ProbeDamageWarning"];

async function setup() {
  clearOrders();
  const mock = await startMock(0);
  const game = new Game(mock.url, "vng_mock", new RateLimiter(0.3));
  const poller = new Poller(game, { minIntervalMs: 1000, maxIntervalMs: 60_000 });
  await poller.pollOnce();
  return { mock, game, poller };
}

const alert = (over: Partial<Alert> = {}): Alert => {
  const iso = new Date(Date.now() - 60_000).toISOString();
  return {
    id: 1, type: "others_weapon", status: "unread", message: "A missile has locked onto Prime.", illustrationImageUrl: null, phase: "weapon_targeted",
    scheduledAt: iso, sector: { relative: { x: 0, y: 0, z: 0 } }, createdAt: iso, updatedAt: iso, readAt: null, resolvedAt: null, ...over,
  } as Alert;
};

/** Prime (station) on SCUT network 7, everything aboard, healthy. */
function calm(s: Snapshot): Snapshot {
  const snap = structuredClone(s);
  for (const v of snap.probes) {
    v.mannies = v.mannies?.map((m) => ({ ...m, currentTask: null, task: [], location: { type: "probe", sector: null }, canReceiveOrders: true })) ?? null;
    v.alerts = [];
    v.damageWarnings = [];
  }
  const prime = snap.probes[0].detail as Probe;
  delete prime.movement;
  prime.status = "orbiting";
  prime.systems!.integrityPercent = 95;
  snap.probes[0].sector = { ...snap.probes[0].sector!, objects: [], scutCoverageStatus: "covered", scutNetworks: [{ id: 7, name: "Home net" }] };
  return snap;
}

const cfg = (over: Partial<StationConfig> = {}): StationConfig => ({ probeId: 1, ...structuredClone(DEFAULT_STATION), createdAt: "", ...over });
const SECTORS: SectorKnowledge[] = [
  { sector: { x: 1, y: 1, z: 0 }, scannedAt: "", resources: {}, scutNetworkIds: [7], coverage: "covered", hazards: [] },
  { sector: { x: 1, y: -1, z: 0 }, scannedAt: "", resources: {}, scutNetworkIds: [7], coverage: "covered", hazards: ["black_hole"] },
];

test("danger comes only from the spec's signals: weapon_targeted alerts, targeting missiles, integrity and damage warnings", async () => {
  const { mock, poller } = await setup();
  try {
    const now = Date.now();
    const snap = calm(poller.snapshot);
    const v = snap.probes[0];
    assert.deepEqual(dangerReasons(v, cfg(), now), []);

    v.alerts = [alert()];
    assert.match(dangerReasons(v, cfg(), now).join(" "), /Targeted by a weapon/);
    v.alerts = [alert({ resolvedAt: new Date().toISOString() }), alert({ createdAt: new Date(now - 2 * 86_400_000).toISOString() }), alert({ phase: "weapon" })];
    assert.deepEqual(dangerReasons(v, cfg(), now), [], "resolved, old, or not aimed at us");

    v.alerts = [];
    v.sector!.objects = [{ id: "m1", type: "missile", targetsCurrentProbe: true } as never];
    assert.match(dangerReasons(v, cfg(), now).join(" "), /missile/);

    v.sector!.objects = [];
    (v.detail as Probe).systems!.integrityPercent = 40;
    assert.match(dangerReasons(v, cfg(), now).join(" "), /Integrity 40%/);
    assert.deepEqual(dangerReasons(v, cfg({ fleeIntegrityPercent: 30 }), now), []);
  } finally {
    await mock.close();
  }
});

test("the flee card skips hazard sectors, puts the network first, and names the risks", async () => {
  const { mock, poller } = await setup();
  try {
    const snap = calm(poller.snapshot);
    const v = snap.probes[0];
    assert.equal(fleeCard(v, cfg(), SECTORS, {}, null, snap, Date.now()), null, "no danger, no card");

    v.alerts = [alert()];
    const pos = sectorOf(v)!;
    v.mannies![0] = { ...v.mannies![0], currentTask: "mining", location: { type: "sector", sector: { relative: pos } } };
    const card = fleeCard(v, cfg(), SECTORS, { [(v.detail as Probe).model]: 10 }, null, snap, Date.now())!;
    assert.ok(card.options.length > 0 && card.options.length <= 4);
    assert.deepEqual(card.options[0].target, { x: 1, y: 1, z: 0 }, "the in-network sector comes first");
    assert.ok(!card.options.some((o) => o.target.x === 1 && o.target.y === -1 && o.target.z === 0), "never into the black hole");
    assert.match(card.risks.join(" "), /recalled first/);
    assert.equal(card.fuelCost, 10);
    assert.equal(card.approved, null);
  } finally {
    await mock.close();
  }
});

test("a confirmed flee recalls the local Manny, then moves, then the trips come home to the new sector", async () => {
  const { mock, game, poller } = await setup();
  try {
    let snap = calm(poller.snapshot);
    const dir = await mkdtemp(path.join(tmpdir(), "panel-"));
    const stations = new Stations(game, dir, {
      setRole: async () => {}, snapshot: () => snap, mode: () => "auto", sectors: () => SECTORS, costPerSector: () => ({}),
    });
    await stations.load();
    await stations.makeStation(1);
    await stations.updateStation(1, { service: false, dispatch: false });

    const v = snap.probes[0];
    v.alerts = [alert()];
    const pos = sectorOf(v)!;
    const manny = v.mannies![0];
    v.mannies![0] = { ...manny, currentTask: "mining", location: { type: "sector", sector: { relative: pos } } };
    await stations.onSnapshot(snap);
    const card = stations.status()[0].flee!;
    assert.ok(card && !card.approved);
    assert.ok(!mock.posts().some((p) => /\/move$/.test(p.path)), "nothing moves without you");

    await assert.rejects(stations.confirmFlee(1, { x: 9, y: 9, z: 9 }), /Pick one of the destinations/);
    await stations.confirmFlee(1, { x: 1, y: 1, z: 0 });

    await stations.onSnapshot(snap);
    assert.ok(mock.posts().some((p) => p.path === `/api/probe/1/mannies/${manny.id}/recall`));
    assert.ok(!mock.posts().some((p) => p.path === "/api/probe/1/move"), "waits for the Manny");

    snap = calm(poller.snapshot);
    snap.probes[0].alerts = [alert()];
    await stations.onSnapshot(snap);
    const move = mock.posts().find((p) => p.path === "/api/probe/1/move");
    assert.deepEqual(move?.body, { target: { x: 1, y: 1, z: 0 } });
    assert.equal(stations.status()[0].flee?.approved?.state, "moving");

    stations.trips.push({
      id: "t", stationId: 1, haulerId: 2, target: { x: 2, y: 0, z: 0 }, home: pos, resource: "ice", reason: "", state: "mining",
      startedAt: "", updatedAt: "", arrivedAt: null, note: null,
    });
    snap = calm(poller.snapshot);
    (snap.probes[0].detail as Probe).sector = { relative: { x: 1, y: 1, z: 0 } };
    await stations.onSnapshot(snap);
    assert.equal(stations.status()[0].flee, null, "arrived and no danger left");
    assert.deepEqual(stations.trips[0].home, { x: 1, y: 1, z: 0 });
  } finally {
    await mock.close();
  }
});
