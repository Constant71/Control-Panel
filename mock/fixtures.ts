/**
 * Fixture data for the local mock game server. Every object is typed against
 * the generated OpenAPI schema, so the mock cannot drift from the spec.
 */
import type { components } from "../src/shared/api-schema.js";

type S = components["schemas"];

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const DAY = 86_400_000;

const emptyCargo: S["MannyCargo"] = {
  capacity: 0.05, deuterium: 0, metals: 0, ice: 0, organicCompounds: 0, capacityUnit: "earth_container_equivalent",
};

const container = (id: string, label: string, kind: "probe" | "container", capacity: number, used: number): S["StorageContainer"] => ({
  id, kind, label, sortOrder: kind === "probe" ? 0 : 1, capacity, usedCapacity: used, freeCapacity: capacity - used,
  capacityUnit: "earth_container_equivalent", rules: {},
});

const inventory = (used: number): S["ProbeInventory"] => ({
  capacity: 1, capacityUnit: "earth_container_equivalent", usedCapacity: used, freeCapacity: 1 - used,
  items: [{ id: "itm-manny-a", type: "manny", name: "Manny", containerSpace: 0.02 }],
  resourceStocks: [
    {
      id: "stock-metals", type: "metals", name: "Metals", amount: used * 0.6, containerSpace: used * 0.6,
      capacityUnit: "earth_container_equivalent",
      containers: [{ container: { id: "probe-core", kind: "probe", label: "Probe", sortOrder: 0 }, amount: used * 0.6, containerSpace: used * 0.6, capacityUnit: "earth_container_equivalent" }],
    },
    {
      id: "stock-ice", type: "ice", name: "Ice", amount: used * 0.4, containerSpace: used * 0.4,
      capacityUnit: "earth_container_equivalent",
      containers: [{ container: { id: "probe-core", kind: "probe", label: "Probe", sortOrder: 0 }, amount: used * 0.4, containerSpace: used * 0.4, capacityUnit: "earth_container_equivalent" }],
    },
  ],
  containers: used > 0.9
    ? [container("probe-core", "Probe", "probe", 1, used), container("container-itm_extra", "Extra 1", "container", 0.5, 0.1)]
    : [container("probe-core", "Probe", "probe", 1, used)],
  externalTanks: [],
});

function manny(id: string, name: string, overrides: Partial<S["Manny"]> = {}): S["Manny"] {
  return {
    id, name, location: { type: "probe", sector: null }, currentTask: null, taskProgressPercent: 0,
    taskStartTime: null, taskEstimatedEndTime: null, task: [], taskVisibility: "local", cargo: emptyCargo,
    canReceiveOrders: true, ...overrides,
  };
}

