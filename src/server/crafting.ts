/**
 * Crafting queue (step 3b).
 *
 * Each probe has an ordered list of goals ("keep at least N of item X aboard").
 * Every refresh the planner expands each goal through the live recipe list
 * (GET /api/crafting-recipes): it reserves what is already aboard, starts every
 * craft whose ingredients are present, recurses into missing items, and turns
 * missing raw resources into shortfalls that the mining automation then fills.
 *
 * Endpoints used:
 *   POST /api/probe/{id}/mannies/{mannyId}/craft     recipes craftable by "manny"
 *   POST /api/probe/{id}/atomic-printer/craft        recipes craftable by "atomic_3d_printer"
 *     (needs an atomic_3d_printer aboard; one craft at a time; reserves an idle Manny)
 */
import type { Schemas } from "./gameClient.js";
import type { ProbeView } from "./poller.js";
import type { AutomationAction, Resource } from "../shared/automation.js";
import type { CraftGoal, CraftStep, GoalStatus, TrackedCraft } from "../shared/crafting.js";

export type Recipe = Schemas["CraftingRecipe"];
type Probe = Schemas["Probe"];
type Manny = Schemas["Manny"];

export const RESOURCES: Resource[] = ["deuterium", "metals", "ice", "carbon_compounds"];
const isResource = (t: string): t is Resource => (RESOURCES as string[]).includes(t);

/** Recipe ids each start endpoint accepts (MannyCraftRequest / AtomicPrinterCraftRequest enums). */
const MANNY_RECIPES = new Set<string>([
  "waypoint_bookmark", "steel_bar", "steel_plate", "additional_container", "electric_motor", "battery_pack", "linear_actuator",
  "deuterium_engine", "solar_panel", "scut_relay", "scut_transit_beacon", "thermal_protection_shell", "parachute_pack",
  "descent_guidance_module", "atmospheric_drop_kit", "manny",
]);
const PRINTER_RECIPES = new Set<string>([
  "micro_conductor", "ceramic_insulator", "crystal_substrate", "dopant_matrix", "integrated_circuit", "atomic_printer_part",
]);

/** Mannies still busy with a craft the panel ordered (or ordered in the last 2 minutes, before the game shows it). */
export function liveCrafts(tracked: TrackedCraft[], views: ProbeView[], now: number): TrackedCraft[] {
  return tracked.filter((c) => {
    if (now - new Date(c.at).getTime() < 2 * 60_000) return true;
    const m = views.find((v) => v.summary.id === c.probeId)?.mannies?.find((x) => x.id === c.mannyId);
    return !!m && (m.currentTask === "crafting" || m.currentTask === "assisting_atomic_printer");
  });
}

/**
 * How much of each item/resource is aboard. Items are counted per inventory entry;
 * Mannies come from the Manny list; additional containers are the probe's
 * `kind: container` storage containers (crafting one creates one, per
 * CraftingRecipeOutput.capacityBonus).
 */
export function stockOf(p: Probe, mannies: Manny[] | null): Map<string, number> {
  const out = new Map<string, number>();
  const inv = p.inventory;
  if (!inv) return out;
  for (const i of inv.items) if (i.type !== "manny" && i.type !== "additional_container") out.set(i.type, (out.get(i.type) ?? 0) + 1);
  out.set("manny", mannies?.length ?? inv.items.filter((i) => i.type === "manny").length);
  out.set("additional_container", inv.containers.filter((c) => c.kind === "container").length);
  for (const s of inv.resourceStocks) out.set(s.type, (out.get(s.type) ?? 0) + s.amount);
  // The spec doesn't say whether crafting deuterium comes from storage or the tank. Count storage
  // first, then the tank above a 20-point reserve (0.01 ECE = 1 tank point). A 422
  // insufficient_deuterium just backs the order off.
  if (!out.get("deuterium")) out.set("deuterium", Math.max(0, (p.fuel.deuterium - 20) * 0.01));
  return out;
}

export interface CraftInput {
  view: ProbeView;
  probe: Probe;
  recipes: Recipe[];
  goals: CraftGoal[];
  tracked: TrackedCraft[];
  /** Hands out an idle Manny (respecting keepIdle), or null. */
  take: () => Manny | null;
  /** Free storage after reserving room for every Manny outside; mutated as outputs are planned. */
  room: { free: number };
}

export interface CraftResult {
  actions: AutomationAction[];
  statuses: GoalStatus[];
  shortfalls: Record<Resource, number>;
}

