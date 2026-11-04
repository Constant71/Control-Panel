/** Types shared by the server's problem/fix engine and the web UI. */

export type Severity = "critical" | "warning" | "info";
export type AutoFixMode = "auto" | "dry_run" | "off";

/** One concrete API call that can resolve (part of) a problem. */
export type FixPlan =
  | { kind: "transfer_manny"; probeId: number; mannyId: string; targetProbeId: number }
  | {
      kind: "storage_move";
      probeId: number;
      actorMannyId: string;
      resourceType: "metals" | "ice" | "carbon_compounds";
      amount: number;
      fromContainerId: string;
      toContainerId: string;
    }
  | { kind: "storage_move_items"; probeId: number; actorMannyId: string; itemIds: string[]; fromContainerId: string; toContainerId: string }
  | { kind: "drop_cargo"; probeId: number; mannyId: string }
  | { kind: "repair"; probeId: number; mannyId: string; integrityPercent: number }
  | { kind: "refill_tank"; probeId: number; mannyId: string }
  | { kind: "transfer_deuterium"; probeId: number; mannyId: string; targetProbeId: number; amount: number }
  | { kind: "salvage"; probeId: number; mannyId: string; objectId: string }
  | { kind: "recall"; probeId: number; mannyId: string }
  | { kind: "mind_snapshot_reassign" }
  | { kind: "cancel_move"; probeId: number };

export interface FixOption {
  /** Stable id: same plan target → same id across polls. */
  id: string;
  label: string;
  /** Why this fix, in plain words. */
  why: string;
  /** auto: the engine runs it on its own. confirm: only when you press it. */
  mode: "auto" | "confirm";
  /** The real endpoint this calls, for transparency. */
  endpoint: string;
  plan: FixPlan;
}

export interface Problem {
  /** Stable key, e.g. "manny:mny_x:waiting_for_space". */
  key: string;
  severity: Severity;
  code: string;
  title: string;
  detail: string;
  probeId: number | null;
  probeName: string | null;
  mannyId: string | null;
  mannyName: string | null;
  /** When the condition started, if the API says. */
  since: string | null;
  /** When the game will act on its own (e.g. 7-day abandonment). */
  deadline: string | null;
  /** Spec field(s) the detection relies on. */
  source: string;
  fixes: FixOption[];
  /** Shown when no API call can fix it. */
  advice: string | null;
}

export interface FixLogEntry {
  at: string;
  problemKey: string;
  problemTitle: string;
  fixId: string;
  label: string;
  endpoint: string;
  initiator: "auto" | "you";
  /** Manny the fix gave an order to, if any. */
  mannyId?: string | null;
  why?: string;
  dryRun: boolean;
  ok: boolean;
  status: number | null;
  code: string | null;
  message: string | null;
}

export interface FixAttemptState {
  lastAttemptAt: string;
  lastOk: boolean;
  failures: number;
  nextEligibleAt: string;
}

export type DiscoveryKind =
  | "dormant_construct"
  | "new_blueprint"
  | "blueprint_shared"
  | "abandoned_manny"
  | "detached_container"
  | "drifting_item"
  | "deuterium_refuel_station"
  | "scut_relay";

export interface Discovery {
  key: string;
  kind: DiscoveryKind;
  title: string;
  detail: string;
  sector: { x: number; y: number; z: number } | null;
  objectId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  read: boolean;
  /** True while it is still present in the latest scan or list. */
  present: boolean;
}

export interface SectorScanInfo {
  key: string;
  sector: { x: number; y: number; z: number };
  scannedAt: string | null;
  objectCount: number;
  knowledgeLevel: string | null;
  error: string | null;
}
