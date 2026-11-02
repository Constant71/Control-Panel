/**
 * Stations step 5d: production modes. Each mode turns into ordinary crafting goals ("keep at
 * least N of item aboard the station"), which the 3b crafting planner works through with
 * POST .../mannies/{id}/craft and POST .../atomic-printer/craft. Parts are crafted first
 * (ingredients as their own jobs, so they run in parallel): the spec's MannyCraftRequest only
 * takes `recipe`, so a single "whole build" order is not relied on.
 * Probe builds themselves stay confirm cards on the Builds page (assemble-probe).
 */
import { KITS } from "./builds.js";
import type { Snapshot } from "./poller.js";
import type { CraftGoal } from "../shared/crafting.js";
import { isFullProbe } from "../shared/attention.js";
import type { ProductionGoal, StationConfig, StationsData } from "../shared/stations.js";

const MAX_MANNY_GOAL = 200;

export function productionGoals(cfg: StationConfig, data: Pick<StationsData, "members">, snapshot: Snapshot): ProductionGoal[] {
  const out: ProductionGoal[] = [];
  const add = (item: string, quantity: number, why: string) => {
    const at = out.find((g) => g.item === item);
    if (at) {
      if (quantity > at.quantity) Object.assign(at, { quantity, why });
    } else out.push({ item, quantity, why });
  };
  // Item stock targets apply in every mode.
  for (const t of cfg.targets) if (t.kind === "item" && t.min > 0) add(t.item, t.min, `Stock target: keep ${t.min}.`);

  if (cfg.mode === "manny_factory") {
    // Enough for the station itself plus every group probe below its role's Manny target.
    const views = new Map(snapshot.probes.map((v) => [v.summary.id, v]));
    let groupShort = 0;
    for (const [id, m] of Object.entries(data.members)) {
      if (m.stationId !== cfg.probeId || !m.role) continue;
      const have = views.get(Number(id))?.mannies?.length;
      if (have !== undefined) groupShort += Math.max(0, cfg.mannyPerRole[m.role] - have);
    }
    const n = Math.min(MAX_MANNY_GOAL, cfg.mannyTarget + groupShort);
    if (n > 0) add("manny", n, `Manny factory: ${cfg.mannyTarget} for the station${groupShort ? ` plus ${groupShort} its group is short` : ""}.`);
  }

  if (cfg.mode === "probe_yard") {
    for (const [item, n] of Object.entries(KITS[cfg.yardModel])) add(item, n, `Probe yard: the ${cfg.yardModel.replace("_", " ")} assembly kit.`);
  }
  return out;
}

export function toCraftGoals(stationId: number, goals: ProductionGoal[]): CraftGoal[] {
  return goals.map((g) => ({ id: `station:${stationId}:${g.item}`, item: g.item, quantity: g.quantity, once: false, note: g.why, addedAt: "" }));
}

/** A helper needs room for raw resources and parts while it builds (one Manny is about 1 ECE of steel parts alone). */
export const HELPER_MIN_STORAGE = 2;

/** How many Mannies the station wants aboard: its Manny factory goal, or a Manny line in its own crafting queue. */
export function stationMannyWant(cfg: StationConfig, data: Pick<StationsData, "members">, snapshot: Snapshot, queued: CraftGoal[]): number {
  const fromMode = productionGoals(cfg, data, snapshot).find((g) => g.item === "manny")?.quantity ?? 0;
  const fromQueue = Math.max(0, ...queued.filter((g) => g.item === "manny").map((g) => g.quantity));
  return Math.max(fromMode, fromQueue);
}

export interface HelperPlan {
  /** Station id → how many Mannies it wants aboard. */
  want: Record<number, number>;
  /** Group probes building Mannies now, with the station they build for. */
  builders: Map<number, number>;
  /** Group probe id → why it is or isn't helping (shown on its card). */
  notes: Record<number, string>;
}

/**
 * Which group probes build Mannies for their station. Any role but Scout can help, as long as it
 * has an atomic printer (GET /api/probe/{id} inventory item atomic_3d_printer) and enough storage.
 */
export function planHelpers(stations: StationConfig[], data: Pick<StationsData, "members">, snapshot: Snapshot, queued: (probeId: number) => CraftGoal[]): HelperPlan {
  const out: HelperPlan = { want: {}, builders: new Map(), notes: {} };
  const views = new Map(snapshot.probes.map((v) => [v.summary.id, v]));
  for (const cfg of stations) {
    const sv = views.get(cfg.probeId);
    const want = stationMannyWant(cfg, data, snapshot, queued(cfg.probeId));
    out.want[cfg.probeId] = want;
    const have = sv?.mannies?.length;
    if (!cfg.helperBuilds || have === undefined || have >= want) continue;
    const stationName = sv!.summary.name;
    for (const [id, m] of Object.entries(data.members)) {
      if (m.stationId !== cfg.probeId || !m.role) continue;
      const v = views.get(Number(id));
      if (!v || !v.summary.isReachable || !isFullProbe(v.detail) || !v.mannies) continue;
      const inv = v.detail.inventory;
      if (m.role === "Scout") continue;
      if (!inv?.items.some((i) => i.type === "atomic_3d_printer")) {
        out.notes[Number(id)] = "Not building Mannies: no atomic printer aboard.";
        continue;
      }
      if ((inv.capacity ?? 0) < HELPER_MIN_STORAGE) {
        out.notes[Number(id)] = `Not building Mannies: ${inv.capacity} ECE of storage; a helper needs at least ${HELPER_MIN_STORAGE}.`;
        continue;
      }
      out.builders.set(Number(id), cfg.probeId);
      out.notes[Number(id)] = `Building Mannies for ${stationName} (${have} of ${want} there); each finished one moves to the station.`;
    }
  }
  return out;
}

/** One Manny at a time on each helper: always one more than it has now, so its printer never sits idle. */
export function helperGoals(plan: HelperPlan, snapshot: Snapshot): Record<string, CraftGoal[]> {
  const out: Record<string, CraftGoal[]> = {};
  for (const [id, stationId] of plan.builders) {
    const v = snapshot.probes.find((x) => x.summary.id === id);
    const have = v?.mannies?.length ?? 0;
    const station = snapshot.probes.find((x) => x.summary.id === stationId)?.summary.name ?? `probe ${stationId}`;
    out[String(id)] = [{ id: `helper:${stationId}:manny`, item: "manny", quantity: have + 1, once: false, note: `Mannies for ${station}`, addedAt: "" }];
  }
  return out;
}
