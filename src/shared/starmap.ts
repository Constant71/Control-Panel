/**
 * Data for the projector star map (/projector). Everything here comes from API data the
 * panel already polls; nothing is invented:
 *  - visited sectors: GET /api/visited-sectors (relativeCoordinates, visitCount, lastVisitedAt)
 *  - what is in them: the SectorObject list of GET /api/sector / the probe's current sector
 *    (type, plus starCount / planetCount on solar_system objects), as the Discoveries scanner
 *    stores it per sector
 *  - SCUT coverage: SectorObservation.scutCoverageStatus and scutNetworks
 *  - unvisited neighbours: passive neighbour scans (estimatedObjects.star, planetCountMin/Max,
 *    blackHoleProbability, dangerEstimate, confidence) fetched for exploring probes
 *  - probes: ProbeSummary + Probe.sector.relative + Probe.movement (origin, target, startedAt, arrivalAt)
 */
type Vec = { x: number; y: number; z: number };

/** Counts of what a sector scan listed. Stars and planets include those nested in solar_system objects. */
export interface SectorProfile {
  stars: number;
  planets: number;
  asteroids: number;
  blackHoles: number;
  dustClouds: number;
  constructs: number;
  relays: number;
  refuelStations: number;
  missiles: number;
  ducks: number;
}

export interface StarMapSector {
  pos: Vec;
  visitCount: number;
  lastVisitedAt: string | null;
  /** Null until the scanner has looked at the sector. */
  profile: SectorProfile | null;
  coverage: string | null;
  scutNetworkIds: number[];
  /** An unread potential blueprint (dormant construct discovery) that is still present here. */
  newDiscovery: boolean;
}

export interface StarMapFrontier {
  pos: Vec;
  star: boolean | null;
  planetsMin: number | null;
  planetsMax: number | null;
  blackHoleProbability: number;
  danger: string | null;
  confidence: number;
}

export interface StarMapProbe {
  id: number;
  name: string;
  pos: Vec | null;
  reachable: boolean;
  isDefault: boolean;
  station: boolean;
  status: string;
  /** Present while an intersector movement is under way. */
  move: { origin: Vec; target: Vec; startedAt: string; arrivalAt: string; status: string } | null;
}

export interface StarMapData {
  generatedAt: string;
  sectors: StarMapSector[];
  frontier: StarMapFrontier[];
  probes: StarMapProbe[];
  /** Worst open problem, used to tint the room. */
  mood: "calm" | "warning" | "critical";
}

const key = (v: Vec) => `${v.x},${v.y},${v.z}`;

export function emptyProfile(): SectorProfile {
  return { stars: 0, planets: 0, asteroids: 0, blackHoles: 0, dustClouds: 0, constructs: 0, relays: 0, refuelStations: 0, missiles: 0, ducks: 0 };
}

/** Summarises a SectorObject list. */
export function sectorProfile(objects: ReadonlyArray<Record<string, unknown>>): SectorProfile {
  const p = emptyProfile();
  for (const o of objects) {
    switch (o.type) {
      case "star": p.stars++; break;
      case "solar_system":
        p.stars += Number(o.starCount ?? 1);
        p.planets += Number(o.planetCount ?? 0);
        break;
      case "planet": p.planets++; break;
      case "asteroid":
        p.asteroids++;
        if (o.distinctiveFeature) p.ducks++;
        break;
      case "black_hole": p.blackHoles++; break;
      case "dust_cloud": p.dustClouds++; break;
      case "dormant_construct": p.constructs++; break;
      case "scut_relay": p.relays++; break;
      case "deuterium_refuel_station": p.refuelStations++; break;
      case "missile": p.missiles++; break;
    }
  }
  return p;
}

export interface StarMapInput {
  visited: Array<{ relativeCoordinates: Vec; visitCount: number; lastVisitedAt: string }>;
  knowledge: Array<{ sector: Vec; profile: SectorProfile | null; coverage: string | null; scutNetworkIds: number[] }>;
  neighbourScans: Array<{
    relativeCoordinates: Vec;
    confidence: number;
    estimatedObjects?: Record<string, unknown>;
  }>;
  probes: Array<{
    summary: { id: number; name: string; isReachable: boolean; isDefault: boolean };
    detail: { status: string; sector?: { relative?: Vec | null } | null; movement?: StarMapProbe["move"] | null } | null;
  }>;
  stationIds: number[];
  discoveries: Array<{ kind: string; sector: Vec | null; read: boolean; present: boolean }>;
  problemSeverities: string[];
  now: number;
}

