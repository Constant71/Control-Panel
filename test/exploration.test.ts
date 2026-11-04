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
import { planExploration, fccNeighbors, fccDistance, vkey } from "../src/server/exploration.ts";
import { clearOrders } from "../src/server/orders.ts";
import { DEFAULT_PROBE_SETTINGS, type AutomationSettings } from "../src/shared/automation.ts";

const settings = (probes: AutomationSettings["probes"]): AutomationSettings => ({
  mode: "auto", inspectConstructs: true, naming: false, crafting: true, craftQueue: {},
  defaults: { ...DEFAULT_PROBE_SETTINGS, exploreDwellMinutes: 0 }, probes, lockedNames: [],
});

async function setup() {
  clearOrders();
  const mock = await startMock(0);
  const game = new Game(mock.url, "vng_mock", new RateLimiter(0.3));
  const poller = new Poller(game, { minIntervalMs: 1000, maxIntervalMs: 60_000 });
  await poller.pollOnce();
  return { mock, game, poller };
}

/** Every Manny aboard and idle; Scout parked next to Prime with a full tank. */
function parked(s: Snapshot): Snapshot {
  const snap = structuredClone(s);
  for (const v of snap.probes) {
    v.mannies = v.mannies?.map((m) => ({ ...m, currentTask: null, task: [], location: { type: "probe", sector: null }, canReceiveOrders: true })) ?? null;
  }
  const scout = snap.probes[1].detail as Schemas["Probe"];
  delete scout.movement;
  scout.status = "orbiting";
  scout.fuel.deuterium = 90;
  scout.systems!.integrityPercent = 90;
  return snap;
}

function scansFor(mock: Awaited<ReturnType<typeof startMock>>) {
  return Object.fromEntries(fccNeighbors({ x: 0, y: 0, z: 0 }).map((n) => [vkey(n), mock.world.neighborScan(n)]));
}

test("FCC grid: 12 neighbours with even coordinate sums", () => {
  const n = fccNeighbors({ x: 0, y: 0, z: 0 });
  assert.equal(n.length, 12);
  assert.equal(new Set(n.map(vkey)).size, 12);
  assert.ok(n.every((v) => (v.x + v.y + v.z) % 2 === 0 && fccDistance({ x: 0, y: 0, z: 0 }, v) === 1));
  assert.equal(fccDistance({ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }), 2);
});

test("a move that would leave command range becomes a confirm card, and picks the best safe neighbour", async () => {
  const { mock, poller } = await setup();
  try {
    const r = planExploration({
      snapshot: parked(poller.snapshot), settings: settings({ "1": { explore: true } }), scans: scansFor(mock),
      settledSince: {}, costPerSector: {}, inspected: new Set(["construct-home"]), now: Date.now(),
    });
    assert.equal(r.moves.length, 0, "Prime is the default probe and SCUT coverage is unknown: no automatic move");
    assert.equal(r.suggestions.length, 1);
    const s = r.suggestions[0];
    assert.deepEqual(s.target, { x: 1, y: -1, z: 0 }, "the star with planets, not the black-hole sector");
    assert.ok(s.risks.some((x) => /command range/.test(x)));
    assert.equal(r.status[0].state, "needs_you");
  } finally {
    await mock.close();
  }
});