export function planCrafting(input: CraftInput): CraftResult {
  const { view, probe: p, recipes, goals, take, room } = input;
  const byOutput = new Map(recipes.map((r) => [r.output.type as string, r]));
  const pool = stockOf(p, view.mannies);
  const initial = new Map(pool);
  const inProg = new Map<string, number>();
  for (const c of input.tracked) if (c.probeId === p.id) inProg.set(c.output, (inProg.get(c.output) ?? 0) + 1);
  const hasPrinter = !!p.inventory?.items.some((i) => i.type === "atomic_3d_printer");
  let printerBusy = !!view.mannies?.some((m) => m.currentTask === "assisting_atomic_printer");

  const actions: AutomationAction[] = [];
  const statuses: GoalStatus[] = [];
  const total: Record<Resource, number> = { deuterium: 0, metals: 0, ice: 0, carbon_compounds: 0 };

  for (const goal of goals) {
    const steps: CraftStep[] = [];
    const shortfalls: Partial<Record<Resource, number>> = {};
    let work = 0;

    const expand = (item: string, qty: number, depth: number): void => {
      const recipe = byOutput.get(item);
      const name = recipe?.output.name ?? item.replaceAll("_", " ");
      const ip = Math.min(inProg.get(item) ?? 0, qty);
      if (ip > 0) {
        inProg.set(item, (inProg.get(item) ?? 0) - ip);
        steps.push({ item, name, by: null, count: ip, status: "in_progress", detail: "A Manny is crafting this now.", depth });
        qty -= ip;
      }
      if (qty <= 0) return;
      if (!recipe) {
        steps.push({ item, name, by: null, count: qty, status: "no_recipe", detail: "No recipe in GET /api/crafting-recipes makes this.", depth });
        return;
      }
      const by = recipe.craftableBy.includes("manny") && MANNY_RECIPES.has(recipe.id) ? "manny"
        : recipe.craftableBy.includes("atomic_3d_printer") && PRINTER_RECIPES.has(recipe.id) ? "atomic_3d_printer" : null;
      work += qty * recipe.durationSeconds;
      let startable = qty;
      const missingParts: string[] = [];
      let resourceShort = false;
      for (const ing of recipe.ingredients) {
        const required = ing.quantity * qty;
        const avail = pool.get(ing.type) ?? 0;
        const use = Math.min(avail, required);
        pool.set(ing.type, avail - use); // reserved for this goal, even if the craft can't start yet
        startable = Math.min(startable, Math.floor(use / ing.quantity + 1e-9));
        const missing = required - use;
        if (missing <= 1e-9) continue;
        if (isResource(ing.type)) {
          shortfalls[ing.type] = (shortfalls[ing.type] ?? 0) + missing;
          resourceShort = true;
        } else {
          missingParts.push(ing.type.replaceAll("_", " "));
          expand(ing.type, Math.ceil(missing - 1e-9), depth + 1);
        }
      }

      let started = 0;
      let blocked: { status: CraftStep["status"]; detail: string } | null = null;
      while (started < startable) {
        if (!by) { blocked = { status: "no_recipe", detail: "Neither craft endpoint accepts this recipe id." }; break; }
        if (by === "atomic_3d_printer") {
          if (!hasPrinter) { blocked = { status: "no_printer", detail: "Needs an atomic 3D printer aboard this probe." }; break; }
          if (printerBusy) { blocked = { status: "printer_busy", detail: "The atomic printer runs one craft at a time." }; break; }
        }
        const space = recipe.output.containerSpace ?? 0;
        if (room.free < space) { blocked = { status: "no_room", detail: `Output needs ${space} ECE; storage is kept free for Mannies docking.` }; break; }
        const m = take();
        if (!m) { blocked = { status: "needs_manny", detail: "Waiting for an idle Manny (one is always kept free for fixes)." }; break; }
        room.free -= space;
        started++;
        if (by === "atomic_3d_printer") printerBusy = true;
        actions.push({
          id: `craft:${p.id}:${m.id}`,
          label: `${m.name} ${by === "manny" ? "crafts" : "runs the atomic printer for"} ${recipe.output.name}`,
          why: `Crafting queue: ${goal.quantity} × ${(byOutput.get(goal.item)?.output.name ?? goal.item)}${goal.note ? ` (${goal.note})` : ""}. Takes ${dur(recipe.durationSeconds)}.`,
          endpoint: by === "manny" ? `POST /api/probe/${p.id}/mannies/${m.id}/craft` : `POST /api/probe/${p.id}/atomic-printer/craft`,
          plan: by === "manny"
            ? { kind: "craft", probeId: p.id, mannyId: m.id, recipe: recipe.id, output: recipe.output.type }
            : { kind: "print", probeId: p.id, mannyId: m.id, recipe: recipe.id, output: recipe.output.type },
        });
      }
      if (started) steps.push({ item, name, by, count: started, status: "starting", detail: `Ordering now (${dur(recipe.durationSeconds)} each).`, depth });
      const rest = qty - started;
      if (rest > 0) {
        const status = blocked && started < startable ? blocked.status : missingParts.length ? "needs_ingredients" : resourceShort ? "needs_resources" : blocked?.status ?? "needs_manny";
        const detail = status === "needs_ingredients" ? `Waiting for ${missingParts.join(", ")}.`
          : status === "needs_resources" ? `Short of ${Object.keys(shortfalls).map((r) => r.replace("_", " ")).join(", ")}; mining has been asked for it.`
          : blocked?.detail ?? "";
        steps.push({ item, name, by, count: rest, status, detail, depth });
      }
    };

    const have = initial.get(goal.item) ?? 0;
    const avail = pool.get(goal.item) ?? 0;
    const claim = Math.min(avail, goal.quantity);
    pool.set(goal.item, avail - claim);
    const remaining = Math.max(0, Math.ceil(goal.quantity - claim - 1e-9));
    const ipBefore = inProg.get(goal.item) ?? 0;
    if (remaining > 0) expand(goal.item, remaining, 0);
    for (const r of RESOURCES) total[r] += shortfalls[r] ?? 0;
    statuses.push({
      probeId: p.id, goal, have, inProgress: Math.min(ipBefore, remaining), done: remaining === 0, steps, shortfalls, workSeconds: work,
    });
  }
  return { actions, statuses, shortfalls: total };
}

export function dur(s: number): string {
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${+(s / 3600).toFixed(1)} h`;
  return `${+(s / 86400).toFixed(1)} days`;
}
