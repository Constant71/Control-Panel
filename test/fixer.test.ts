import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "../mock/server.ts";
import { RateLimiter } from "../src/server/rateLimiter.ts";
import { Game } from "../src/server/gameClient.ts";
import { Poller } from "../src/server/poller.ts";
import { Fixer } from "../src/server/fixer.ts";
import { detectProblems } from "../src/server/detect.ts";
import { DiscoveryTracker } from "../src/server/discovery.ts";

async function setup(fail?: Record<string, { status: number; code: string }>) {
  const mock = await startMock(0, { fail });
  const game = new Game(mock.url, "vng_mock", new RateLimiter(0.3));
  const poller = new Poller(game, { minIntervalMs: 1000, maxIntervalMs: 60_000 });
  await poller.pollOnce();
  return { mock, game, poller };
}

test("detects stuck Mannies with real fixes and safe defaults", async () => {
  const { mock, poller } = await setup();
  try {
    const problems = detectProblems(poller.snapshot);
    const docking = problems.find((p) => p.key === "manny:mny_a2:waiting_for_space");
    assert.ok(docking, "waiting_for_space Manny is a problem");
    assert.ok(docking.deadline, "has the 7-day deadline");
    const move = docking.fixes.find((f) => f.plan.kind === "storage_move");
    assert.ok(move, "offers a storage move into the container with room");
    assert.equal(move.mode, "auto");
    assert.equal(move.plan.kind === "storage_move" && move.plan.actorMannyId, "mny_a3", "uses the idle onboard Manny");

    const salvage = problems.find((p) => p.code === "abandoned_manny");
    assert.ok(salvage, "abandoned Manny in sector is listed");
    assert.equal(salvage.fixes.length, 0, "the only idle Manny is already used for the stuck one");

    assert.ok(problems.some((p) => p.code === "probe_unreachable"));
    const fuel = problems.find((p) => p.code === "fuel_low");
    assert.ok(fuel && fuel.fixes.length === 0 && /moving/.test(fuel.advice ?? ""), "no refuel while moving");
    const rank = { critical: 0, warning: 1, info: 2 };
    for (let i = 1; i < problems.length; i++)
      assert.ok(rank[problems[i - 1].severity] <= rank[problems[i].severity], "sorted by severity");
  } finally {
    await mock.close();
  }
});

test("drop-cargo is confirm-only until the deadline is close", async () => {
  const { mock, poller } = await setup();
  try {
    const m = poller.snapshot.probes[0].mannies!.find((x) => x.id === "mny_a2")!;
    m.cargo = { ...m.cargo, metals: 0.02 };
    const far = detectProblems(poller.snapshot).find((p) => p.key === "manny:mny_a2:waiting_for_space")!;
    assert.equal(far.fixes.find((f) => f.plan.kind === "drop_cargo")?.mode, "confirm");
    const near = detectProblems(poller.snapshot, { now: Date.now() + 1.2 * 86_400_000 }).find((p) => p.key === "manny:mny_a2:waiting_for_space")!;
    assert.equal(near.fixes.find((f) => f.plan.kind === "drop_cargo")?.mode, "auto");
    assert.equal(near.severity, "critical");
  } finally {
    await mock.close();
  }
});

test("auto mode sends the fix once, then settles", async () => {
  const { mock, game, poller } = await setup();
  try {
    let acted = 0;
    const fixer = new Fixer(game, undefined, () => acted++);
    await fixer.onSnapshot(poller.snapshot);
    const moves = mock.posts().filter((p) => p.path.endsWith("/storage-moves"));
    assert.equal(moves.length, 1);
    assert.deepEqual(moves[0].body, {
      actorMannyId: "mny_a3", kind: "resource", resourceType: "metals", amount: 0.399,
      fromContainerId: "probe-core", toContainerId: "container-itm_extra",
    });
    assert.equal(acted, 1);
    assert.ok(fixer.log.at(-1)?.ok);
    await fixer.onSnapshot(poller.snapshot);
    assert.equal(mock.posts().filter((p) => p.path.endsWith("/storage-moves")).length, 1, "not repeated while settling");
    assert.equal(mock.posts().filter((p) => p.path.endsWith("/repair")).length, 1, "a different helper Manny doesn't cause a second repair");
  } finally {
    await mock.close();
  }
});