test("constructs come first; after your OK, Mannies come home and mining stops until it leaves", async () => {
  const { mock, poller } = await setup();
  try {
    const snap = parked(poller.snapshot);
    const base = { settings: settings({ "1": { explore: true } }), scans: scansFor(mock), settledSince: {}, costPerSector: {}, now: Date.now() };
    let r = planExploration({ ...base, snapshot: snap, inspected: new Set() });
    assert.equal(r.status[0].state, "dwelling");
    assert.match(r.status[0].text, /dormant construct/);

    snap.probes[0].mannies![0].location = { type: "sector", sector: { relative: { x: 0, y: 0, z: 0 } } };
    snap.probes[0].mannies![0].currentTask = "mining";
    r = planExploration({ ...base, snapshot: snap, inspected: new Set(["construct-home"]) });
    assert.equal(r.status[0].state, "needs_you");
    assert.ok(!r.departing.has(1), "while waiting for your OK, the probe keeps working");

    r = planExploration({ ...base, snapshot: snap, inspected: new Set(["construct-home"]), approved: { "1": { key: "1,-1,0", at: new Date().toISOString() } } });
    assert.equal(r.status[0].state, "recalling");
    assert.equal(r.suggestions.length, 0);
    assert.ok(r.departing.has(1));
    const plan = planAll({ snapshot: snap, settings: base.settings, inspected: new Set(["construct-home"]), busy: new Set(), departing: r.departing });
    assert.equal(plan.actions.filter((a) => a.plan.kind === "mine" && a.plan.probeId === 1).length, 0, "no new mining while departing");
  } finally {
    await mock.close();
  }
});

test("an in-range, safe move runs on its own; the fuel floor blocks it", async () => {
  const { mock, poller } = await setup();
  try {
    const snap = parked(poller.snapshot);
    snap.probes[0].sector!.scutNetworks = [{ id: 7, name: "Home net" }];
    const scans = scansFor(mock);
    scans["1,-1,0"] = { ...scans["1,-1,0"], scutCoverageStatus: "covered", scutNetworks: [{ id: 7, name: "Home net" }] };
    const input = {
      snapshot: snap, settings: settings({ "2": { explore: true } }), scans, settledSince: {}, costPerSector: { generic: 20 },
      inspected: new Set<string>(), now: Date.now(),
    };
    let r = planExploration(input);
    assert.deepEqual(r.moves.map((m) => [m.probeId, m.target]), [[2, { x: 1, y: -1, z: 0 }]]);

    (snap.probes[1].detail as Schemas["Probe"]).fuel.deuterium = 60; // 60 - 20 < 50% floor
    r = planExploration(input);
    assert.equal(r.moves.length, 0);
    assert.match(r.status[0].text, /floor/);
  } finally {
    await mock.close();
  }
});

test("confirming a move card sends POST /move with the target", async () => {
  const { mock, game, poller } = await setup();
  try {
    const dir = await mkdtemp(path.join(tmpdir(), "panel-"));
    const auto = new Automation(game, dir, () => {});
    await auto.load();
    await auto.updateSettings({ mode: "auto", inspectConstructs: false, probes: { "1": { explore: true, exploreDwellMinutes: 0, mining: false } } });
    await auto.onSnapshot(parked(poller.snapshot));
    assert.ok(mock.posts().every((p) => !p.path.endsWith("/move")), "nothing moves without confirmation");
    const card = auto.suggestions.find((s) => s.kind === "move_probe");
    assert.ok(card, "the neighbour scans were fetched and a card made");
    const entry = await auto.confirmSuggestion(card!.id);
    assert.equal(entry.ok, true);
    assert.match(entry.message ?? "", /every Manny is aboard/);
    await auto.onSnapshot(parked(poller.snapshot));
    const move = mock.posts().find((p) => p.path === "/api/probe/1/move");
    assert.deepEqual(move?.body, { target: { x: 1, y: -1, z: 0 } });
  } finally {
    await mock.close();
  }
});

test("a Scout explores without the Explore box ticked", async () => {
  const { mock, poller } = await setup();
  try {
    const snap = parked(poller.snapshot);
    snap.probes[0].sector!.scutNetworks = [{ id: 7, name: "Home net" }];
    const scans = scansFor(mock);
    scans["1,-1,0"] = { ...scans["1,-1,0"], scutCoverageStatus: "covered", scutNetworks: [{ id: 7, name: "Home net" }] };
    const r = planExploration({
      snapshot: snap, settings: settings({ "2": { role: "Scout" } }), scans, settledSince: {}, costPerSector: { generic: 20 },
      inspected: new Set<string>(), now: Date.now(),
    });
    assert.deepEqual(r.moves.map((m) => m.probeId), [2]);
  } finally {
    await mock.close();
  }
});
