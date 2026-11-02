/**
 * 24/7 automation (step 3a): keep idle Mannies mining toward stock targets,
 * inspect dormant constructs (each unlocks a probe improvement), and keep
 * names in line with the naming scheme.
 *
 * Runs after the fixer every refresh, so fixes always get first pick of idle
 * Mannies, and it always leaves `keepIdle` Mannies free for future fixes.
 */
import { EventEmitter } from "node:events";
import type { Game, Schemas } from "./gameClient.js";
import { GameError, unwrap } from "./gameClient.js";
import type { Snapshot } from "./poller.js";
import { JsonStore } from "./store.js";
import { markOrdered, recentlyOrdered } from "./orders.js";
import { planRenames } from "./naming.js";
import { isFullProbe } from "../shared/attention.js";
import {
  DEFAULT_PROBE_SETTINGS,
  type AutomationAction, type AutomationLogEntry, type AutomationPlan, type AutomationSettings,
  type PlannedRename, type ProbeAutomationSettings, type Resource,
} from "../shared/automation.js";
import type { AutoFixMode } from "../shared/problems.js";
import type { CraftGoal, GoalStatus, Suggestion, TrackedCraft } from "../shared/crafting.js";
import { planCrafting, liveCrafts, type Recipe } from "./crafting.js";
import { buildSuggestions } from "./builds.js";

const MAX_ACTIONS_PER_CYCLE = 10;
const MAX_RENAMES_PER_CYCLE = 5;
const LOG_SIZE = 1000;
const FAIL_BACKOFF_MS = 15 * 60_000;
/** Spec (MannyMineRequest.targetAmount): one Manny trip carries 0.05 ECE. */
const TRIP = 0.05;
/** Fallback when the inventory doesn't list a Manny item to read its containerSpace from. */
const FALLBACK_MANNY_SPACE = 0.05;

interface State {
  settings: AutomationSettings;
  inspected: string[];
  originalNames: Record<string, string>;
  failures: Record<string, string>; // actionId -> retry-after ISO
  log: AutomationLogEntry[];
  recipes: Recipe[];
  recipesAt: string | null;
  crafts: TrackedCraft[];
}

const defaultState = (): State => ({
  settings: {
    mode: "auto", inspectConstructs: true, naming: false, crafting: true, craftQueue: {}, defaults: DEFAULT_PROBE_SETTINGS, probes: {}, lockedNames: [],
  },
  inspected: [],
  originalNames: {},
  failures: {},
  log: [],
  recipes: [],
  recipesAt: null,
  crafts: [],
});

const RECIPE_REFRESH_MS = 6 * 3600_000;
const IMPROVEMENTS_REFRESH_MS = 30 * 60_000;

type Obj = Record<string, unknown> & { id?: string; type?: string; name?: string };

export function settingsFor(s: AutomationSettings, probeId: number): ProbeAutomationSettings {
  const p = s.probes[String(probeId)] ?? {};
  return { ...s.defaults, ...p, targets: { ...s.defaults.targets, ...(p.targets ?? {}) } };
}

/** Mineable targets in a current-sector observation: asteroid objects and solar-system minableTargets. */
export function mineableTargets(sector: Schemas["SectorObservation"] | null): Schemas["MiningTarget"][] {
  const out: Schemas["MiningTarget"][] = [];
  for (const o of (sector?.objects ?? []) as Obj[]) {
    if (Array.isArray(o.minableTargets)) out.push(...(o.minableTargets as Schemas["MiningTarget"][]));
    else if ((o.type === "asteroid" || o.type === "planet") && Array.isArray(o.resourceTypes) && o.id)
      out.push(o as unknown as Schemas["MiningTarget"]);
  }
  return out.filter((t) => t.id && t.resourceTypes?.length);
}

export interface PlanInput {
  snapshot: Snapshot;
  settings: AutomationSettings;
  inspected: Set<string>;
  busy: Set<string>;
  recipes?: Recipe[];
  crafts?: TrackedCraft[];
}

