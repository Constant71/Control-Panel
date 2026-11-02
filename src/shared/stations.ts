/**
 * Stations (Merchant's design, 2026-11-01). The game has no stations: the panel marks a probe as a
 * fixed production hub and gives it a group of probes with roles. Everything here lives in the
 * panel's own data; only ordinary API calls ever reach the game.
 */

export type StationMode = "parts" | "manny_factory" | "probe_yard";
export type MemberRole = "Hauler" | "Tanker" | "Scout";
export const MEMBER_ROLES: MemberRole[] = ["Hauler", "Tanker", "Scout"];
export type StockResource = "metals" | "ice" | "carbon_compounds" | "deuterium";

export type StockTarget =
  /** At least `min` ECE of a resource in storage. */
  | { kind: "resource"; resource: StockResource; min: number }
  /** At least `min` of an item type (as listed in the probe inventory). */
  | { kind: "item"; item: string; min: number };

export interface StationConfig {
  probeId: number;
  mode: StationMode;
  targets: StockTarget[];
  /** The station's own tank is never drawn below this percent (enough for one flee jump). */
  fuelFloorPercent: number;
  /** Mannies kept at the station itself. */
  mannyTarget: number;
  /** Mannies each group probe of that role should carry. */
  mannyPerRole: Record<MemberRole, number>;
  /** Docked service (5b): container hand-offs and refuelling while a group probe is docked. */
  service: boolean;
  /** A hand-off container goes to the station once it is at least this full. */
  handoffMinFillPercent: number;
  /** Additional containers each Hauler should carry (never more than 4: movement link risk). */
  containersPerHauler: number;
  /** Docked group probes are topped up to this percent of their tank. */
  ferryFuelTargetPercent: number;
  /** A docked Tanker never gives the station fuel below this percent of its own tank. */
  tankerReservePercent: number;
  /** Dispatch (5c): send idle Haulers to mine what the station is short of, inside its SCUT network. */
  dispatch: boolean;
  /** A trip heads home after this long at the mining sector, full or not. */
  maxTripHours: number;
  /** Fuel left after the round trip must stay above this percent of the tank. */
  tripFuelMarginPercent: number;
  createdAt: string;
}

export type TripState = "outbound" | "mining" | "returning" | "handing_over" | "done" | "failed";

export interface Trip {
  id: string;
  stationId: number;
  haulerId: number;
  target: { x: number; y: number; z: number };
  home: { x: number; y: number; z: number };
  resource: string;
  reason: string;
  state: TripState;
  startedAt: string;
  updatedAt: string;
  /** When the hauler reached the mining sector. */
  arrivedAt: string | null;
  note: string | null;
}

export interface StorageRules {
  priority?: string[];
  exclusion?: string[];
  strictExclusion?: string[];
}

export type StationOpPlan =
  | { kind: "rules"; probeId: number; containerId: string; rules: StorageRules }
  | { kind: "detach"; probeId: number; mannyId: string; containerId: string; toProbeId: number; purpose: "full" | "empty" }
  | { kind: "refuel"; probeId: number; mannyId: string; targetProbeId: number; amount: number }
  | { kind: "recover"; probeId: number; mannyId: string; objectId: string; handoffId: string }
  | { kind: "trip_move"; probeId: number; target: { x: number; y: number; z: number }; tripId: string; leg: "out" | "home"; resource: string; reason: string }
  | { kind: "trip_mine"; probeId: number; mannyId: string; objectId: string; resource: string; targetAmount: number; tripId: string };

export interface StationOp {
  id: string;
  stationId: number;
  label: string;
  why: string;
  endpoint: string;
  plan: StationOpPlan;
}

export interface Handoff {
  id: string;
  stationId: number;
  containerId: string;
  fromProbeId: number;
  toProbeId: number;
  purpose: "full" | "empty";
  state: "sent" | "recovering" | "done" | "failed";
  at: string;
  updatedAt: string;
  /** detached_container objects already in the sector when the detach was sent. */
  sectorBefore: string[];
  note: string | null;
}

export interface StationMember {
  stationId: number;
  /** null until Merchant picks one (e.g. a probe just assembled at the station). */
  role: MemberRole | null;
  joinedAt: string;
}

export interface StationLogEntry {
  at: string;
  stationId: number;
  probeId: number | null;
  label: string;
  endpoint: string | null;
  ok: boolean;
  message: string | null;
}

export interface StationsData {
  stations: StationConfig[];
  /** Keyed by probe id. */
  members: Record<string, StationMember>;
  log: StationLogEntry[];
}

export interface TargetStatus {
  key: string;
  label: string;
  unit: string;
  have: number | null;
  min: number;
  /** How far below the floor, 0 when met. */
  short: number;
}

export interface Check {
  ok: boolean;
  text: string;
}

export interface MemberStatus {
  probeId: number;
  name: string;
  role: MemberRole | null;
  reachable: boolean;
  status: string;
  sector: { x: number; y: number; z: number } | null;
  /** Same sector as the station and not moving: hand-offs are possible. */
  docked: boolean;
  fuelPercent: number | null;
  additionalContainers: number | null;
  mannies: number | null;
  mannyTarget: number | null;
  notes: string[];
}

export interface StationStatus {
  probeId: number;
  name: string;
  config: StationConfig;
  reachable: boolean;
  isDefault: boolean;
  status: string;
  sector: { x: number; y: number; z: number } | null;
  scutNetworks: string[];
  fuelPercent: number | null;
  integrity: number | null;
  additionalContainers: number | null;
  targets: TargetStatus[];
  members: MemberStatus[];
  checks: Check[];
  /** What docked service would do next, with reasons. */
  next: StationOp[];
  handoffs: Handoff[];
  trips: Trip[];
  /** Why dispatch is or isn't sending a trip right now. */
  dispatchNotes: string[];
}

export const DEFAULT_STATION: Omit<StationConfig, "probeId" | "createdAt"> = {
  mode: "parts",
  targets: [
    { kind: "resource", resource: "metals", min: 5 },
    { kind: "resource", resource: "ice", min: 2 },
    { kind: "resource", resource: "carbon_compounds", min: 2 },
  ],
  fuelFloorPercent: 60,
  mannyTarget: 12,
  mannyPerRole: { Hauler: 6, Tanker: 2, Scout: 2 },
  service: true,
  handoffMinFillPercent: 80,
  containersPerHauler: 2,
  ferryFuelTargetPercent: 90,
  tankerReservePercent: 30,
  dispatch: true,
  maxTripHours: 6,
  tripFuelMarginPercent: 20,
};

export const MODE_LABEL: Record<StationMode, string> = {
  parts: "Parts",
  manny_factory: "Manny factory",
  probe_yard: "Probe yard",
};
