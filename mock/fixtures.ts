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
  // Prime carries an atomic printer and most of a generic assembly kit (no SCUT relay yet),
  // plus two empty additional containers.
  const item = (type: S["ProbeInventoryItem"]["type"], n: number, space: number): S["ProbeInventoryItem"][] =>
    Array.from({ length: n }, (_, i) => ({ id: `itm-${type}-${i}`, type, name: type, containerSpace: space }));
  probes[0].inventory!.items.push(
    ...item("atomic_3d_printer", 1, 0), ...item("steel_bar", 3, 0.005), ...item("electric_motor", 5, 0.01),
    ...item("solar_panel", 4, 0.015), ...item("atomic_printer_part", 2, 0.01), ...item("deuterium_engine", 1, 0.05),
  );
  probes[0].inventory!.containers.push(
    container("container-itm_empty1", "Extra 2", "container", 0.25, 0), container("container-itm_empty2", "Extra 3", "container", 0.25, 0),
  );
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
        task: {
          objectId: "asteroid-metal-1", resourceType: "metals", resourceTypes: ["metals"], targetAmount: 0.1, depositedAmount: 0,
          depositedResources: [], extractedAmount: 0, extractedResources: [], availableResources: ["metals"],
          resourceComposition: { deuterium: 0, metals: 1, ice: 0, carbon_compounds: 0 },
          resourceProfile: { deuterium: 0, metals: 1, ice: 0, carbon_compounds: 0 }, miningTravelSeconds: 300,
          target: { id: "asteroid-metal-1", type: "asteroid", name: "Metal 3b91", resourceTypes: ["metals"],
            resourceAmounts: { deuterium: 0, metals: 2.9, ice: 0, carbon_compounds: 0 } },
        } as unknown as S["Manny"]["task"],
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
    // MOCK_GALAXY=1 fills the extra visited sectors with varied objects, to preview the projector star map.
    objects: process.env.MOCK_GALAXY && galaxyObjects(v) ? galaxyObjects(v)!
      : v.x === 2 && v.y === 0
      ? [{ id: "construct-7", type: "dormant_construct", name: "Dormant construct" } as S["SectorObject"],
         { id: "station-1", type: "deuterium_refuel_station", name: "Refuel station" } as S["SectorObject"]]
      : [],
  });
  // Unvisited sectors answer with a passive neighbour scan: a promising one, a dangerous one, the rest plain.
  const neighborScan = (v: { x: number; y: number; z: number }): S["SectorObservation"] => {
    const k = `${v.x},${v.y},${v.z}`;
    const est = k === "1,-1,0" ? { star: true, planetCountMin: 3, planetCountMax: 7, blackHoleProbability: 0.01, dangerEstimate: "low" }
      : k === "-1,1,0" ? { star: true, planetCountMin: 0, planetCountMax: 2, blackHoleProbability: 0.2, dangerEstimate: "high" }
      : { star: false, blackHoleProbability: 0, dangerEstimate: "low" };
    return {
      relativeCoordinates: v, distance: 1, knowledgeLevel: "neighbor_scan", confidence: 0.82, scutCoverageStatus: "unknown",
      estimatedObjects: est, scan: { currentSectorResidenceSeconds: 1832, requiredResidenceSeconds: 300, scanQuality: 1 },
    };
  };
  const improvements = [
    { id: "deuterium_compression", name: "Deuterium compression", description: "Compresses the tank.", available: true, done: false,
      installableOnProbe: true, durationSeconds: 300, ingredients: [], effects: {} },
  ] as unknown as S["ProbeImprovement"][];

  const visited: S["VisitedSector"][] = [
    { relativeCoordinates: { x: 0, y: 0, z: 0 }, firstVisitedAt: iso(-20 * DAY), lastVisitedAt: iso(-DAY), visitCount: 5 },
    { relativeCoordinates: { x: 1, y: 1, z: 0 }, firstVisitedAt: iso(-10 * DAY), lastVisitedAt: iso(-3 * DAY), visitCount: 2 },
    { relativeCoordinates: { x: 2, y: 0, z: 0 }, firstVisitedAt: iso(-8 * DAY), lastVisitedAt: iso(-8 * DAY), visitCount: 1 },
    { relativeCoordinates: { x: 4, y: -2, z: 1 }, firstVisitedAt: iso(-2 * DAY), lastVisitedAt: iso(-2 * DAY), visitCount: 1 },
    ...(process.env.MOCK_GALAXY ? GALAXY.map(([x, y, z]) => ({
      relativeCoordinates: { x, y, z }, firstVisitedAt: iso(-15 * DAY), lastVisitedAt: iso(-4 * DAY), visitCount: 1,
    })) : []),
  ];

  const missions: S["Mission"][] = [];

  const party = (id: number, name: string) => ({ type: "probe" as const, id, probeId: id, name });
  const messages: Record<number, S["ProbeMessage"][]> = {
    1: [
      { id: 11, sender: party(42, "Wanderer"), recipient: party(1, "Prime"), sector: { relative: { x: 0, y: 0, z: 0 } },
        body: "Hello neighbour. Metal asteroid two sectors out.", status: "unread", readAt: null, createdAt: iso(-3_600_000), updatedAt: iso(-3_600_000) },
      { id: 10, sender: party(2, "Scout"), recipient: party(1, "Prime"), sector: { relative: { x: 0, y: 0, z: 0 } },
        body: "Test from Scout.", status: "read", readAt: iso(-DAY), createdAt: iso(-2 * DAY), updatedAt: iso(-DAY) },
    ],
  };
  const logbook: S["ProbeLogbookPage"][] = [
    { id: 1, probeId: 1, title: "First relay", sortOrder: 1, content: "The relay is stable.", createdAt: iso(-5 * DAY), updatedAt: iso(-DAY) } as S["ProbeLogbookPage"],
  ];
  const author = { playerId: 7, username: "gnome", displayName: "Gnome" };
  const forum = {
    categories: [{ id: 1, name: "General", description: "Anything goes", sortOrder: 1, createdAt: iso(-30 * DAY), updatedAt: iso(-30 * DAY) }] as S["ForumCategory"][],
    posts: [{ id: 5, categoryId: 1, author, title: "Where are the blueprints?", pinned: false, firstMessageId: 50, messageCount: 2,
      createdAt: iso(-2 * DAY), updatedAt: iso(-DAY), lastMessageAt: iso(-DAY) }] as S["ForumPost"][],
    messages: [
      { id: 50, postId: 5, author, body: "Has anyone found a dormant construct?", createdAt: iso(-2 * DAY), updatedAt: iso(-2 * DAY), editedAt: null },
      { id: 51, postId: 5, author: { playerId: 1, username: "mock", displayName: "Mock" }, body: "Inspect them with a Manny.", createdAt: iso(-DAY), updatedAt: iso(-DAY), editedAt: null },
    ] as S["ForumMessage"][],
  };

  // Mock-only recipe list. The first four follow the spec's example; the rest are
  // simplified stand-ins so tests have a tree to walk. The panel always uses the live list.
  const ing = (type: S["CraftingRecipeIngredient"]["type"], quantity: number): S["CraftingRecipeIngredient"] => ({
    type, quantity, unit: ["metals", "ice", "deuterium", "carbon_compounds"].includes(type) ? "earth_container_equivalent" : "item",
  });
  const recipe = (id: S["CraftingRecipe"]["id"], by: "manny" | "atomic_3d_printer", ingredients: S["CraftingRecipeIngredient"][], durationSeconds: number, space: number): S["CraftingRecipe"] => ({
    id, name: id.replaceAll("_", " "), description: "Mock recipe.", craftableBy: [by], ingredients, durationSeconds,
    output: { type: id, name: id.replaceAll("_", " "), containerSpace: space, containerSpaceUnit: "earth_container_equivalent" },
  });
  const recipes: S["CraftingRecipe"][] = [
    recipe("waypoint_bookmark", "manny", [ing("metals", 0.01)], 600, 0.01),
    recipe("solar_panel", "manny", [ing("micro_conductor", 2), ing("crystal_substrate", 1), ing("ceramic_insulator", 1), ing("steel_plate", 1), ing("metals", 0.02)], 1800, 0.015),
    recipe("integrated_circuit", "atomic_3d_printer", [ing("micro_conductor", 2), ing("deuterium", 0.05)], 1200, 0.001),
    recipe("atomic_printer_part", "atomic_3d_printer", [ing("micro_conductor", 2), ing("deuterium", 0.05)], 2700, 0.01),
    recipe("steel_bar", "manny", [ing("metals", 0.02)], 300, 0.005),
    recipe("steel_plate", "manny", [ing("steel_bar", 2)], 300, 0.005),
    recipe("micro_conductor", "atomic_3d_printer", [ing("metals", 0.005)], 600, 0.001),
    recipe("electric_motor", "manny", [ing("steel_bar", 1), ing("micro_conductor", 1)], 900, 0.01),
  ];
  return { probes, farProbe, summaries, mannies, alerts, sector, visited, missions, visitedSectorObs, neighborScan, improvements, recipes, messages, logbook, forum };
}