/** Pure planner: what the automation would do right now. */
export function planAutomation(input: PlanInput): AutomationAction[] {
  return planAll(input).actions;
}

export function planAll({ snapshot, settings, inspected, busy, recipes = [], crafts = [] }: PlanInput): { actions: AutomationAction[]; crafting: GoalStatus[] } {
  const actions: AutomationAction[] = [];
  const crafting: GoalStatus[] = [];
  for (const v of snapshot.probes) {
    if (!v.summary.isReachable || !isFullProbe(v.detail) || !v.mannies) continue;
    const p = v.detail;
    const moving = !!p.movement && !["arrived", "failed", "destroyed"].includes(p.movement.status);
    if (["dead", "disabled", "trapped_by_black_hole"].includes(p.status)) continue;
    const cfg = settingsFor(settings, p.id);
    const idle = v.mannies.filter((m) => m.location.type === "probe" && m.currentTask === null && m.canReceiveOrders && !busy.has(m.id));
    let spare = idle.length - cfg.keepIdle;
    const take = () => {
      if (spare <= 0) return null;
      spare--;
      const m = idle.shift()!;
      busy.add(m.id);
      return m;
    };
    const objects = (v.sector?.objects ?? []) as Obj[];

    const inv = p.inventory;
    const mannySpace = Math.max(0, ...(inv?.items ?? []).filter((i) => i.type === "manny").map((i) => i.containerSpace)) || FALLBACK_MANNY_SPACE;
    const outside = v.mannies.filter((m) => m.location.type === "sector");
    // Reserve room for every Manny outside plus its pending cargo (conservative: assume not yet counted).
    const room = { free: (inv?.freeCapacity ?? 0) - outside.reduce((sum, m) => sum + mannySpace + pendingCargo(m), 0) };

    // 1. Dormant constructs → inspect (spec: unlocks one probe improvement).
    if (settings.inspectConstructs && !moving) {
      for (const o of objects) {
        if (o.type !== "dormant_construct" || !o.id || inspected.has(o.id) || o.inspectable === false) continue;
        const already = v.mannies.some((m) => m.currentTask === "inspecting_sector_object" && taskOf(m).objectId === o.id);
        if (already) continue;
        const m = take();
        if (!m) break;
        actions.push({
          id: `inspect:${o.id}`, label: `${m.name} inspects ${o.name ?? o.id}`,
          why: "Dormant constructs unlock a probe improvement blueprint when inspected.",
          endpoint: `POST /api/probe/${p.id}/mannies/${m.id}/inspect-sector-object`,
          plan: { kind: "inspect", probeId: p.id, mannyId: m.id, objectId: o.id },
        });
      }
    }

    // 2. Crafting queue (onboard work, so it also runs while the probe moves).
    const short: Record<Resource, number> = { deuterium: 0, metals: 0, ice: 0, carbon_compounds: 0 };
    const goals = settings.craftQueue?.[String(p.id)] ?? [];
    if (goals.length && inv) {
      const on = settings.crafting !== false;
      // Paused: still show the plan, but hand out no Mannies.
      const res = planCrafting({ view: v, probe: p, recipes, goals, tracked: crafts, take: on ? take : () => null, room });
      crafting.push(...res.statuses);
      if (on) {
        actions.push(...res.actions);
        Object.assign(short, res.shortfalls);
      } else {
        for (const st of res.statuses) for (const step of st.steps) if (step.status === "needs_manny") step.detail = "Crafting is paused.";
      }
    }

    // 3. Mining toward stock targets (plus crafting shortfalls), only with room for every Manny to come home.
    if (!cfg.mining || moving) continue;
    const targets = mineableTargets(v.sector);
    if (!targets.length) continue;
    if (!inv) continue;
    const miners = v.mannies.filter((m) => m.currentTask === "mining");
    let free = room.free;

    const stock: Record<Resource, number> = { deuterium: 0, metals: 0, ice: 0, carbon_compounds: 0 };
    for (const s of inv.resourceStocks) stock[s.type] = s.amount;
    const pending: Record<Resource, number> = { deuterium: 0, metals: 0, ice: 0, carbon_compounds: 0 };
    for (const m of miners) {
      const t = taskOf(m);
      const types = (t.resourceTypes as Resource[] | undefined) ?? [];
      const amt = Number(t.targetAmount ?? 0) - Number(t.depositedAmount ?? 0);
      for (const r of types) pending[r] += amt / Math.max(1, types.length);
    }
    const max = p.fuel.maxDeuterium ?? 100;
    const need = (r: Resource): number =>
      r === "deuterium"
        ? ((cfg.targets.deuteriumPercent / 100) * max - p.fuel.deuterium) * 0.01 - pending.deuterium // 0.01 ECE = 1 tank point
        : cfg.targets[r] - stock[r] - pending[r];
    const needAll = (r: Resource): number => need(r) + short[r];

    let slots = cfg.maxMiners - miners.length;
    const remaining = new Map(targets.map((t) => [t.id, { ...(t.resourceAmounts ?? { deuterium: 0, metals: 0, ice: 0, carbon_compounds: 0 }) }]));
    while (slots > 0 && spare > 0) {
      const wanted = (["deuterium", "metals", "ice", "carbon_compounds"] as Resource[])
        .map((r) => ({ r, n: needAll(r) }))
        .filter((x) => x.n >= 0.01)
        .sort((a, b) => b.n - a.n)[0];
      if (!wanted) break;
      const r = wanted.r;
      const target = targets
        .filter((t) => t.resourceTypes.includes(r) && (remaining.get(t.id)?.[r] ?? 0) >= 0.01)
        .sort((a, b) => (remaining.get(b.id)![r] ?? 0) - (remaining.get(a.id)![r] ?? 0))[0];
      if (!target) {
        pending[r] += 1e9; // no source for this resource here; stop asking for it this cycle
        continue;
      }
      // Deuterium goes to the tank, not storage; everything else needs cargo room.
      const roomForCargo = r === "deuterium" ? Infinity : free - mannySpace;
      const amount = floor3(Math.min(cfg.orderAmount, wanted.n, remaining.get(target.id)![r], roomForCargo));
      if (amount < 0.01 || free < mannySpace + (r === "deuterium" ? 0 : 0.01)) break;
      const m = take();
      if (!m) break;
      slots--;
      free -= mannySpace + (r === "deuterium" ? 0 : amount);
      pending[r] += amount;
      remaining.get(target.id)![r] -= amount;
      actions.push({
        id: `mine:${p.id}:${m.id}`,
        label: `${m.name} mines ${amount} ECE ${r.replace("_", " ")} from ${target.name ?? target.id}`,
        why: `${r.replace("_", " ")} is furthest below target${short[r] > 0 ? " (includes what the crafting queue needs)" : ""}. ${Math.ceil(amount / TRIP)} trip(s); room is kept for every Manny outside to dock.`,
        endpoint: `POST /api/probe/${p.id}/mannies/${m.id}/mine`,
        plan: { kind: "mine", probeId: p.id, mannyId: m.id, objectId: target.id, resources: [r], targetAmount: amount },
      });
    }
  }
  return { actions, crafting };
}

