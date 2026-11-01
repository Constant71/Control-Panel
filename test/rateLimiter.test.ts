import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/server/rateLimiter.ts";

const hdrs = (limit: number, remaining: number, resetSec: number) =>
  new Headers({
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(resetSec),
  });

test("polls stop at the reserve but actions still go through", async () => {
  let now = 1_000_000;
  const rl = new RateLimiter(0.3, () => now);
  await rl.acquire("poll");
  rl.observe(200, hdrs(10, 3, now / 1000 + 60)); // 3 left, reserve is 3

  let pollGranted = false;
  void rl.acquire("poll").then(() => (pollGranted = true));
  let actionGranted = false;
  void rl.acquire("action").then(() => (actionGranted = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(actionGranted, true, "action should use reserved budget");
  assert.equal(pollGranted, false, "poll should wait for the window to roll");
  rl.dispose();
});

test("429 blocks everything until Retry-After", async () => {
  let now = 1_000_000;
  const rl = new RateLimiter(0.3, () => now);
  await rl.acquire("action");
  rl.observe(429, new Headers({ "Retry-After": "2", "X-RateLimit-Limit": "10", "X-RateLimit-Remaining": "0" }));
  let granted = false;
  void rl.acquire("action").then(() => (granted = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(granted, false);
  assert.equal(rl.snapshot().total429, 1);
  rl.dispose();
});

test("missing headers fall back to gentle spacing, not a stall", async () => {
  const rl = new RateLimiter(0.3);
  const started = Date.now();
  for (let i = 0; i < 3; i++) {
    await rl.acquire("poll");
    rl.observe(200, new Headers());
  }
  assert.ok(Date.now() - started < 2000);
});
