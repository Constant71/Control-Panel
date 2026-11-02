/**
 * Build suggestions (step 3b): probe assembly and probe improvements.
 * They are never sent automatically. Each one is a card with why, what it uses
 * up and what can go wrong, and it waits for Merchant's confirmation.
 *
 * Kit contents are from the spec text of POST /api/probe/{id}/mannies/{mannyId}/assemble-probe:
 *   generic: two empty additional containers, 1 deuterium engine, 1 SCUT relay,
 *            5 electric motors, 2 atomic printer parts, 4 solar panels
 *   deuterium_tanker: generic kit + 10 steel plates, 2 linear actuators, 1 integrated circuit
 * Tanker facts (ProbeFuel.maxDeuterium, damage-warnings description): 400-point tank
 * vs 100 for a generic probe; fragile container chains start at 2 additional containers instead of 5.
 */
import type { Schemas } from "./gameClient.js";
import type { Snapshot } from "./poller.js";
import { isFullProbe } from "../shared/attention.js";
import type { KitLine, Suggestion } from "../shared/crafting.js";
import { stockOf, dur } from "./crafting.js";

export const ASSEMBLY_SECONDS = 3 * 3600;
const FALLBACK_MANNY_SPACE = 0.05;

export const KITS: Record<"generic" | "deuterium_tanker", Record<string, number>> = {
  generic: { deuterium_engine: 1, scut_relay: 1, electric_motor: 5, atomic_printer_part: 2, solar_panel: 4 },
  deuterium_tanker: {
    deuterium_engine: 1, scut_relay: 1, electric_motor: 5, atomic_printer_part: 2, solar_panel: 4,
    steel_plate: 10, linear_actuator: 2, integrated_circuit: 1,
  },
};

/** Improvement ids accepted by MannyProbeImprovementRequest. */
const INSTALLABLE = new Set(["deuterium_compression", "reinforced_container_couplings", "relativistic_path_clearing"]);

const nice = (t: string) => t.replaceAll("_", " ");

export interface BuildInput {
  snapshot: Snapshot;
  /** Per-probe GET /api/probe/{id}/probe-improvements-available results. */
  improvements: Record<string, Schemas["ProbeImprovement"][]>;
  busy: Set<string>;
}

