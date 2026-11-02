/** Types for the crafting queue and build suggestions (step 3b), shared by server and UI. */
import type { Resource } from "./automation.js";

/** "Keep at least `quantity` of `item` aboard this probe." `once` goals are removed when reached. */
export interface CraftGoal {
  id: string;
  item: string;
  quantity: number;
  once: boolean;
  note?: string;
  addedAt: string;
}

export type StepStatus =
  | "starting" // being ordered this refresh
  | "in_progress"
  | "needs_ingredients" // waiting for sub-crafts
  | "needs_resources" // mining has been asked for the shortfall
  | "needs_manny"
  | "printer_busy"
  | "no_printer"
  | "no_room"
  | "no_recipe";

export interface CraftStep {
  item: string;
  name: string;
  by: "manny" | "atomic_3d_printer" | null;
  /** Crafts still needed for this goal at this level of the tree. */
  count: number;
  status: StepStatus;
  detail: string;
  depth: number;
}

export interface GoalStatus {
  probeId: number;
  goal: CraftGoal;
  have: number;
  inProgress: number;
  done: boolean;
  steps: CraftStep[];
  shortfalls: Partial<Record<Resource, number>>;
  /** Sum of remaining craft durations (Manny-seconds), not wall time. */
  workSeconds: number;
}

export interface TrackedCraft {
  probeId: number;
  mannyId: string;
  recipe: string;
  output: string;
  at: string;
}

export interface KitLine {
  item: string;
  need: number;
  have: number;
}

export interface Suggestion {
  id: string;
  kind: "assemble_probe" | "install_improvement" | "move_probe";
  probeId: number;
  probeName: string;
  title: string;
  ready: boolean;
  /** Why the panel suggests it, from live game state. */
  why: string[];
  /** What it uses up. */
  consumes: KitLine[];
  missing: KitLine[];
  /** What can go wrong, and what the panel does about it. */
  risks: string[];
  blockers: string[];
  mannyId: string | null;
  mannyName: string | null;
  containerIds: string[];
  model?: "generic" | "deuterium_tanker";
  improvement?: string;
  target?: { x: number; y: number; z: number };
  durationSeconds: number;
  endpoint: string;
}