/** Extra FCC-valid visited sectors for MOCK_GALAXY=1. */
const GALAXY: Array<[number, number, number]> = [
  [-1, 1, 0], [-2, 2, 0], [-1, 2, 1], [0, 2, 0], [1, 1, 2], [2, 2, 0], [3, 1, 0], [3, -1, 0], [2, -1, -1],
  [1, -1, 0], [0, -1, -1], [-1, 0, -1], [-2, 0, 0], [-3, 1, 0], [4, 0, 0], [3, -2, -1], [0, 0, 2], [1, 0, 1],
];
function galaxyObjects(v: { x: number; y: number; z: number }): S["SectorObject"][] | null {
  const i = GALAXY.findIndex(([x, y, z]) => x === v.x && y === v.y && z === v.z);
  if (i < 0) return null;
  const o = (type: string, extra: Record<string, unknown> = {}) => ({ id: `g${i}-${type}`, type, name: type, summary: type, ...extra }) as unknown as S["SectorObject"];
  const sys = (stars: number, planets: number) => o("solar_system", { starCount: stars, planetCount: planets, orbitalBodyCount: planets });
  switch (i % 9) {
    case 0: return [sys(1, 4), o("asteroid")];
    case 1: return [o("asteroid"), o("asteroid")];
    case 2: return [sys(2, 2), o("scut_relay")];
    case 3: return [o("black_hole")];
    case 4: return [sys(1, 6), o("dormant_construct")];
    case 5: return [o("dust_cloud")];
    case 6: return [sys(1, 1), o("asteroid", { distinctiveFeature: "Sculpted in the shape of a duck" })];
    case 7: return [o("star"), o("planet"), o("deuterium_refuel_station")];
    default: return [];
  }
}
