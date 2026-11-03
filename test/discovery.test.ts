import { test } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "../mock/server.ts";
import { RateLimiter } from "../src/server/rateLimiter.ts";
import { Game, type Schemas } from "../src/server/gameClient.ts";
import { Poller } from "../src/server/poller.ts";
import { DiscoveryTracker, ownDetachedIds } from "../src/server/discovery.ts";

test("our own detached containers are not discoveries; other players' are", async () => {
  const mock = await startMock(0);
  try {
    const game = new Game(mock.url, "vng_mock", new RateLimiter(0.3));
    const poller = new Poller(game, { minIntervalMs: 1000, maxIntervalMs: 60_000 });
    await poller.pollOnce();
    const snap = structuredClone(poller.snapshot);
    const v = snap.probes[0];
    const P = v.detail as Schemas["Probe"];
    P.inventory!.containers.push({ id: "container-itm_ours", kind: "container", label: "Ours", sortOrder: 1, capacity: 0.5, usedCapacity: 0, freeCapacity: 0.5, capacityUnit: "earth_container_equivalent" } as never);
    assert.ok(ownDetachedIds(snap).includes("detached-container-container-itm_ours"));

    const tracker = new DiscoveryTracker(game, undefined, { scansPerCycle: 0, rescanMs: 1e12, blueprintCheckMs: 1e12 });
    v.sector = structuredClone(v.sector!);
    (v.sector.objects as unknown[]) = [
      ...((v.sector.objects ?? []) as unknown[]),
      { id: "detached-container-container-itm_ours", type: "detached_container", name: "Ours" },
      { id: "detached-container-7", type: "detached_container", name: "Someone's" },
    ];
    await tracker.onSnapshot(snap);
    const ids = tracker.discoveries().filter((d) => d.kind === "detached_container").map((d) => d.objectId);
    assert.ok(!ids.includes("detached-container-container-itm_ours"), "ours is hidden");
    assert.ok(ids.includes("detached-container-7"), "a stranger's container still shows");

    // Once detached it's gone from the inventory, but the panel remembers it was ours.
    P.inventory!.containers = P.inventory!.containers.filter((c) => c.id !== "container-itm_ours");
    await tracker.onSnapshot(snap);
    assert.ok(!tracker.discoveries().some((d) => d.objectId === "detached-container-container-itm_ours"));
  } finally {
    await mock.close();
  }
});