export function buildStarMap(input: StarMapInput): StarMapData {
  const know = new Map(input.knowledge.map((k) => [key(k.sector), k]));
  const fresh = new Set(input.discoveries.filter((d) => d.kind === "dormant_construct" && !d.read && d.present && d.sector).map((d) => key(d.sector!)));
  const sectors = new Map<string, StarMapSector>();
  const addSector = (pos: Vec, visitCount: number, lastVisitedAt: string | null) => {
    const k = key(pos);
    const kn = know.get(k);
    sectors.set(k, {
      pos, visitCount, lastVisitedAt,
      profile: kn?.profile ?? null, coverage: kn?.coverage ?? null, scutNetworkIds: kn?.scutNetworkIds ?? [],
      newDiscovery: fresh.has(k),
    });
  };
  for (const v of input.visited) addSector(v.relativeCoordinates, v.visitCount, v.lastVisitedAt);

  const probes: StarMapProbe[] = input.probes.map(({ summary, detail }) => {
    const m = detail?.movement;
    const moving = m && !["arrived", "failed", "destroyed"].includes(m.status);
    return {
      id: summary.id, name: summary.name, pos: detail?.sector?.relative ?? null,
      reachable: summary.isReachable, isDefault: summary.isDefault,
      station: input.stationIds.includes(summary.id), status: detail?.status ?? "unknown",
      move: moving ? { origin: m.origin, target: m.target, startedAt: m.startedAt, arrivalAt: m.arrivalAt, status: m.status } : null,
    };
  });
  // A probe sitting somewhere the visited list hasn't caught up with yet still gets a node.
  for (const p of probes) if (p.pos && !sectors.has(key(p.pos))) addSector(p.pos, 0, null);

  const frontier: StarMapFrontier[] = [];
  const seen = new Set<string>();
  for (const s of input.neighbourScans) {
    const k = key(s.relativeCoordinates);
    if (sectors.has(k) || seen.has(k)) continue;
    seen.add(k);
    const e = s.estimatedObjects ?? {};
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    frontier.push({
      pos: s.relativeCoordinates,
      star: typeof e.star === "boolean" ? e.star : null,
      planetsMin: num(e.planetCountMin), planetsMax: num(e.planetCountMax),
      blackHoleProbability: num(e.blackHoleProbability) ?? 0,
      danger: typeof e.dangerEstimate === "string" ? e.dangerEstimate : null,
      confidence: s.confidence ?? 0,
    });
  }

  const mood = input.problemSeverities.includes("critical") ? "critical" : input.problemSeverities.includes("warning") ? "warning" : "calm";
  return { generatedAt: new Date(input.now).toISOString(), sectors: [...sectors.values()], frontier, probes, mood };
}

/** Everything the panel knows about one sector, for the tap card on the Map page (GET /panel-api/sector-info). */
export interface SectorInfo {
  pos: Vec;
  visited: { visitCount: number; firstVisitedAt: string; lastVisitedAt: string } | null;
  /** Last stored scan (GET /api/sector or the probe's current sector), null if never scanned. */
  scan: {
    scannedAt: string | null;
    knowledgeLevel: string | null;
    error: string | null;
    coverage: string | null;
    /** ECE per mineable resource, summed over mineable targets. */
    resources: Record<string, number>;
    /** SectorObject list as the game returned it. */
    objects: Array<Record<string, unknown>>;
    detail: { confidence: number; possibleObjects: string[]; navigationalRisk: string | null; sensorMode: string | null; dataFreshness: string | null; scutNetworks: Array<{ id: number; name?: string }> } | null;
  } | null;
  /** Passive neighbour scan of an unvisited sector. */
  neighbourScan: {
    confidence: number;
    knowledgeLevel: string;
    estimatedObjects: Record<string, unknown>;
    possibleObjects: string[];
    navigationalRisk: string | null;
    scutCoverageStatus: string;
    message: string | null;
  } | null;
  probes: Array<{
    id: number; name: string; status: string; reachable: boolean; isDefault: boolean; station: boolean;
    role: string | null; explore: boolean;
    /** Exploration status line when Explore is on. */
    exploring: { state: string; text: string } | null;
    /** Set when the probe is flying here. */
    arrivingAt: string | null;
  }>;
  discoveries: Array<{ kind: string; title: string; detail: string; read: boolean; present: boolean; firstSeenAt: string }>;
  /** How exploring probes rate this sector as a next hop. */
  candidates: Array<{ probeName: string; score: number; notes: string[]; safe: boolean }>;
}