test("a rejected fix is logged with the game's error code and backs off", async () => {
  const { mock, game, poller } = await setup({ "/storage-moves": { status: 422, code: "invalid_storage_move" } });
  try {
    const fixer = new Fixer(game, undefined, () => {});
    await fixer.onSnapshot(poller.snapshot);
    const entry = fixer.log.find((e) => e.endpoint.endsWith("/storage-moves"))!;
    assert.equal(entry.ok, false);
    assert.equal(entry.code, "invalid_storage_move");
    const attempt = Object.entries(fixer.attempts).find(([k]) => k.startsWith("storage_move:"))![1];
    assert.equal(attempt.failures, 1);
    assert.ok(new Date(attempt.nextEligibleAt).getTime() > Date.now() + 4 * 60_000);
    await fixer.onSnapshot(poller.snapshot);
    assert.equal(mock.posts().filter((p) => p.path.endsWith("/storage-moves")).length, 1, "backed off");
  } finally {
    await mock.close();
  }
});

test("dry run and off modes send nothing", async () => {
  const { mock, game, poller } = await setup();
  try {
    const fixer = new Fixer(game, undefined, () => {});
    await fixer.setMode("dry_run");
    await fixer.onSnapshot(poller.snapshot);
    assert.equal(mock.posts().length, 0);
    assert.ok(fixer.log.some((e) => e.dryRun));
    const off = new Fixer(game, undefined, () => {});
    await off.setMode("off");
    await off.onSnapshot(poller.snapshot);
    assert.equal(mock.posts().length, 0);
    assert.equal(off.log.length, 0);
  } finally {
    await mock.close();
  }
});

test("confirm fixes run only when pressed", async () => {
  const { mock, game, poller } = await setup();
  try {
    const m = poller.snapshot.probes[0].mannies!.find((x) => x.id === "mny_a2")!;
    m.cargo = { ...m.cargo, metals: 0.02 };
    const fixer = new Fixer(game, undefined, () => {});
    await fixer.setMode("off");
    await fixer.onSnapshot(poller.snapshot);
    const p = fixer.problems.find((x) => x.key === "manny:mny_a2:waiting_for_space")!;
    const drop = p.fixes.find((f) => f.plan.kind === "drop_cargo")!;
    const entry = await fixer.runManually(p.key, drop.id);
    assert.ok(entry.ok);
    assert.equal(entry.initiator, "you");
    assert.ok(mock.posts().some((x) => x.path.endsWith("/mannies/mny_a2/drop-manny-cargo")));
    const stale = await fixer.runManually("nope", "nope");
    assert.equal(stale.ok, false);
  } finally {
    await mock.close();
  }
});

test("discoveries: scans visited sectors and flags potential blueprints", async () => {
  const { mock, game, poller } = await setup();
  try {
    const d = new DiscoveryTracker(game, undefined, { scansPerCycle: 10, rescanMs: 3_600_000, blueprintCheckMs: 600_000 });
    await d.onSnapshot(poller.snapshot);
    const all = d.discoveries();
    const construct = all.find((x) => x.kind === "dormant_construct");
    assert.ok(construct, "dormant construct found by scanning a visited sector");
    assert.deepEqual(construct.sector, { x: 2, y: 0, z: 0 });
    assert.equal(construct.read, false);
    assert.ok(all.some((x) => x.kind === "abandoned_manny"));
    assert.ok(all.some((x) => x.kind === "deuterium_refuel_station"));
    const bp = all.find((x) => x.kind === "new_blueprint")!;
    assert.equal(bp.read, true, "blueprints known at first run are a baseline, not alerts");
    assert.ok(d.scans().every((s) => s.scannedAt), "every visited sector scanned");

    const before = mock.requests();
    await d.onSnapshot(poller.snapshot);
    const sectorCalls = mock.requests() - before;
    assert.equal(sectorCalls, 0, "no rescans before they are due");

    mock.world.improvements.push({ ...mock.world.improvements[0], id: "reinforced_container_couplings", name: "Reinforced couplings" });
    const d2 = new DiscoveryTracker(game, undefined, { scansPerCycle: 0, rescanMs: 3_600_000, blueprintCheckMs: 0 });
    await d2.onSnapshot(poller.snapshot);
    mock.world.improvements.push({ ...mock.world.improvements[0], id: "new_one" as never, name: "New one" });
    await d2.onSnapshot(poller.snapshot);
    const fresh = d2.discoveries().find((x) => x.objectId === "new_one")!;
    assert.equal(fresh.read, false, "a blueprint learned later is an unread alert");
    assert.match(fresh.title, /New blueprint learned/);
  } finally {
    await mock.close();
  }
});
