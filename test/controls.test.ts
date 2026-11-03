import { test } from "node:test";
import assert from "node:assert/strict";
import { OPERATIONS } from "../src/shared/operations.gen.ts";
import { mannyOps, probeOps } from "../src/shared/controls.ts";

test("manual controls offer every spec call on a Manny and on a probe, with the stuck-Manny ones first", () => {
  const m = mannyOps(OPERATIONS);
  const p = probeOps(OPERATIONS);
  assert.ok(m.length >= 20, `found ${m.length} Manny calls`);
  assert.equal(m[0].path, "/api/probe/{probeId}/mannies/{mannyId}/drop-manny-cargo");
  assert.ok(m.slice(0, 3).some((o) => o.path.endsWith("/transfer-to-probe")));
  assert.ok(m.every((o) => o.method !== "GET" && o.path.includes("{mannyId}")));
  assert.equal(p[0].path, "/api/probe/{probeId}/move");
  for (const want of ["/storage-moves", "/inventory/{itemId}/jettison", "/atomic-printer/craft"])
    assert.ok(p.some((o) => o.path.endsWith(want)), want);
  assert.ok(p.every((o) => !o.path.includes("{mannyId}") && o.method !== "GET"));
  // Every spec call on a probe or one of its Mannies is reachable from the probe page (reads stay on the Console).
  const all = OPERATIONS.filter((o) => o.method !== "GET" && o.path.startsWith("/api/probe/{probeId}/") && o.risk !== "blocked");
  assert.equal(m.length + p.length, all.length);
});
