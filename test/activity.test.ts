import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWorld } from "../mock/fixtures.ts";
import { describeManny, describeProbe } from "../src/shared/activity.ts";
import type { components } from "../src/shared/api-schema.ts";

test("describes a mining Manny from its task payload", () => {
  const w = buildWorld();
  const now = Date.now();
  const a = describeManny(w.mannies[1][0], { probeName: "Prime", now });
  assert.equal(a.summary, "Mining 0.1 ECE of metals from Metal 3b91");
  assert.ok(a.details.some((d) => d.startsWith("55% · done in")));
  assert.ok(a.details.includes("Travel 5m each way"));
  assert.ok(a.details.includes("Left on target: 2.9 metals"));
  assert.ok(a.raw.some(([k, v]) => k === "objectId" && v === "asteroid-metal-1"));
});

test("describes the 7-day storage wait and a moving probe", () => {
  const w = buildWorld();
  const now = Date.now();
  const wait = describeManny(w.mannies[1][1], { probeName: "Prime", now });
  assert.equal(wait.summary, "Waiting for room to dock on Prime");
  assert.match(wait.details.join(" "), /Waiting 5d 12h.*in 36h/);
  const scout = describeProbe(w.probes[1] as components["schemas"]["Probe"], now);
  assert.equal(scout.summary, "cruising from (0, 0, 0) to (1, 1, 0)");
  assert.ok(scout.details.includes("1 sector(s), 20 deuterium reserved for the trip"));
});
