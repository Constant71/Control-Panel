import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startMock } from "../mock/server.ts";
import { RateLimiter } from "../src/server/rateLimiter.ts";
import { Game } from "../src/server/gameClient.ts";
import { Poller } from "../src/server/poller.ts";
import { Manual, findOperation, validate } from "../src/server/manual.ts";
import { CommsTracker } from "../src/server/comms.ts";
import { OPERATIONS } from "../src/shared/operations.gen.ts";
import { clearOrders, recentlyOrdered } from "../src/server/orders.ts";

async function setup() {
  clearOrders();
  const mock = await startMock(0);
  const game = new Game(mock.url, "vng_mock", new RateLimiter(0.3));
  const dir = await mkdtemp(path.join(tmpdir(), "panel-"));
  let acted = 0;
  const manual = new Manual(game, dir, () => acted++);
  return { mock, game, manual, acted: () => acted };
}

test("the catalog covers the spec, without default-probe duplicates", () => {
  assert.ok(OPERATIONS.length > 80);
  assert.ok(!OPERATIONS.some((o) => o.path.startsWith("/api/probe/mannies/")), "default-probe twins are skipped");
  assert.ok(findOperation("POST /api/probe/mind-snapshot/reassign"), "default-probe-only calls are kept");
  assert.equal(findOperation("POST /api/session")?.risk, "blocked");
  assert.equal(findOperation("POST /api/probe/{probeId}/inventory/{itemId}/jettison")?.risk, "confirm");
  assert.equal(findOperation("POST /api/probe/{probeId}/mannies/{mannyId}/repair")?.risk, "normal");
  const send = findOperation("POST /api/probe/{probeId}/messages")!;
  assert.deepEqual(send.body?.required, ["body"]);
});

test("input is checked against the spec before anything is sent", async () => {
  const { mock, manual } = await setup();
  try {
    assert.match((await manual.call({ opId: "POST /api/made-up" })).error!, /isn't in the API spec/);
    assert.match((await manual.call({ opId: "POST /api/me/api-key" })).error!, /API key/);
    assert.match((await manual.call({ opId: "POST /api/probe/{probeId}/inventory/{itemId}/jettison", path: { probeId: 1, itemId: "x" } })).error!, /Needs confirmation/);
    assert.match((await manual.call({ opId: "POST /api/probe/{probeId}/mannies/{mannyId}/repair", path: { probeId: 1 } })).error!, /mannyId is required/);
    const bad = await manual.call({ opId: "POST /api/probe/{probeId}/messages", path: { probeId: 1 }, body: { body: "" } });
    assert.match(bad.error!, /at least 1/);
    assert.equal(mock.posts().length, 0, "nothing reached the game");
    assert.deepEqual(validate({ type: "string", enum: ["a"] }, "b"), ["body must be one of a"]);
  } finally {
    await mock.close();
  }
});

test("a valid call is sent, logged, and keeps the automation off that Manny", async () => {
  const { mock, manual, acted } = await setup();
  try {
    const r = await manual.call({ opId: "POST /api/probe/{probeId}/mannies/{mannyId}/repair", path: { probeId: 1, mannyId: "mny_a3" }, body: { integrityPercent: 5 } });
    assert.equal(r.ok, true, r.error ?? "");
    assert.deepEqual(mock.posts().at(-1), { path: "/api/probe/1/mannies/mny_a3/repair", body: { integrityPercent: 5 } });
    assert.equal(manual.log.length, 1);
    assert.equal(acted(), 1);
    assert.ok(recentlyOrdered(Date.now()).has("mny_a3"));

    const del = await manual.call({ opId: "DELETE /api/probe/{probeId}/logbook-page/{logbookPageId}", path: { probeId: 1, logbookPageId: 1 }, confirmed: true });
    assert.equal(del.status, 204);
    const read = await manual.call({ opId: "GET /api/forum/posts", query: { categoryId: 1 } });
    assert.equal((read.data as { posts: unknown[] }).posts.length, 1);
    assert.equal(manual.log.length, 2, "reads aren't logged as actions");
  } finally {
    await mock.close();
  }
});

test("unread messages are counted per reachable probe", async () => {
  const { mock, game } = await setup();
  try {
    const poller = new Poller(game, { minIntervalMs: 1000, maxIntervalMs: 60_000 });
    await poller.pollOnce();
    const comms = new CommsTracker(game);
    await comms.onSnapshot(poller.snapshot);
    assert.equal(comms.unreadCount, 1);
    assert.equal(comms.unread["1"][0].sender.name, "Wanderer");
    assert.equal(comms.unread["3"], undefined, "out-of-range probes are skipped");
  } finally {
    await mock.close();
  }
});
