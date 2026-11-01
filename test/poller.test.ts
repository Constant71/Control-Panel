import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "../mock/server.ts";
import { RateLimiter } from "../src/server/rateLimiter.ts";
import { Game } from "../src/server/gameClient.ts";
import { Poller } from "../src/server/poller.ts";

test("full poll builds a fleet snapshot and respects reachability", async () => {
  const mock = await startMock(0);
  try {
    const game = new Game(mock.url, "vng_mock", new RateLimiter(0.3));
    const poller = new Poller(game, { minIntervalMs: 1000, maxIntervalMs: 60_000 });
    const delay = await poller.pollOnce();
    const s = poller.snapshot;
    assert.equal(s.apiVersion, 150);
    assert.equal(s.player?.username, "mock");
    assert.equal(s.defaultProbeId, 1);
    assert.equal(s.probes.length, 3);
    assert.equal(s.visitedSectors.length, 4);

    const prime = s.probes.find((p) => p.summary.id === 1)!;
    assert.equal(prime.mannies?.length, 5);
    assert.ok(prime.sector);
    assert.deepEqual(prime.errors, []);

    const scout = s.probes.find((p) => p.summary.id === 2)!;
    assert.equal(scout.errors.length, 1, "sector scan while cruising is recorded, not fatal");
    assert.equal(scout.errors[0].code, "sensors_unavailable");
    assert.equal(scout.damageWarnings?.length, 1);

    const far = s.probes.find((p) => p.summary.id === 3)!;
    assert.equal(far.detail?.status, "out_of_scut_range");
    assert.equal(far.mannies, null, "unreachable probes are not queried for probe-scoped data");
    assert.deepEqual(far.errors, []);

    assert.ok(delay <= 30_000, "uses nextUsefulRefreshDelayMs");
  } finally {
    await mock.close();
  }
});

test("bad API key surfaces as an unauthorized error", async () => {
  const mock = await startMock(0);
  try {
    const game = new Game(mock.url, "wrong", new RateLimiter(0.3));
    const poller = new Poller(game, { minIntervalMs: 1000, maxIntervalMs: 60_000 });
    await poller.pollOnce();
    assert.ok(poller.snapshot.globalErrors.some((e) => e.code === "unauthorized"));
  } finally {
    await mock.close();
  }
});

test("a tight rate limit never produces a 429 for polling", async () => {
  // 3 global + per reachable probe 5 calls, + 1 for the far probe = 14 per poll.
  const mock = await startMock(0, { limit: 20, windowMs: 1500 });
  try {
    const limiter = new RateLimiter(0.3);
    const game = new Game(mock.url, "vng_mock", limiter);
    const poller = new Poller(game, { minIntervalMs: 0, maxIntervalMs: 60_000 });
    await poller.pollOnce();
    await poller.pollOnce();
    assert.equal(limiter.snapshot().total429, 0);
    assert.ok(game.log.every((e) => e.status !== 429));
  } finally {
    await mock.close();
  }
});