function taskOf(m: Schemas["Manny"]): Record<string, unknown> {
  return Array.isArray(m.task) || !m.task ? {} : (m.task as Record<string, unknown>);
}
function pendingCargo(m: Schemas["Manny"]): number {
  const c = m.cargo;
  const carried = c.metals + c.ice + c.organicCompounds;
  if (m.currentTask !== "mining") return carried;
  const t = taskOf(m);
  const types = (t.resourceTypes as string[] | undefined) ?? [];
  if (types.length === 1 && types[0] === "deuterium") return 0;
  return Math.max(carried, Number(t.targetAmount ?? 0) - Number(t.depositedAmount ?? 0));
}
const floor3 = (n: number) => Math.floor(n * 1000) / 1000;

export class Automation extends EventEmitter {
  private state: State = defaultState();
  private readonly store: JsonStore<State>;
  lastPlan: AutomationAction[] = [];
  renames: PlannedRename[] = [];
  crafting: GoalStatus[] = [];
  suggestions: Suggestion[] = [];
  improvements: Record<string, Schemas["ProbeImprovement"][]> = {};
  private improvementsAt: Record<string, number> = {};
  private lastSnapshot: Snapshot | null = null;

  constructor(private readonly game: Game, dataDir: string | undefined, private readonly onActed: () => void, private readonly now = Date.now) {
    super();
    this.store = new JsonStore<State>(dataDir, "automation.json", defaultState);
  }

