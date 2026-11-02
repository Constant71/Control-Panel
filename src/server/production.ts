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
