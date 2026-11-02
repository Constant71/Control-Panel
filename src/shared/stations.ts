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
  createdAt: string;
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
};

export const MODE_LABEL: Record<StationMode, string> = {
  parts: "Parts",
  manny_factory: "Manny factory",
  probe_yard: "Probe yard",
};
