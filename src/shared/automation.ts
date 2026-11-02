/** Types shared by the automation engine and the UI. */
import type { AutoFixMode } from "./problems.js";
import type { CraftGoal } from "./crafting.js";

export type Resource = "deuterium" | "metals" | "ice" | "carbon_compounds";
export type ProbeRole = "Probe" | "Station" | "Hauler" | "Tanker" | "Scout" | "Miner";

export interface ProbeAutomationSettings {
  mining: boolean;
  /** Most Mannies of this probe mining at once. */
  maxMiners: number;
  /** Idle onboard Mannies always kept free for fixes. */
  keepIdle: number;
  /** ECE per mining order (one Manny trip carries 0.05). */
  orderAmount: number;
  /** Stock targets in ECE; deuterium is a percent of the tank. */
  targets: { metals: number; ice: number; carbon_compounds: number; deuteriumPercent: number };
  role: ProbeRole;
}

export interface AutomationSettings {
  mode: AutoFixMode;
  inspectConstructs: boolean;
  naming: boolean;
  /** Work through each probe's crafting queue. */
  crafting: boolean;
  /** Per-probe ordered crafting goals, keyed by probe id. */
  craftQueue: Record<string, CraftGoal[]>;
  defaults: ProbeAutomationSettings;
  probes: Record<string, Partial<ProbeAutomationSettings>>;
  /** Entity keys ("probe:1", "manny:mny_x", "container:1:cid") never renamed. */
  lockedNames: string[];
}

export type AutomationPlan =
  | { kind: "mine"; probeId: number; mannyId: string; objectId: string; resources: Resource[]; targetAmount: number }
  | { kind: "inspect"; probeId: number; mannyId: string; objectId: string }
  | { kind: "craft"; probeId: number; mannyId: string; recipe: string; output: string }
  | { kind: "print"; probeId: number; mannyId: string; recipe: string; output: string }
  | { kind: "assemble"; probeId: number; mannyId: string; model: "generic" | "deuterium_tanker"; containerIds: string[] }
  | { kind: "improve"; probeId: number; mannyId: string; improvement: string }
  | { kind: "rename_probe"; probeId: number; name: string }
  | { kind: "rename_manny"; probeId: number; mannyId: string; name: string }
  | { kind: "rename_container"; probeId: number; containerId: string; label: string };

export interface AutomationAction {
  id: string;
  label: string;
  why: string;
  endpoint: string;
  plan: AutomationPlan;
}

export interface PlannedRename {
  entity: string;
  kind: "probe" | "manny" | "container";
  probeId: number;
  current: string;
  planned: string;
  locked: boolean;
  reachable: boolean;
}

export interface AutomationLogEntry {
  at: string;
  actionId: string;
  label: string;
  endpoint: string;
  dryRun: boolean;
  ok: boolean;
  status: number | null;
  code: string | null;
  message: string | null;
}

export const DEFAULT_PROBE_SETTINGS: ProbeAutomationSettings = {
  mining: true,
  maxMiners: 20,
  keepIdle: 1,
  orderAmount: 0.1,
  targets: { metals: 0.3, ice: 0.2, carbon_compounds: 0.2, deuteriumPercent: 80 },
  role: "Probe",
};