export function buildSuggestions({ snapshot, improvements, busy }: BuildInput): Suggestion[] {
  const out: Suggestion[] = [];
  const fleet = snapshot.probes.length;
  const lowFuel = snapshot.probes
    .filter((v) => isFullProbe(v.detail) && v.detail.fuel.maxDeuterium && v.detail.fuel.deuterium / v.detail.fuel.maxDeuterium < 0.25)
    .map((v) => v.summary.name);
  const tankers = snapshot.probes.filter((v) => v.summary.model === "deuterium_tanker").length;

  for (const v of snapshot.probes) {
    if (!v.summary.isReachable || !isFullProbe(v.detail) || !v.mannies || !v.detail.inventory) continue;
    const p = v.detail;
    const inv = p.inventory!;
    const moving = !!p.movement && !["arrived", "failed", "destroyed"].includes(p.movement.status);
    const broken = ["dead", "disabled", "trapped_by_black_hole"].includes(p.status);
    const stock = stockOf(p, v.mannies);
    const idle = v.mannies.filter((m) => m.location.type === "probe" && m.currentTask === null && m.canReceiveOrders && !busy.has(m.id));
    const manny = idle[0] ?? null;
    const assembling = v.mannies.filter((m) => m.currentTask === "assembling_probe");
    const mannySpace = Math.max(0, ...inv.items.filter((i) => i.type === "manny").map((i) => i.containerSpace)) || FALLBACK_MANNY_SPACE;
    const outside = v.mannies.filter((m) => m.location.type === "sector");
    const dockReserve = outside.length * mannySpace + outside.reduce((s, m) => s + m.cargo.metals + m.cargo.ice + m.cargo.organicCompounds, 0);

    // --- Probe assembly ---
    const empties = inv.containers.filter((c) => c.kind === "container" && c.usedCapacity <= 1e-9).sort((a, b) => a.capacity - b.capacity);
    for (const model of ["generic", "deuterium_tanker"] as const) {
      const kit = KITS[model];
      const consumes: KitLine[] = [
        { item: "additional_container", need: 2, have: Math.min(2, empties.length) },
        ...Object.entries(kit).map(([item, need]) => ({ item, need, have: Math.min(need, stock.get(item) ?? 0) })),
      ];
      const missing = consumes.filter((l) => l.have < l.need).map((l) => ({ ...l, need: l.need - l.have, have: 0 }));
      const used = empties.slice(0, 2);
      const lostCapacity = used.reduce((s, c) => s + c.capacity, 0);
      const freeAfter = inv.freeCapacity - lostCapacity;

      const blockers: string[] = [];
      if (moving) blockers.push(`${p.name} is moving; assembly happens in the probe's current sector.`);
      if (broken) blockers.push(`${p.name} is ${p.status}.`);
      if (!manny) blockers.push("No idle Manny aboard to do the 3-hour exterior task.");
      if (assembling.length) blockers.push(`${assembling.map((m) => m.name).join(", ")} is already assembling a probe here.`);
      if (missing.length) blockers.push(`Missing: ${missing.map((l) => `${l.need} × ${nice(l.item)}${l.item === "additional_container" ? " (empty)" : ""}`).join(", ")}.`);
      if (used.length === 2 && freeAfter < dockReserve)
        blockers.push(`Using two empty containers leaves ${Math.max(0, freeAfter).toFixed(3)} ECE free, but the ${outside.length} Manny(s) outside need ${dockReserve.toFixed(3)} ECE to dock.`);

      const have = consumes.reduce((s, l) => s + l.have, 0);
      // With dozens of probes, only show a build where it has started to make sense: at least one kit part aboard.
      if (consumes.every((l) => l.item === "additional_container" || l.have === 0)) continue;
      const need = consumes.reduce((s, l) => s + l.need, 0);
      const why: string[] = [];
      if (!missing.length) why.push(`Every part of a ${model === "generic" ? "generic" : "deuterium tanker"} kit is aboard ${p.name}.`);
      else why.push(`${p.name} has ${have} of the ${need} kit parts for a ${model === "generic" ? "generic" : "deuterium tanker"} probe.`);
      why.push(`A new probe adds its own storage, tank and sensors and can work another sector in parallel. Your fleet has ${fleet} probe(s).`);
      if (model === "deuterium_tanker") {
        why.push("A tanker's tank holds 400 deuterium points, against 100 on a generic probe.");
        if (lowFuel.length) why.push(`Low on fuel now: ${lowFuel.join(", ")}.`);
        if (tankers) why.push(`You already have ${tankers} tanker(s).`);
      }
      if (used.length === 2)
        why.push(`${p.name} gives up two empty containers (${lostCapacity.toFixed(3)} ECE of storage); ${Math.max(0, freeAfter).toFixed(3)} ECE stays free${outside.length && freeAfter >= dockReserve ? `, enough for the ${outside.length} Manny(s) outside to dock` : ""}.`);

      const risks = [
        `${manny?.name ?? "The Manny"} works outside for ${dur(ASSEMBLY_SECONDS)}, then moves to the new probe.`,
        `${p.name} must stay in this sector until it finishes, or the Manny can be left behind as forgotten. The panel won't move ${p.name} while a Manny is assembling.`,
        "Recalling the Manny cancels the build and leaves the used parts drifting in the sector.",
      ];
      if (model === "deuterium_tanker") risks.push("Tankers risk losing a container in a jump from 2 additional containers onward, not 5.");

      out.push({
        id: `assemble:${p.id}:${model}`, kind: "assemble_probe", probeId: p.id, probeName: p.name,
        title: `Build a ${model === "generic" ? "generic probe" : "deuterium tanker"} at ${p.name}`,
        ready: blockers.length === 0, why, consumes, missing, risks, blockers,
        mannyId: manny?.id ?? null, mannyName: manny?.name ?? null, containerIds: used.map((c) => c.id), model,
        durationSeconds: ASSEMBLY_SECONDS,
        endpoint: `POST /api/probe/${p.id}/mannies/${manny?.id ?? "{mannyId}"}/assemble-probe`,
      });
    }

    // --- Probe improvements (blueprint known, not yet installed on this probe) ---
    for (const imp of improvements[String(p.id)] ?? []) {
      if (!imp.available || imp.done || !imp.installableOnProbe || !INSTALLABLE.has(imp.id)) continue;
      const consumes: KitLine[] = imp.ingredients.map((i) => ({ item: i.type, need: i.quantity, have: Math.min(i.quantity, stock.get(i.type) ?? 0) }));
      const missing = consumes.filter((l) => l.have + 1e-9 < l.need).map((l) => ({ ...l, need: +(l.need - l.have).toFixed(3), have: 0 }));
      const blockers: string[] = [];
      if (broken) blockers.push(`${p.name} is ${p.status}.`);
      if (!manny) blockers.push("No idle Manny aboard.");
      if (v.mannies.some((m) => m.currentTask === "improving_probe")) blockers.push("A Manny is already improving this probe.");
      if (missing.length) blockers.push(`Missing: ${missing.map((l) => `${l.need} ${nice(l.item)}`).join(", ")}.`);
      const effects = Object.entries(imp.effects ?? {}).map(([k, val]) => `${k}: ${String(val)}`).join(", ");
      out.push({
        id: `improve:${p.id}:${imp.id}`, kind: "install_improvement", probeId: p.id, probeName: p.name,
        title: `Install ${imp.name} on ${p.name}`,
        ready: blockers.length === 0,
        why: [imp.description, ...(effects ? [`Effect: ${effects}.`] : []), `You know the blueprint, and it isn't installed on ${p.name} yet.`],
        consumes, missing,
        risks: ["The ingredients are taken from storage when the order is accepted. Cancelling the Manny's task refunds them."],
        blockers, mannyId: manny?.id ?? null, mannyName: manny?.name ?? null, containerIds: [], improvement: imp.id,
        durationSeconds: imp.durationSeconds,
        endpoint: `POST /api/probe/${p.id}/mannies/${manny?.id ?? "{mannyId}"}/improve-probe`,
      });
    }
  }
  return out;
}