export function buildWorld() {
  const probes: S["Probe"][] = [
    {
      id: 1, name: "Prime", model: "generic" as S["ProbeModel"], status: "orbiting", sensorMode: "normal",
      fuel: { deuterium: 62, maxDeuterium: 100 }, sector: { relative: { x: 0, y: 0, z: 0 } },
      systems: { integrityPercent: 88, energyStored: 40, internalClockRate: 1, currentTask: null },
      inventory: inventory(0.97),
    },
    {
      id: 2, name: "Scout", model: "generic" as S["ProbeModel"], status: "cruising", sensorMode: "degraded",
      fuel: { deuterium: 14, maxDeuterium: 100 }, sector: { relative: { x: 0, y: 0, z: 0 } },
      movement: {
        status: "cruising", phase: "cruising", origin: { x: 0, y: 0, z: 0 }, target: { x: 1, y: 1, z: 0 },
        distance: 1, fuelCostDeuterium: 20, startedAt: iso(-3_600_000), arrivalAt: iso(5_400_000), secondsRemaining: 5400,
      },
      systems: { integrityPercent: 41, energyStored: 10, internalClockRate: 1, currentTask: null },
      inventory: inventory(0.3),
    },
  ];
  const farProbe: S["ProbeLimitedTelemetry"] = {
    id: 3, name: "Far Reach", status: "out_of_scut_range", sector: { relative: { x: 4, y: -2, z: 1 } },
  };
  const summaries: S["ProbeSummary"][] = [
    { id: 1, name: "Prime", model: "generic" as S["ProbeModel"], status: "orbiting", isDefault: true, isReachable: true },
    { id: 2, name: "Scout", model: "generic" as S["ProbeModel"], status: "cruising", isDefault: false, isReachable: true },
    { id: 3, name: "Far Reach", model: "generic" as S["ProbeModel"], status: "idle", isDefault: false, isReachable: false },
  ];

  const mannies: Record<number, S["Manny"][]> = {
    1: [
      manny("mny_a1", "manny-1", {
        currentTask: "mining", taskProgressPercent: 55, taskStartTime: iso(-1_800_000), taskEstimatedEndTime: iso(1_500_000),
        location: { type: "sector", sector: { relative: { x: 0, y: 0, z: 0 } } }, canReceiveOrders: false,
      }),
      manny("mny_a2", "manny-2", {
        currentTask: "waiting_for_space", task: { waitingFor: "storage_space", waitingForSpaceSince: iso(-5.5 * DAY), reason: "docking" },
        location: { type: "sector", sector: { relative: { x: 0, y: 0, z: 0 } } }, canReceiveOrders: false,
      }),
      manny("mny_a3", "manny-3"),
      manny("mny_a4", "manny-4", {
        currentTask: "crafting", taskProgressPercent: 10, taskStartTime: iso(-600_000), taskEstimatedEndTime: iso(5_400_000), canReceiveOrders: false,
      }),
      manny("mny_a5", "manny-5", { currentTask: "unknown_too_far", taskVisibility: "too_far", canReceiveOrders: false,
        location: { type: "sector", sector: { relative: { x: 2, y: 0, z: 0 } } } }),
    ],
    2: [manny("mny_b1", "manny-6"), manny("mny_b2", "manny-7")],
  };

  const alerts: Record<number, S["ProbeDamageWarning"][]> = {
    1: [],
    2: [{
      id: 7, type: "storage_container_break", status: "unread",
      message: "From 5 additional containers onward, movement stress can break one container link. Risk is 30% for this jump.",
    } as S["ProbeDamageWarning"]],
  };

  const sector: S["SectorObservation"] = {
    relativeCoordinates: { x: 0, y: 0, z: 0 }, distance: 0, knowledgeLevel: "detailed", confidence: 1,
    scan: {} as S["SectorObservation"]["scan"], scutCoverageStatus: "uncovered", scutNetworks: [],
    objects: [
      { id: "manny-mny_lost", type: "manny", name: "manny-old" } as S["SectorObject"],
      {
        id: "asteroid-ice-1", type: "asteroid", name: "Ice Deut 15ce", resourceTypes: ["ice", "deuterium"],
        resourceComposition: { deuterium: 0.3, metals: 0, ice: 0.7, carbon_compounds: 0 },
        resourceAmounts: { deuterium: 0.5, metals: 0, ice: 2, carbon_compounds: 0 },
      } as unknown as S["SectorObject"],
      {
        id: "sys-1", type: "solar_system", name: "System abc",
        minableTargets: [{
          id: "asteroid-metal-1", type: "asteroid", name: "Metal 3b91", mass: 1e-6, resources: ["iron"], resourceTypes: ["metals"],
          resourceComposition: { deuterium: 0, metals: 1, ice: 0, carbon_compounds: 0 },
          resourceAmounts: { deuterium: 0, metals: 3, ice: 0, carbon_compounds: 0 },
        }],
      } as unknown as S["SectorObject"],
      { id: "construct-home", type: "dormant_construct", name: "Dormant construct", inspectable: true } as unknown as S["SectorObject"],
    ],
  };
  const visitedSectorObs = (v: { x: number; y: number; z: number }): S["SectorObservation"] => ({
    relativeCoordinates: v, distance: 1, knowledgeLevel: "detailed", confidence: 1,
    scan: {} as S["SectorObservation"]["scan"], scutCoverageStatus: "uncovered", scutNetworks: [],
    objects: v.x === 2 && v.y === 0
      ? [{ id: "construct-7", type: "dormant_construct", name: "Dormant construct" } as S["SectorObject"],
         { id: "station-1", type: "deuterium_refuel_station", name: "Refuel station" } as S["SectorObject"]]
      : [],
  });
  const improvements = [
    { id: "deuterium_compression", name: "Deuterium compression", description: "Compresses the tank.", available: true, done: false,
      installableOnProbe: true, durationSeconds: 300, ingredients: [], effects: {} },
  ] as unknown as S["ProbeImprovement"][];

  const visited: S["VisitedSector"][] = [
    { relativeCoordinates: { x: 0, y: 0, z: 0 }, firstVisitedAt: iso(-20 * DAY), lastVisitedAt: iso(-DAY), visitCount: 5 },
    { relativeCoordinates: { x: 1, y: 1, z: 0 }, firstVisitedAt: iso(-10 * DAY), lastVisitedAt: iso(-3 * DAY), visitCount: 2 },
    { relativeCoordinates: { x: 2, y: 0, z: 0 }, firstVisitedAt: iso(-8 * DAY), lastVisitedAt: iso(-8 * DAY), visitCount: 1 },
    { relativeCoordinates: { x: 4, y: -2, z: 1 }, firstVisitedAt: iso(-2 * DAY), lastVisitedAt: iso(-2 * DAY), visitCount: 1 },
  ];

  const missions: S["Mission"][] = [];
  return { probes, farProbe, summaries, mannies, alerts, sector, visited, missions, visitedSectorObs, improvements };
}