  async load(): Promise<void> {
    const loaded = await this.store.load();
    const d = defaultState();
    this.state = {
      ...d, ...loaded,
      settings: { ...d.settings, ...loaded.settings, defaults: { ...d.settings.defaults, ...loaded.settings?.defaults } },
    };
  }

  get settings(): AutomationSettings {
    return this.state.settings;
  }
  get log(): AutomationLogEntry[] {
    return this.state.log;
  }
  get originalNames(): Record<string, string> {
    return this.state.originalNames;
  }
  get recipes(): Recipe[] {
    return this.state.recipes;
  }

  /** Replaces one probe's crafting queue (order = priority). */
  async setQueue(probeId: number, goals: Array<Partial<CraftGoal>>): Promise<CraftGoal[]> {
    const known = new Set(this.state.recipes.map((r) => r.output.type as string));
    const clean: CraftGoal[] = [];
    for (const g of goals) {
      const item = String(g.item ?? "");
      const quantity = Math.round(Number(g.quantity));
      if (!item || (known.size && !known.has(item)) || !Number.isFinite(quantity) || quantity < 1 || quantity > 1000) continue;
      clean.push({
        id: typeof g.id === "string" && g.id ? g.id : `g${this.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        item, quantity, once: !!g.once, note: g.note ? String(g.note).slice(0, 120) : undefined,
        addedAt: typeof g.addedAt === "string" ? g.addedAt : new Date(this.now()).toISOString(),
      });
    }
    this.state.settings.craftQueue[String(probeId)] = clean;
    await this.store.save(this.state);
    this.replan();
    return clean;
  }

  /** Adds goals for every part a suggestion is missing (one-off goals, merged with existing ones). */
  async queueMissing(suggestionId: string): Promise<CraftGoal[] | null> {
    const sug = this.suggestions.find((x) => x.id === suggestionId);
    if (!sug) return null;
    const goals = [...(this.state.settings.craftQueue[String(sug.probeId)] ?? [])];
    const v = this.lastSnapshot?.probes.find((x) => x.summary.id === sug.probeId);
    const containersNow = isFullProbe(v?.detail ?? null) ? ((v!.detail as Schemas["Probe"]).inventory?.containers.filter((c) => c.kind === "container").length ?? 0) : 0;
    for (const line of sug.consumes) {
      if (["deuterium", "metals", "ice", "carbon_compounds"].includes(line.item)) continue; // mining covers resources
      // Assembly needs *empty* containers, so ask for that many on top of the ones in use.
      const target = line.item === "additional_container" ? containersNow + (line.need - line.have) : Math.ceil(line.need);
      if (line.have >= line.need) continue;
      const existing = goals.find((g) => g.item === line.item);
      if (existing) existing.quantity = Math.max(existing.quantity, target);
      else goals.push({ id: "", item: line.item, quantity: target, once: true, note: sug.title, addedAt: "" });
    }
    return this.setQueue(sug.probeId, goals);
  }

  /** Runs a build suggestion after Merchant confirmed it. Re-checked against the latest refresh first. */
  async confirmSuggestion(id: string): Promise<AutomationLogEntry> {
    this.replan();
    const sug = this.suggestions.find((x) => x.id === id);
    const fail = (message: string): AutomationLogEntry => {
      const e: AutomationLogEntry = { at: new Date(this.now()).toISOString(), actionId: id, label: sug?.title ?? id, endpoint: sug?.endpoint ?? "", dryRun: false, ok: false, status: null, code: "not_ready", message };
      this.state.log.push(e);
      return e;
    };
    if (!sug) return fail("This suggestion no longer applies.");
    if (!sug.ready || !sug.mannyId) return fail(sug.blockers.join(" ") || "Not ready.");
    const plan: AutomationPlan = sug.kind === "assemble_probe"
      ? { kind: "assemble", probeId: sug.probeId, mannyId: sug.mannyId, model: sug.model!, containerIds: sug.containerIds }
      : { kind: "improve", probeId: sug.probeId, mannyId: sug.mannyId, improvement: sug.improvement! };
    const action: AutomationAction = { id: `confirm:${id}`, label: `${sug.mannyName}: ${sug.title} (confirmed)`, why: sug.why.join(" "), endpoint: endpointOf(plan), plan };
    await this.execute(action, false);
    delete this.state.failures[action.id]; // a confirmed action can be retried right away
    if (sug.kind === "install_improvement") delete this.improvementsAt[String(sug.probeId)];
    await this.store.save(this.state);
    this.emit("changed");
    this.onActed();
    return this.state.log[this.state.log.length - 1];
  }

  /** Probes the panel must not move: a Manny is assembling a probe there (spec: leaving strands it). */
  holds(snapshot: Snapshot): Array<{ probeId: number; mannyId: string; until: string | null }> {
    const out: Array<{ probeId: number; mannyId: string; until: string | null }> = [];
    for (const v of snapshot.probes)
      for (const m of v.mannies ?? []) if (m.currentTask === "assembling_probe") out.push({ probeId: v.summary.id, mannyId: m.id, until: m.taskEstimatedEndTime });
    return out;
  }

  private replan(): void {
    if (!this.lastSnapshot) return;
    const busy = recentlyOrdered(this.now());
    const r = planAll({
      snapshot: this.lastSnapshot, settings: this.state.settings, inspected: new Set(this.state.inspected), busy,
      recipes: this.state.recipes, crafts: this.state.crafts,
    });
    this.lastPlan = r.actions;
    this.crafting = r.crafting;
    this.suggestions = buildSuggestions({ snapshot: this.lastSnapshot, improvements: this.improvements, busy: recentlyOrdered(this.now()) });
    this.emit("changed");
  }

  private async refreshReference(snapshot: Snapshot): Promise<void> {
    const t = this.now();
    if (!this.state.recipesAt || t - new Date(this.state.recipesAt).getTime() > RECIPE_REFRESH_MS || !this.state.recipes.length) {
      try {
        const res = unwrap(await this.game.poll.GET("/api/crafting-recipes", {}));
        this.state.recipes = res.recipes;
        this.state.recipesAt = new Date(t).toISOString();
      } catch {
        /* keep the cached list; retried next refresh */
      }
    }
    for (const v of snapshot.probes) {
      if (!v.summary.isReachable) continue;
      const key = String(v.summary.id);
      if (t - (this.improvementsAt[key] ?? 0) < IMPROVEMENTS_REFRESH_MS) continue;
      try {
        const res = unwrap(await this.game.poll.GET("/api/probe/{probeId}/probe-improvements-available", { params: { path: { probeId: v.summary.id } } }));
        this.improvements[key] = res.improvements;
        this.improvementsAt[key] = t;
      } catch {
        this.improvementsAt[key] = t - IMPROVEMENTS_REFRESH_MS + 5 * 60_000; // retry in 5 minutes
      }
    }
  }

  async updateSettings(patch: Partial<AutomationSettings>): Promise<AutomationSettings> {
    const s = this.state.settings;
    if (patch.mode && ["auto", "dry_run", "off"].includes(patch.mode)) s.mode = patch.mode as AutoFixMode;
    if (typeof patch.inspectConstructs === "boolean") s.inspectConstructs = patch.inspectConstructs;
    if (typeof patch.naming === "boolean") s.naming = patch.naming;
    if (typeof patch.crafting === "boolean") s.crafting = patch.crafting;
    if (patch.defaults) s.defaults = sanitize({ ...s.defaults, ...patch.defaults, targets: { ...s.defaults.targets, ...(patch.defaults.targets ?? {}) } });
    const ROLES = ["Probe", "Station", "Hauler", "Tanker", "Scout", "Miner"];
    if (patch.probes)
      for (const [id, p] of Object.entries(patch.probes)) {
        if (p.role && !ROLES.includes(p.role)) delete p.role;
        s.probes[id] = { ...(s.probes[id] ?? {}), ...p };
      }
    if (Array.isArray(patch.lockedNames)) s.lockedNames = patch.lockedNames.map(String);
    await this.store.save(this.state);
    this.emit("changed");
    return s;
  }

  async onSnapshot(snapshot: Snapshot): Promise<void> {
    const t = this.now();
    const s = this.state.settings;
    this.lastSnapshot = snapshot;
    await this.refreshReference(snapshot);
    this.state.crafts = liveCrafts(this.state.crafts, snapshot.probes, t);
    const busy = recentlyOrdered(t);
    const all = planAll({ snapshot, settings: s, inspected: new Set(this.state.inspected), busy, recipes: this.state.recipes, crafts: this.state.crafts });
    this.lastPlan = all.actions;
    this.crafting = all.crafting;
    // One-off goals that are reached leave the queue.
    for (const st of all.crafting)
      if (st.done && st.goal.once) {
        const q = s.craftQueue[String(st.probeId)];
        if (q) s.craftQueue[String(st.probeId)] = q.filter((g) => g.id !== st.goal.id);
      }
    this.suggestions = buildSuggestions({ snapshot, improvements: this.improvements, busy: new Set(busy) });
    this.renames = planRenames(snapshot, (id) => settingsFor(s, id).role, new Set(s.lockedNames));

    let acted = false;
    if (s.mode !== "off") {
      const dry = s.mode === "dry_run";
      let n = 0;
      for (const a of this.lastPlan) {
        if (n >= MAX_ACTIONS_PER_CYCLE) break;
        if (this.backedOff(a.id, t)) continue;
        n++;
        if (await this.execute(a, dry)) acted ||= !dry;
      }
      if (s.naming) {
        let r = 0;
        for (const rn of this.renames) {
          if (r >= MAX_RENAMES_PER_CYCLE) break;
          if (rn.locked || !rn.reachable) continue;
          const action = renameAction(rn);
          if (!action || this.backedOff(action.id, t)) continue;
          r++;
          this.state.originalNames[rn.entity] ??= rn.current;
          await this.execute(action, dry);
        }
      }
    }
    await this.store.save(this.state);
    this.emit("changed");
    if (acted) this.onActed();
  }

  /** Puts every renamed entity back to the name it had before the panel touched it. */
  async revertNames(snapshot: Snapshot): Promise<number> {
    let count = 0;
    for (const [entity, original] of Object.entries(this.state.originalNames)) {
      const [kind, a, b] = entity.split(":");
      let plan: AutomationPlan | null = null;
      if (kind === "probe") plan = { kind: "rename_probe", probeId: Number(a), name: original };
      if (kind === "manny") {
        const v = snapshot.probes.find((p) => p.mannies?.some((m) => m.id === a));
        if (v) plan = { kind: "rename_manny", probeId: v.summary.id, mannyId: a, name: original };
      }
      if (kind === "container") plan = { kind: "rename_container", probeId: Number(a), containerId: b, label: original };
      if (!plan) continue;
      const ok = await this.execute({ id: `revert:${entity}`, label: `Revert ${entity} to "${original}"`, why: "", endpoint: endpointOf(plan), plan }, false);
      if (ok) {
        delete this.state.originalNames[entity];
        count++;
      }
    }
    this.state.settings.naming = false;
    await this.store.save(this.state);
    this.emit("changed");
    return count;
  }

  private backedOff(id: string, t: number): boolean {
    const until = this.state.failures[id];
    return !!until && t < new Date(until).getTime();
  }

  private async execute(a: AutomationAction, dryRun: boolean): Promise<boolean> {
    const t = this.now();
    const entry: AutomationLogEntry = {
      at: new Date(t).toISOString(), actionId: a.id, label: a.label, endpoint: a.endpoint, dryRun, ok: true, status: null, code: null, message: null,
    };
    try {
      if (!dryRun) {
        entry.status = await this.call(a.plan);
        if ("mannyId" in a.plan && a.plan.kind !== "rename_manny") markOrdered(a.plan.mannyId, t);
        if (a.plan.kind === "inspect") this.state.inspected.push(a.plan.objectId);
        if (a.plan.kind === "craft" || a.plan.kind === "print")
          this.state.crafts.push({ probeId: a.plan.probeId, mannyId: a.plan.mannyId, recipe: a.plan.recipe, output: a.plan.output, at: new Date(t).toISOString() });
      } else entry.message = "Dry run: not sent.";
      delete this.state.failures[a.id];
      return true;
    } catch (err) {
      entry.ok = false;
      if (err instanceof GameError) Object.assign(entry, { status: err.status, code: err.code, message: err.message });
      else Object.assign(entry, { code: "network_error", message: err instanceof Error ? err.message : String(err) });
      this.state.failures[a.id] = new Date(t + FAIL_BACKOFF_MS).toISOString();
      return false;
    } finally {
      this.state.log.push(entry);
      if (this.state.log.length > LOG_SIZE) this.state.log.splice(0, this.state.log.length - LOG_SIZE);
    }
  }

  private async call(plan: AutomationPlan): Promise<number> {
    const c = this.game.action;
    let r: { data?: unknown; error?: unknown; response: Response };
    switch (plan.kind) {
      case "mine":
        r = await c.POST("/api/probe/{probeId}/mannies/{mannyId}/mine", {
          params: { path: { probeId: plan.probeId, mannyId: plan.mannyId } },
          body: { objectId: plan.objectId, resources: plan.resources, targetAmount: plan.targetAmount },
        });
        break;
      case "inspect":
        r = await c.POST("/api/probe/{probeId}/mannies/{mannyId}/inspect-sector-object", {
          params: { path: { probeId: plan.probeId, mannyId: plan.mannyId } }, body: { objectId: plan.objectId },
        });
        break;
      case "craft":
        r = await c.POST("/api/probe/{probeId}/mannies/{mannyId}/craft", {
          params: { path: { probeId: plan.probeId, mannyId: plan.mannyId } },
          body: { recipe: plan.recipe as Schemas["MannyCraftRequest"]["recipe"] },
        });
        break;
      case "print":
        r = await c.POST("/api/probe/{probeId}/atomic-printer/craft", {
          params: { path: { probeId: plan.probeId } },
          body: { recipe: plan.recipe as Schemas["AtomicPrinterCraftRequest"]["recipe"], mannyId: plan.mannyId },
        });
        break;
      case "assemble":
        r = await c.POST("/api/probe/{probeId}/mannies/{mannyId}/assemble-probe", {
          params: { path: { probeId: plan.probeId, mannyId: plan.mannyId } },
          body: { model: plan.model, containerIds: plan.containerIds },
        });
        break;
      case "improve":
        r = await c.POST("/api/probe/{probeId}/mannies/{mannyId}/improve-probe", {
          params: { path: { probeId: plan.probeId, mannyId: plan.mannyId } },
          body: { improvement: plan.improvement as Schemas["MannyProbeImprovementRequest"]["improvement"] },
        });
        break;
      case "rename_probe":
        r = await c.PATCH("/api/probe/{probeId}", { params: { path: { probeId: plan.probeId } }, body: { name: plan.name } });
        break;
      case "rename_manny":
        r = await c.PATCH("/api/probe/{probeId}/mannies/{mannyId}", {
          params: { path: { probeId: plan.probeId, mannyId: plan.mannyId } }, body: { name: plan.name.slice(0, 40) },
        });
        break;
      case "rename_container":
        r = await c.PATCH("/api/probe/{probeId}/storage-containers/{containerId}", {
          params: { path: { probeId: plan.probeId, containerId: plan.containerId } }, body: { label: plan.label.slice(0, 80) },
        });
        break;
    }
    unwrap(r as { data?: unknown; error?: unknown; response: Response });
    return r.response.status;
  }
}

function renameAction(rn: PlannedRename): AutomationAction | null {
  let plan: AutomationPlan;
  const [, a, b] = rn.entity.split(":");
  if (rn.kind === "probe") plan = { kind: "rename_probe", probeId: rn.probeId, name: rn.planned };
  else if (rn.kind === "manny") plan = { kind: "rename_manny", probeId: rn.probeId, mannyId: a, name: rn.planned };
  else plan = { kind: "rename_container", probeId: Number(a), containerId: b, label: rn.planned };
  return { id: `rename:${rn.entity}:${rn.planned}`, label: `Rename ${rn.kind} "${rn.current}" → "${rn.planned}"`, why: "Naming scheme", endpoint: endpointOf(plan), plan };
}

function endpointOf(plan: AutomationPlan): string {
  switch (plan.kind) {
    case "mine": return `POST /api/probe/${plan.probeId}/mannies/${plan.mannyId}/mine`;
    case "inspect": return `POST /api/probe/${plan.probeId}/mannies/${plan.mannyId}/inspect-sector-object`;
    case "craft": return `POST /api/probe/${plan.probeId}/mannies/${plan.mannyId}/craft`;
    case "print": return `POST /api/probe/${plan.probeId}/atomic-printer/craft`;
    case "assemble": return `POST /api/probe/${plan.probeId}/mannies/${plan.mannyId}/assemble-probe`;
    case "improve": return `POST /api/probe/${plan.probeId}/mannies/${plan.mannyId}/improve-probe`;
    case "rename_probe": return `PATCH /api/probe/${plan.probeId}`;
    case "rename_manny": return `PATCH /api/probe/${plan.probeId}/mannies/${plan.mannyId}`;
    case "rename_container": return `PATCH /api/probe/${plan.probeId}/storage-containers/${plan.containerId}`;
  }
}

function sanitize(p: ProbeAutomationSettings): ProbeAutomationSettings {
  const n = (x: unknown, lo: number, hi: number, d: number) => (Number.isFinite(Number(x)) ? Math.min(hi, Math.max(lo, Number(x))) : d);
  return {
    ...p,
    mining: !!p.mining,
    maxMiners: Math.round(n(p.maxMiners, 0, 500, 20)),
    keepIdle: Math.round(n(p.keepIdle, 0, 50, 1)),
    orderAmount: n(p.orderAmount, 0.01, 5, 0.1),
    targets: {
      metals: n(p.targets.metals, 0, 100, 0.3),
      ice: n(p.targets.ice, 0, 100, 0.2),
      carbon_compounds: n(p.targets.carbon_compounds, 0, 100, 0.2),
      deuteriumPercent: n(p.targets.deuteriumPercent, 0, 200, 80),
    },
  };
}
