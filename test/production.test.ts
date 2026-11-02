import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "../mock/server.ts";
import { RateLimiter } from "../src/server/rateLimiter.ts";
import { Game, type Schemas } from "../src/server/gameClient.ts";
import { Poller, type Snapshot } from "../src/server/poller.ts";
import { planAll } from "../src/server/automation.ts";
import { productionGoals, toCraftGoals } from "../src/server/production.ts";
import { planService } from "../src/server/stationOps.ts";
import { clearOrders } from "../src/server/orders.ts";
import { DEFAULT_PROBE_SETTINGS, type AutomationSettings } from "../src/shared/automation.ts";
import { DEFAULT_STATION, type StationConfig } from "../src/shared/stations.ts";

type Probe = Schemas["Probe"];

async function setup() {
  clearOrders();
  const mock = await startMock(0);
  const game = new Game(mock.url, "vng_mock", new RateLimiter(0.3));
  const poller = new Poller(game, { minIntervalMs: 1000, maxIntervalMs: 60_000 });
  await poller.pollOnce();
  return { mock, poller };
}

function docked(s: Snapshot): Snapshot {
  const snap = structuredClone(s);
  for (const v of snap.probes) v.mannies = v.mannies?.map((m) => ({ ...m, currentTask: null, task: [], location: { type: "probe", sector: null }, canReceiveOrders: true })) ?? null;
  const scout = snap.probes[1].detail as Probe;
  delete scout.movement;
  scout.status = "orbiting";
  scout.fuel.deuterium = 95;
  (snap.probes[0].detail as Probe).inventory!.freeCapacity = 0.9;
  return snap;
}

const cfg = (over: Partial<StationConfig> = {}): StationConfig => ({ probeId: 1, ...structuredClone(DEFAULT_STATION), createdAt: "", ...over });
const members = { "2": { stationId: 1, role: "Hauler" as const, joinedAt: "" } };

test("each production mode turns into crafting goals", async () => {
  const { mock, poller } = await setup();
  try {
    const snap = docked(poller.snapshot);
    const parts = productionGoals(cfg({ targets: [{ kind: "item", item: "electric_motor", min: 10 }] }), { members }, snap);
    assert.deepEqual(parts.map((g) => [g.item, g.quantity]), [["electric_motor", 10]]);

    const factory = productionGoals(cfg({ mode: "manny_factory", mannyTarget: 12 }), { members }, snap);
    assert.deepEqual(factory.map((g) => [g.item, g.quantity]), [["manny", 16]], "12 for the station + 4 the 2-Manny Hauler is short of 6");

    const yard = productionGoals(cfg({ mode: "probe_yard", yardModel: "deuterium_tanker", targets: [{ kind: "item", item: "electric_motor", min: 8 }] }), { members }, snap);
    const motor = yard.find((g) => g.item === "electric_motor")!;
    assert.equal(motor.quantity, 8, "the larger of the stock target and the kit's 5");
    assert.ok(yard.some((g) => g.item === "steel_plate" && g.quantity === 10));
    assert.ok(yard.some((g) => g.item === "scut_relay" && g.quantity === 1));
  } finally {
    await mock.close();
  }
});

test("station goals reach the crafting planner, and your own queue wins for the same item", async () => {
  const { mock, poller } = await setup();
  try {
    const snap = docked(poller.snapshot);
    const settings: AutomationSettings = {
      mode: "auto", inspectConstructs: false, naming: false, crafting: true,
      craftQueue: { "1": [{ id: "mine", item: "steel_plate", quantity: 1, once: false, addedAt: "" }] },
      defaults: { ...DEFAULT_PROBE_SETTINGS, mining: false }, probes: {}, lockedNames: [],
    };
    const goals = toCraftGoals(1, productionGoals(cfg({ mode: "probe_yard" }), { members }, snap));
    goals.push({ id: "station:1:steel_plate", item: "steel_plate", quantity: 50, once: false, addedAt: "" });
    const r = planAll({ snapshot: snap, settings, inspected: new Set(), busy: new Set(), recipes: mock.world.recipes, extraGoals: { "1": goals } });
    const ids = r.crafting.filter((g) => g.probeId === 1).map((g) => g.goal.id);
    assert.ok(ids.includes("station:1:scut_relay"), "the kit's missing SCUT relay is being worked on");
    assert.ok(ids.includes("mine") && !ids.includes("station:1:steel_plate"));
  } finally {
    await mock.close();
  }
});

test("Manny split moves a spare station Manny to a short Hauler; a probe yard keeps two empties", async () => {
  const { mock, poller } = await setup();
  try {
    const snap = docked(poller.snapshot);
    const run = (c: StationConfig, refuels = new Set<string>()) =>
      planService({ snapshot: snap, data: { stations: [c], members }, handoffs: [], busy: new Set(), recentRefuels: refuels });
    let ops = run(cfg({ mannyTarget: 2 }));
    const move = ops.find((o) => o.plan.kind === "manny_move");
    assert.ok(move && move.plan.kind === "manny_move" && move.plan.probeId === 1 && move.plan.targetProbeId === 2);
    assert.ok(ops.some((o) => o.plan.kind === "detach" && o.plan.purpose === "empty"), "parts mode gives empties to the Hauler");

    ops = run(cfg({ mannyTarget: 2 }), new Set(["manny:1:2"]));
    assert.ok(!ops.some((o) => o.plan.kind === "manny_move"), "one move at a time per pair");

    ops = run(cfg({ mannyTarget: 2, mode: "probe_yard" }));
    assert.ok(!ops.some((o) => o.plan.kind === "detach" && o.plan.purpose === "empty"), "both of Prime's empties stay for the kit");
  } finally {
    await mock.close();
  }
});
