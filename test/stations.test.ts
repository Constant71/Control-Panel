import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMock } from "../mock/server.ts";
import { RateLimiter } from "../src/server/rateLimiter.ts";
import { Game, type Schemas } from "../src/server/gameClient.ts";
import { Poller } from "../src/server/poller.ts";
import { Stations, StationError } from "../src/server/stations.ts";
import { exploringProbes } from "../src/server/exploration.ts";
import { DEFAULT_PROBE_SETTINGS, type AutomationSettings, type ProbeRole } from "../src/shared/automation.ts";

async function setup() {
  const mock = await startMock(0);
  const game = new Game(mock.url, "vng_mock", new RateLimiter(0.3));
  const poller = new Poller(game, { minIntervalMs: 1000, maxIntervalMs: 60_000 });
  await poller.pollOnce();
  const roles: Record<number, ProbeRole> = {};
  const dir = await mkdtemp(path.join(tmpdir(), "panel-"));
  const stations = new Stations(game, dir, {
    setRole: async (id, role) => {
      roles[id] = role;
    },
    snapshot: () => poller.snapshot,
  });
  await stations.load();
  return { mock, game, poller, stations, roles, dir };
}

test("making a station sets its role, reads stock against targets and flags what needs attention", async () => {
  const { mock, stations, roles } = await setup();
  try {
    await stations.makeStation(1);
    assert.equal(roles[1], "Station");
    await stations.updateStation(1, {
      targets: [
        { kind: "resource", resource: "metals", min: 1000 },
        { kind: "item", item: "electric_motor", min: 1 },
        { kind: "resource", resource: "bogus" as never, min: 1 },
      ],
    });
    const [s] = stations.status();
    assert.equal(s.isDefault, true);
    const metals = s.targets.find((t) => t.key === "resource:metals")!;
    assert.ok(metals.have !== null && metals.short > 0, "1000 ECE of metals is well above what Prime holds");
    assert.ok(!s.targets.some((t) => t.key === "resource:bogus"), "unknown resources are dropped");
    assert.ok(s.targets.some((t) => t.key === "fuel") && s.targets.some((t) => t.key === "mannies"));
    assert.ok(s.checks.some((c) => c.ok && /Default probe/.test(c.text)));
  } finally {
    await mock.close();
  }
});

test("group roles: in reach can change, out of reach can't, and a station can't join a group", async () => {
  const { mock, stations, roles } = await setup();
  try {
    await stations.makeStation(1);
    await stations.setMember(2, 1, "Hauler");
    assert.equal(roles[2], "Hauler");
    assert.equal(stations.members["2"].role, "Hauler");
    await assert.rejects(stations.setMember(3, 1, "Scout"), (e: unknown) => e instanceof StationError && e.status === 409);
    await stations.setMember(3, 1, null); // joining with no role is fine while out of reach
    assert.equal(stations.members["3"].role, null);
    await assert.rejects(stations.setMember(1, 1, "Hauler"), StationError);

    const [s] = stations.status();
    assert.equal(s.members.length, 2);
    const far = s.members.find((m) => m.probeId === 3)!;
    assert.equal(far.reachable, false);
    assert.ok(far.notes.some((n) => /command range/.test(n)));
    assert.ok(s.checks.some((c) => !c.ok && /out of command range/.test(c.text)));

    await stations.removeStation(1);
    assert.deepEqual(stations.members, {});
    assert.equal(roles[1], "Probe");
    assert.equal(roles[2], "Probe");
  } finally {
    await mock.close();
  }
});

test("Make default probe calls PATCH /api/probe/{id} with isDefault, and explains a 422", async () => {
  const { mock, poller, stations } = await setup();
  try {
    await stations.makeStation(2);
    const r = await stations.makeDefault(2);
    assert.equal(r.ok, true);
    const call = mock.posts().find((p) => p.path === "PATCH /api/probe/2");
    assert.deepEqual(call?.body, { isDefault: true });
    await poller.pollOnce();
    assert.equal(poller.snapshot.defaultProbeId, 2);

    mock.world.summaries[1].isReachable = false;
    const bad = await stations.makeDefault(2);
    assert.equal(bad.ok, false);
    assert.match(bad.message, /same sector|SCUT/);
    assert.equal(stations.log.at(-1)?.ok, false);
  } finally {
    await mock.close();
  }
});

test("a probe that appears in a station's sector joins its group with no role", async () => {
  const { mock, poller, stations } = await setup();
  try {
    await stations.makeStation(1);
    await stations.onSnapshot(poller.snapshot); // learns the existing fleet; nobody joins
    assert.deepEqual(stations.members, {});
    const snap = structuredClone(poller.snapshot);
    const fresh = structuredClone(snap.probes[0]);
    fresh.summary = { ...fresh.summary, id: 9, name: "Newborn", isDefault: false };
    (fresh.detail as Schemas["Probe"]).id = 9;
    snap.probes.push(fresh);
    await stations.onSnapshot(snap);
    assert.deepEqual(stations.members["9"]?.role, null);
    assert.equal(stations.members["9"]?.stationId, 1);
  } finally {
    await mock.close();
  }
});

test("a station is never picked for exploration, even with Explore on", () => {
  const settings: AutomationSettings = {
    mode: "auto", inspectConstructs: true, naming: false, crafting: true, craftQueue: {},
    defaults: { ...DEFAULT_PROBE_SETTINGS }, probes: { "1": { explore: true, role: "Station" }, "2": { explore: true } }, lockedNames: [],
  };
  const probe = (id: number) => ({
    summary: { id, name: `P${id}`, model: "generic", status: "orbiting", isDefault: id === 1, isReachable: true },
    detail: { id, name: `P${id}`, model: "generic", status: "orbiting", fuel: { deuterium: 90 }, sensorMode: "normal" },
    mannies: [], alerts: [], damageWarnings: [], sector: null, errors: [], fetchedAt: "",
  });
  const snap = { probes: [probe(1), probe(2)] } as never;
  assert.deepEqual(exploringProbes(snap, settings).map((v) => v.summary.id), [2]);
});
