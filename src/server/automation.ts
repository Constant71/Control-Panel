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
}

const defaultState = (): State => ({
  settings: {
    mode: "auto", inspectConstructs: true, naming: false, defaults: DEFAULT_PROBE_SETTINGS, probes: {}, lockedNames: [],
  },
  inspected: [],
  originalNames: {},
  failures: {},
  log: [],
});

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
}

/** Pure planner: what the automation would do right now. */
export function planAutomation({ snapshot, settings, inspected, busy }: PlanInput): AutomationAction[] {
  const actions: AutomationAction[] = [];
  for (const v of snapshot.probes) {
    if (!v.summary.isReachable || !isFullProbe(v.detail) || !v.mannies) continue;
    const p = v.detail;
    const moving = !!p.movement && !["arrived", "failed", "destroyed"].includes(p.movement.status);
    if (moving || ["dead", "disabled", "trapped_by_black_hole"].includes(p.status)) continue;
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

    // 1. Dormant constructs → inspect (spec: unlocks one probe improvement).
    if (settings.inspectConstructs) {
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

    // 2. Mining toward stock targets, only with room for every Manny to come home.
    if (!cfg.mining) continue;
    const targets = mineableTargets(v.sector);
    if (!targets.length) continue;
    const inv = p.inventory;
    if (!inv) continue;
    const mannySpace = Math.max(0, ...inv.items.filter((i) => i.type === "manny").map((i) => i.containerSpace)) || FALLBACK_MANNY_SPACE;
    const outside = v.mannies.filter((m) => m.location.type === "sector");
    const miners = v.mannies.filter((m) => m.currentTask === "mining");
    // Reserve room for every Manny outside plus its pending cargo (conservative: assume not yet counted).
    let free = inv.freeCapacity - outside.reduce((sum, m) => sum + mannySpace + pendingCargo(m), 0);

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

    let slots = cfg.maxMiners - miners.length;
    const remaining = new Map(targets.map((t) => [t.id, { ...(t.resourceAmounts ?? { deuterium: 0, metals: 0, ice: 0, carbon_compounds: 0 }) }]));
    while (slots > 0 && spare > 0) {
      const wanted = (["deuterium", "metals", "ice", "carbon_compounds"] as Resource[])
        .map((r) => ({ r, n: need(r) }))
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
        why: `${r.replace("_", " ")} is furthest below target. ${Math.ceil(amount / TRIP)} trip(s); room is kept for every Manny outside to dock.`,
        endpoint: `POST /api/probe/${p.id}/mannies/${m.id}/mine`,
        plan: { kind: "mine", probeId: p.id, mannyId: m.id, objectId: target.id, resources: [r], targetAmount: amount },
      });
    }
  }
  return actions;
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

  constructor(private readonly game: Game, dataDir: string | undefined, private readonly onActed: () => void, private readonly now = Date.now) {
    super();
    this.store = new JsonStore<State>(dataDir, "automation.json", defaultState);
  }

  async load(): Promise<void> {
    const loaded = await this.store.load();
    const d = defaultState();
    this.state = { ...loaded, settings: { ...d.settings, ...loaded.settings, defaults: { ...d.settings.defaults, ...loaded.settings?.defaults } } };
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

  async updateSettings(patch: Partial<AutomationSettings>): Promise<AutomationSettings> {
    const s = this.state.settings;
    if (patch.mode && ["auto", "dry_run", "off"].includes(patch.mode)) s.mode = patch.mode as AutoFixMode;
    if (typeof patch.inspectConstructs === "boolean") s.inspectConstructs = patch.inspectConstructs;
    if (typeof patch.naming === "boolean") s.naming = patch.naming;
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
    const busy = recentlyOrdered(t);
    this.lastPlan = planAutomation({ snapshot, settings: s, inspected: new Set(this.state.inspected), busy });
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
