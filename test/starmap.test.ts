import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStarMap, sectorProfile, type StarMapInput } from "../src/shared/starmap.ts";

const T0 = Date.parse("2026-11-02T12:00:00Z");

function input(over: Partial<StarMapInput> = {}): StarMapInput {
  return {
    visited: [
      { relativeCoordinates: { x: 0, y: 0, z: 0 }, visitCount: 3, lastVisitedAt: "2026-11-01T00:00:00Z" },
      { relativeCoordinates: { x: 1, y: 1, z: 0 }, visitCount: 1, lastVisitedAt: "2026-10-30T00:00:00Z" },
    ],
    knowledge: [],
    neighbourScans: [],
    probes: [],
    stationIds: [],
    discoveries: [],
    problemSeverities: [],
    now: T0,
    ...over,
  };
}

test("sectorProfile counts stars and planets nested in solar systems", () => {
  const p = sectorProfile([
    { type: "solar_system", starCount: 2, planetCount: 5 },
    { type: "star" },
    { type: "planet" },
    { type: "asteroid", distinctiveFeature: "Sculpted in the shape of a duck" },
    { type: "asteroid" },
    { type: "black_hole" },
    { type: "dormant_construct" },
    { type: "manny" },
  ]);
  assert.equal(p.stars, 3);
  assert.equal(p.planets, 6);
  assert.equal(p.asteroids, 2);
  assert.equal(p.ducks, 1);
  assert.equal(p.blackHoles, 1);
  assert.equal(p.constructs, 1);
});

test("frontier keeps only unvisited neighbour scans and reads their estimates", () => {
  const d = buildStarMap(input({
    neighbourScans: [
      { relativeCoordinates: { x: 1, y: 1, z: 0 }, confidence: 1, estimatedObjects: { star: true } },
      { relativeCoordinates: { x: -1, y: 1, z: 0 }, confidence: 0.82, estimatedObjects: { star: true, planetCountMin: 0, planetCountMax: 2, blackHoleProbability: 0.2, dangerEstimate: "high" } },
    ],
  }));
  assert.equal(d.frontier.length, 1);
  assert.deepEqual(d.frontier[0], {
    pos: { x: -1, y: 1, z: 0 }, star: true, planetsMin: 0, planetsMax: 2, blackHoleProbability: 0.2, danger: "high", confidence: 0.82,
  });
});

test("moving probes carry their trip, settled probes their sector, and unknown sectors get a node", () => {
  const d = buildStarMap(input({
    stationIds: [2],
    probes: [
      { summary: { id: 1, name: "Scout", isReachable: true, isDefault: false },
        detail: { status: "cruising", sector: { relative: { x: 0, y: 0, z: 0 } },
          movement: { status: "cruising", origin: { x: 0, y: 0, z: 0 }, target: { x: 1, y: 1, z: 0 }, startedAt: "2026-11-02T11:00:00Z", arrivalAt: "2026-11-02T13:00:00Z" } } },
      { summary: { id: 2, name: "Depot", isReachable: true, isDefault: true },
        detail: { status: "orbiting", sector: { relative: { x: 2, y: 0, z: 0 } }, movement: { status: "arrived", origin: { x: 0, y: 0, z: 0 }, target: { x: 2, y: 0, z: 0 }, startedAt: "x", arrivalAt: "y" } } },
    ],
  }));
  assert.equal(d.probes[0].move?.target.x, 1);
  assert.equal(d.probes[1].move, null);
  assert.equal(d.probes[1].station, true);
  assert.ok(d.sectors.some((s) => s.pos.x === 2 && s.visitCount === 0));
});

test("mood follows the worst open problem and unread potential blueprints mark their sector", () => {
  const d = buildStarMap(input({
    problemSeverities: ["info", "warning"],
    knowledge: [{ sector: { x: 1, y: 1, z: 0 }, profile: sectorProfile([{ type: "star" }]), coverage: "covered", scutNetworkIds: [4] }],
    discoveries: [
      { kind: "dormant_construct", sector: { x: 1, y: 1, z: 0 }, read: false, present: true },
      { kind: "dormant_construct", sector: { x: 0, y: 0, z: 0 }, read: true, present: true },
      { kind: "abandoned_manny", sector: { x: 0, y: 0, z: 0 }, read: false, present: true },
    ],
  }));
  assert.equal(d.mood, "warning");
  const s = d.sectors.find((x) => x.pos.x === 1)!;
  assert.equal(s.newDiscovery, true);
  assert.equal(s.profile?.stars, 1);
  assert.deepEqual(s.scutNetworkIds, [4]);
  assert.equal(d.sectors.find((x) => x.pos.x === 0)!.newDiscovery, false);
  assert.equal(buildStarMap(input({ problemSeverities: ["critical"] })).mood, "critical");
});
