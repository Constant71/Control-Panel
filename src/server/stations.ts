/**
 * Stations, step 5a: designation, group membership with roles, and a read-only
 * status of stock against targets. Nothing about stations is sent to the game; the
 * only game call here is PATCH /api/probe/{id} {isDefault: true}, made when Merchant
 * presses "Make default probe" (the spec requires both probes in the same sector or
 * the same active SCUT network, else 422).
 */
import { EventEmitter } from "node:events";
import type { Snapshot, ProbeView } from "./poller.js";
import { Game, GameError, unwrap, type Schemas } from "./gameClient.js";
import { JsonStore } from "./store.js";
import { stockOf } from "./crafting.js";
import { isFullProbe } from "../shared/attention.js";
import type { ProbeRole } from "../shared/automation.js";
import type { AutoFixMode } from "../shared/problems.js";
import { markOrdered, recentlyOrdered } from "./orders.js";
import { detachedContainersIn, planService, sanitizeService, trackHandoffs } from "./stationOps.js";
import { ACTIVE, planDispatch } from "./dispatch.js";
import type { SectorKnowledge } from "./discovery.js";
import { productionGoals, toCraftGoals } from "./production.js";
import { fleeCard, type FleeApproval } from "./flee.js";
import { planStationTankers } from "./stationTanker.js";
import { planStationMiners } from "./stationMiner.js";
import type { CraftGoal } from "../shared/crafting.js";
import {
  DEFAULT_STATION, MEMBER_ROLES, ROLE_LABEL, type Check, type FleeCard, type Handoff, type StationOp, type Trip, type MemberRole, type MemberStatus, type StationConfig, type StationLogEntry,
  type StationMode, type StationStatus, type StationsData, type StockTarget, type TargetStatus,
} from "../shared/stations.js";

type Vec = { x: number; y: number; z: number };
const RES_LABEL: Record<string, string> = { metals: "Metals", ice: "Ice", carbon_compounds: "Carbon compounds", deuterium: "Deuterium" };
const MODES: StationMode[] = ["parts", "manny_factory", "probe_yard"];
const MAX_LOG = 500;

interface StoredData extends StationsData {
  /** Probe ids seen so far, so a newly assembled probe can join the station it was built at. */
  knownProbes: number[] | null;
  handoffs: Handoff[];
  trips: Trip[];
  /** Flees Merchant confirmed, by station id. */
  flee: Record<string, FleeApproval>;
  /** Op id -> retry-after ISO, after a refused call. */
  failures: Record<string, string>;
}

const MAX_OPS_PER_CYCLE = 6;
const FAIL_BACKOFF_MS = 10 * 60_000;
/** A deuterium transfer takes five minutes (spec); don't send another to the same pair meanwhile. */
const REFUEL_GAP_MS = 7 * 60_000; // also spaces Manny moves between a pair
const RULES_GAP_MS = 30 * 60_000;
const emptyData = (): StoredData => ({ stations: [], members: {}, log: [], knownProbes: null, handoffs: [], trips: [], flee: {}, failures: {} });

export class StationError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function sectorOf(v: ProbeView | undefined): Vec | null {
  return (v?.detail?.sector?.relative as Vec | undefined) ?? null;
}

const same = (a: Vec | null, b: Vec | null) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

function fuelPercent(p: Schemas["Probe"]): number {
  const max = p.fuel.maxDeuterium ?? (p.model === "deuterium_tanker" ? 400 : 100);
  return max > 0 ? round((p.fuel.deuterium / max) * 100, 0) : 0;
}

function moving(p: Schemas["Probe"]): boolean {
  return !!p.movement || ["preparing", "accelerating", "cruising", "decelerating"].includes(p.status);
}

function targetKey(t: StockTarget): string {
  return t.kind === "resource" ? `resource:${t.resource}` : `item:${t.item}`;
}

function sanitizeTargets(raw: unknown): StockTarget[] {
  if (!Array.isArray(raw)) return [];
  const out: StockTarget[] = [];
  const seen = new Set<string>();
  for (const r of raw as Array<Record<string, unknown>>) {
    const min = Number(r?.min);
    if (!Number.isFinite(min) || min < 0 || min > 1e6) continue;
    let t: StockTarget | null = null;
    if (r.kind === "resource" && typeof r.resource === "string" && RES_LABEL[r.resource]) t = { kind: "resource", resource: r.resource as never, min };
    if (r.kind === "item" && typeof r.item === "string" && /^[a-z0-9_]{1,64}$/.test(r.item)) t = { kind: "item", item: r.item, min: Math.floor(min) };
    if (t && !seen.has(targetKey(t))) {
      seen.add(targetKey(t));
      out.push(t);
    }
  }
  return out;
}

const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};

/** Read-only picture of every station: stock against targets, group, and readiness checks. */
export function stationStatus(
  snapshot: Snapshot, data: StationsData, next: StationOp[] = [], handoffs: Handoff[] = [], trips: Trip[] = [], dispatchNotes: Record<number, string[]> = {},
): StationStatus[] {
  const views = new Map(snapshot.probes.map((v) => [v.summary.id, v]));
  return data.stations.map((cfg) => {
    const v = views.get(cfg.probeId);
    const p = v && isFullProbe(v.detail) ? v.detail : null;
    const sector = sectorOf(v);
    const stock = p ? stockOf(p, v!.mannies) : null;
    const targets: TargetStatus[] = cfg.targets.map((t) => {
      const have = stock ? round(stock.get(t.kind === "resource" ? t.resource : t.item) ?? 0, t.kind === "resource" ? 3 : 0) : null;
      return {
        key: targetKey(t),
        label: t.kind === "resource" ? RES_LABEL[t.resource] : t.item.charAt(0).toUpperCase() + t.item.slice(1).replace(/_/g, " "),
        unit: t.kind === "resource" ? "ECE" : "",
        have,
        min: t.min,
        short: have === null ? 0 : round(Math.max(0, t.min - have), 3),
      };
    });
    const fuel = p ? fuelPercent(p) : null;
    targets.push({ key: "fuel", label: "Fuel", unit: "%", have: fuel, min: cfg.fuelFloorPercent, short: fuel === null ? 0 : Math.max(0, cfg.fuelFloorPercent - fuel) });
    const mannyCount = v?.mannies?.length ?? null;
    targets.push({ key: "mannies", label: "Mannies at the station", unit: "", have: mannyCount, min: cfg.mannyTarget, short: mannyCount === null ? 0 : Math.max(0, cfg.mannyTarget - mannyCount) });

    const members: MemberStatus[] = Object.entries(data.members)
      .filter(([, m]) => m.stationId === cfg.probeId)
      .map(([id, m]) => {
        const mv = views.get(Number(id));
        const mp = mv && isFullProbe(mv.detail) ? mv.detail : null;
        const msector = sectorOf(mv);
        const notes: string[] = [];
        if (!mv) notes.push("This probe is no longer in your fleet.");
        else if (!mv.summary.isReachable) notes.push("Out of command range: no orders can reach it until coverage returns.");
        if (!m.role) notes.push("No role yet. Pick one so the station knows what to use it for.");
        const isMoving = mp ? moving(mp) : false;
        const docked = !!mp && same(msector, sector) && !isMoving;
        const target = m.role ? cfg.mannyPerRole[m.role] : null;
        const mannies = mv?.mannies?.length ?? null;
        if (target !== null && mannies !== null && mannies < target) notes.push(`${target - mannies} Manny short of the ${ROLE_LABEL[m.role!]} target of ${target}.`);
        const extra = mp?.inventory ? mp.inventory.containers.filter((c) => c.kind === "container").length : null;
        if (extra !== null && extra >= 5) notes.push(`${extra} additional containers: each move risks a broken container link (10% at 5, +10% per extra).`);
        return {
          probeId: Number(id),
          name: mv?.summary.name ?? `Probe ${id}`,
          role: m.role,
          reachable: !!mv?.summary.isReachable,
          status: mv?.detail?.status ?? mv?.summary.status ?? "missing",
          sector: msector,
          docked,
          fuelPercent: mp ? fuelPercent(mp) : null,
          additionalContainers: extra,
          mannies,
          mannyTarget: target,
          notes,
        };
      })
      .sort((a, b) => a.probeId - b.probeId);

    const checks: Check[] = [];
    if (!v) checks.push({ ok: false, text: "This probe is no longer in your fleet. Remove the station or wait for it to come back." });
    else {
      checks.push(v.summary.isReachable
        ? { ok: true, text: "In command range." }
        : { ok: false, text: "Out of command range: the panel can't order the station until coverage returns." });
      checks.push(v.summary.isDefault
        ? { ok: true, text: "Default probe: every probe in this sector or on its SCUT network can be ordered." }
        : { ok: false, text: "Not the default probe. Orders only reach probes near the default probe, so group probes may drop out of reach. Use \"Make default probe\"." });
      const nets = (v.sector?.scutNetworks ?? []).map((n) => n.name || `Network ${n.id}`);
      checks.push(nets.length
        ? { ok: true, text: `On SCUT network ${nets.join(", ")}: ferries can be ordered anywhere it covers.` }
        : { ok: false, text: "No active SCUT network here. Ferries can only be ordered while they are in this sector. A Scout can extend coverage." });
      if (p && moving(p)) checks.push({ ok: false, text: "The station is moving. Stations should stay put; hand-offs need both probes stopped." });
      if (fuel !== null && fuel < cfg.fuelFloorPercent) checks.push({ ok: false, text: `Fuel ${fuel}% is below the station's floor of ${cfg.fuelFloorPercent}%.` });
    }
    const lost = members.filter((m) => !m.reachable).length;
    if (lost) checks.push({ ok: false, text: `${lost} group probe${lost > 1 ? "s are" : " is"} out of command range.` });
    const dayAgo = Date.now() - 86_400_000;
    for (const t of trips)
      if (t.stationId === cfg.probeId && t.state === "failed" && new Date(t.updatedAt).getTime() > dayAgo)
        checks.push({ ok: false, text: `Trip to (${t.target.x}, ${t.target.y}, ${t.target.z}) failed: ${t.note ?? "unknown reason"}` });
    for (const h of handoffs)
      if (h.stationId === cfg.probeId && h.state === "failed" && new Date(h.updatedAt).getTime() > dayAgo)
        checks.push({ ok: false, text: `Hand-off of ${h.containerId} failed: ${h.note ?? "unknown reason"}` });
    if (!cfg.service) checks.push({ ok: true, text: "Docked service is off: no hand-offs or refuelling." });
    const unassigned = members.filter((m) => !m.role).length;
    if (unassigned) checks.push({ ok: false, text: `${unassigned} group probe${unassigned > 1 ? "s have" : " has"} no role yet.` });

    return {
      probeId: cfg.probeId,
      name: v?.summary.name ?? `Probe ${cfg.probeId}`,
      config: cfg,
      reachable: !!v?.summary.isReachable,
      isDefault: !!v?.summary.isDefault,
      status: v?.detail?.status ?? v?.summary.status ?? "missing",
      sector,
      scutNetworks: (v?.sector?.scutNetworks ?? []).map((n) => n.name || `Network ${n.id}`),
      fuelPercent: fuel,
      integrity: p?.systems?.integrityPercent ?? null,
      additionalContainers: p?.inventory ? p.inventory.containers.filter((c) => c.kind === "container").length : null,
      targets,
      members,
      checks,
      next: next.filter((o) => o.stationId === cfg.probeId),
      handoffs: handoffs.filter((h) => h.stationId === cfg.probeId).slice(-20).reverse(),
      trips: trips.filter((x) => x.stationId === cfg.probeId).slice(-20).reverse(),
      dispatchNotes: dispatchNotes[cfg.probeId] ?? [],
      production: productionGoals(cfg, data, snapshot).map((g) => ({ ...g, have: stock ? (stock.get(g.item) ?? 0) : null })),
      flee: null as FleeCard | null,
    };
  });
}

export interface StationsDeps {
  /** Sets a probe's role in the automation settings (which also drives naming). */
  setRole: (probeId: number, role: ProbeRole) => Promise<void>;
  snapshot: () => Snapshot;
  onActed?: () => void;
  now?: () => number;
  /** The automation mode (auto / dry_run / off) also governs docked service. */
  mode?: () => AutoFixMode;
  /** Known sector contents for trips (visited-sector scans). */
  sectors?: () => SectorKnowledge[];
  /** Learned deuterium per sector of distance, by probe model. */
  costPerSector?: () => Record<string, number>;
  /** Tells the regular automation which probes stations control. */
  hold?: (noExplore: Set<number>, noMining: Set<number>) => void;
  /** Hands each station's production goals to the crafting planner. */
  goals?: (byProbe: Record<string, CraftGoal[]>) => void;
}

export class Stations extends EventEmitter {
  private readonly store: JsonStore<StoredData>;
  private data: StoredData = emptyData();
  /** What docked service planned on the last poll. */
  next: StationOp[] = [];
  dispatchNotes: Record<number, string[]> = {};
  fleeCards: Record<number, FleeCard> = {};
  private readonly refuels = new Map<string, number>();
  /** Rules updates sent recently: if the next poll still shows old rules, wait before sending again. */
  private readonly rulesSent = new Map<string, number>();

  constructor(private readonly game: Game, dataDir: string | undefined, private readonly deps: StationsDeps) {
    super();
    this.store = new JsonStore<StoredData>(dataDir, "stations.json", emptyData);
  }

  async load(): Promise<void> {
    this.data = await this.store.load();
    // Stations saved before a setting existed get its default.
    this.data.stations = this.data.stations.map((st) => ({
      ...structuredClone(DEFAULT_STATION), ...st, mannyPerRole: { ...DEFAULT_STATION.mannyPerRole, ...(st.mannyPerRole ?? {}) },
    }));
  }

  get handoffs(): Handoff[] {
    return this.data.handoffs;
  }

  get trips(): Trip[] {
    return this.data.trips;
  }

  get stations(): StationConfig[] {
    return this.data.stations;
  }

  get members(): StationsData["members"] {
    return this.data.members;
  }

  get log(): StationLogEntry[] {
    return this.data.log;
  }

  isStation(probeId: number): boolean {
    return this.data.stations.some((s) => s.probeId === probeId);
  }

  status(): StationStatus[] {
    return stationStatus(this.deps.snapshot(), this.data, this.next, this.data.handoffs, this.data.trips, this.dispatchNotes).map((st) => {
      const card = this.fleeCards[st.probeId] ?? null;
      if (card && !card.approved) st.checks.unshift({ ok: false, text: `Danger: ${card.reasons.join(" ")} Decide on the flee card.` });
      if (card?.approved) st.checks.unshift({ ok: false, text: `Fleeing to (${card.approved.target.x}, ${card.approved.target.y}, ${card.approved.target.z}): ${card.approved.state}.` });
      return { ...st, flee: card };
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private view(probeId: number): ProbeView | undefined {
    return this.deps.snapshot().probes.find((v) => v.summary.id === probeId);
  }

  private addLog(e: Omit<StationLogEntry, "at">): void {
    this.data.log.push({ at: new Date(this.now()).toISOString(), ...e });
    if (this.data.log.length > MAX_LOG) this.data.log.splice(0, this.data.log.length - MAX_LOG);
  }

  private async save(): Promise<void> {
    await this.store.save(this.data);
    this.emit("changed");
  }

  async makeStation(probeId: number): Promise<StationConfig> {
    const v = this.view(probeId);
    if (!v) throw new StationError(404, `Probe ${probeId} is not in your fleet.`);
    const existing = this.data.stations.find((s) => s.probeId === probeId);
    if (existing) return existing;
    const cfg: StationConfig = { probeId, ...structuredClone(DEFAULT_STATION), createdAt: new Date(this.now()).toISOString() };
    delete this.data.members[String(probeId)];
    this.data.stations.push(cfg);
    await this.deps.setRole(probeId, "Station");
    this.addLog({ stationId: probeId, probeId, label: `Made ${v.summary.name} a station`, endpoint: null, ok: true, message: null });
    await this.save();
    return cfg;
  }

  async removeStation(probeId: number): Promise<void> {
    const cfg = this.data.stations.find((s) => s.probeId === probeId);
    if (!cfg) throw new StationError(404, "That probe is not a station.");
    this.data.stations = this.data.stations.filter((s) => s.probeId !== probeId);
    for (const [id, m] of Object.entries(this.data.members))
      if (m.stationId === probeId) {
        delete this.data.members[id];
        await this.deps.setRole(Number(id), "Probe");
      }
    await this.deps.setRole(probeId, "Probe");
    this.addLog({ stationId: probeId, probeId, label: "Station removed; its group probes went back to normal automation", endpoint: null, ok: true, message: null });
    await this.save();
  }

  async updateStation(probeId: number, patch: Partial<StationConfig>): Promise<StationConfig> {
    const cfg = this.data.stations.find((s) => s.probeId === probeId);
    if (!cfg) throw new StationError(404, "That probe is not a station.");
    if (patch.mode && MODES.includes(patch.mode)) cfg.mode = patch.mode;
    if (patch.targets !== undefined) cfg.targets = sanitizeTargets(patch.targets);
    if (patch.fuelFloorPercent !== undefined) cfg.fuelFloorPercent = clamp(patch.fuelFloorPercent, 0, 100, cfg.fuelFloorPercent);
    if (patch.mannyTarget !== undefined) cfg.mannyTarget = clamp(patch.mannyTarget, 0, 500, cfg.mannyTarget);
    if (typeof patch.dispatch === "boolean") cfg.dispatch = patch.dispatch;
    if (patch.stationTankerReservePercent !== undefined) cfg.stationTankerReservePercent = clamp(patch.stationTankerReservePercent, 5, 90, cfg.stationTankerReservePercent);
    if (patch.fleeIntegrityPercent !== undefined) cfg.fleeIntegrityPercent = clamp(patch.fleeIntegrityPercent, 0, 100, cfg.fleeIntegrityPercent);
    if (patch.yardModel === "generic" || patch.yardModel === "deuterium_tanker") cfg.yardModel = patch.yardModel;
    if (patch.maxTripHours !== undefined) cfg.maxTripHours = clamp(patch.maxTripHours, 1, 72, cfg.maxTripHours);
    if (patch.tripFuelMarginPercent !== undefined) cfg.tripFuelMarginPercent = clamp(patch.tripFuelMarginPercent, 0, 90, cfg.tripFuelMarginPercent);
    if (patch.mannyPerRole && typeof patch.mannyPerRole === "object")
      for (const r of MEMBER_ROLES) if (r in patch.mannyPerRole) cfg.mannyPerRole[r] = clamp(patch.mannyPerRole[r], 0, 100, cfg.mannyPerRole[r]);
    sanitizeService(cfg, patch, clamp);
    await this.save();
    return cfg;
  }

  /**
   * Puts a probe in a station's group with a role, changes its role, or (stationId null) takes it out.
   * Per the design, a role only changes while the probe is in reach.
   */
  async setMember(probeId: number, stationId: number | null, role: MemberRole | null): Promise<void> {
    const v = this.view(probeId);
    if (!v) throw new StationError(404, `Probe ${probeId} is not in your fleet.`);
    if (this.isStation(probeId)) throw new StationError(400, "A station can't join another station's group.");
    if (role !== null && !MEMBER_ROLES.includes(role)) throw new StationError(400, "Role must be Hauler, Miner, Tanker, Station Tanker or Scout.");
    const key = String(probeId);
    const before = this.data.members[key];
    if (stationId === null) {
      if (!before) return;
      delete this.data.members[key];
      await this.deps.setRole(probeId, "Probe");
      this.addLog({ stationId: before.stationId, probeId, label: `${v.summary.name} left the group`, endpoint: null, ok: true, message: null });
      await this.save();
      return;
    }
    if (!this.isStation(stationId)) throw new StationError(404, "That station doesn't exist.");
    if (!v.summary.isReachable && (before?.role ?? null) !== role)
      throw new StationError(409, `${v.summary.name} is out of command range. Its role can be changed once it is back in reach.`);
    this.data.members[key] = { stationId, role, joinedAt: before?.stationId === stationId ? before.joinedAt : new Date(this.now()).toISOString() };
    await this.deps.setRole(probeId, role ?? "Probe");
    const st = this.view(stationId)?.summary.name ?? `Station ${stationId}`;
    this.addLog({ stationId, probeId, label: `${v.summary.name} → ${st} as ${role ?? "no role"}`, endpoint: null, ok: true, message: null });
    await this.save();
  }

  /** PATCH /api/probe/{id} {isDefault: true}: keeps the whole group in reach of the station. */
  async makeDefault(stationId: number): Promise<{ ok: boolean; message: string }> {
    if (!this.isStation(stationId)) throw new StationError(404, "That probe is not a station.");
    const endpoint = `PATCH /api/probe/${stationId}`;
    try {
      unwrap(await this.game.action.PATCH("/api/probe/{probeId}", { params: { path: { probeId: stationId } }, body: { isDefault: true } }));
      this.addLog({ stationId, probeId: stationId, label: "Made the station the default probe", endpoint, ok: true, message: null });
      await this.save();
      this.deps.onActed?.();
      return { ok: true, message: "The station is now the default probe." };
    } catch (err) {
      const message = err instanceof GameError
        ? err.status === 422
          ? "The game refused: the station must be in the same sector as the current default probe, or on the same active SCUT network."
          : `${err.code}: ${err.message}`
        : String(err);
      this.addLog({ stationId, probeId: stationId, label: "Make the station the default probe", endpoint, ok: false, message });
      await this.save();
      return { ok: false, message };
    }
  }

  /** Merchant confirmed a flee card: recall local Mannies, then move (run from onSnapshot). */
  async confirmFlee(stationId: number, target: { x: number; y: number; z: number }): Promise<void> {
    const card = this.fleeCards[stationId];
    if (!card) throw new StationError(409, "There is no flee card for this station right now.");
    if (!card.options.some((o) => o.target.x === target?.x && o.target.y === target?.y && o.target.z === target?.z))
      throw new StationError(400, "Pick one of the destinations on the card.");
    this.data.flee[String(stationId)] = { target, at: new Date(this.now()).toISOString(), state: "recalling" };
    this.addLog({ stationId, probeId: stationId, label: `You confirmed a flee to (${target.x}, ${target.y}, ${target.z})`, endpoint: null, ok: true, message: card.reasons.join(" ") });
    await this.save();
    this.deps.onActed?.();
  }

  async cancelFlee(stationId: number): Promise<void> {
    if (!this.data.flee[String(stationId)]) return;
    delete this.data.flee[String(stationId)];
    this.addLog({ stationId, probeId: stationId, label: "Flee cancelled", endpoint: null, ok: true, message: null });
    await this.save();
  }

  /** Housekeeping on every poll: a probe that appears in a station's sector joins its group with no role. */
  async onSnapshot(snapshot: Snapshot): Promise<void> {
    const ids = snapshot.probes.map((v) => v.summary.id);
    if (!ids.length) return;
    let changed = false;
    if (this.data.knownProbes) {
      const known = new Set(this.data.knownProbes);
      for (const v of snapshot.probes) {
        const id = v.summary.id;
        if (known.has(id) || this.isStation(id) || this.data.members[String(id)]) continue;
        const at = this.data.stations.find((s) => same(sectorOf(snapshot.probes.find((x) => x.summary.id === s.probeId)), sectorOf(v)));
        if (!at) continue;
        this.data.members[String(id)] = { stationId: at.probeId, role: null, joinedAt: new Date(this.now()).toISOString() };
        this.addLog({ stationId: at.probeId, probeId: id, label: `New probe ${v.summary.name} joined the group with no role`, endpoint: null, ok: true, message: null });
        changed = true;
      }
    }
    const known = [...new Set([...(this.data.knownProbes ?? []), ...ids])].sort((a, b) => a - b);
    if (known.length !== (this.data.knownProbes?.length ?? -1)) changed = true;
    this.data.knownProbes = known;

    // Docked service (5b).
    const t = this.now();
    for (const { h, note, ok } of trackHandoffs(snapshot, this.data.handoffs, t)) {
      this.addLog({ stationId: h.stationId, probeId: h.toProbeId, label: `Hand-off of ${h.containerId}: ${h.state}`, endpoint: null, ok, message: note });
      changed = true;
    }
    if (this.data.handoffs.length > 200) this.data.handoffs.splice(0, this.data.handoffs.length - 200);
    for (const [k, at] of this.refuels) if (t - at > REFUEL_GAP_MS) this.refuels.delete(k);
    const busy = recentlyOrdered(t);
    // Danger first: flee cards and confirmed flees.
    const fleeOps: StationOp[] = [];
    this.fleeCards = {};
    for (const cfg of this.data.stations) {
      const key = String(cfg.probeId);
      const v = snapshot.probes.find((x) => x.summary.id === cfg.probeId);
      let ap: FleeApproval | null = this.data.flee[key] ?? null;
      if (ap && v && isFullProbe(v.detail)) {
        const pos = sectorOf(v);
        const movingNow = !!v.detail.movement && !["arrived", "failed", "destroyed"].includes(v.detail.movement.status);
        if (movingNow && ap.state !== "moving") { ap.state = "moving"; changed = true; }
        if (!movingNow && same(pos, ap.target)) {
          delete this.data.flee[key];
          for (const tr of this.data.trips) if (tr.stationId === cfg.probeId && ACTIVE.includes(tr.state)) tr.home = ap.target;
          this.addLog({ stationId: cfg.probeId, probeId: cfg.probeId, label: `Fled to (${ap.target.x}, ${ap.target.y}, ${ap.target.z})`, endpoint: null, ok: true, message: "Trips now come home here." });
          ap = null;
          changed = true;
        } else if (!movingNow && t - new Date(ap.at).getTime() > 6 * 3_600_000) {
          delete this.data.flee[key];
          this.addLog({ stationId: cfg.probeId, probeId: cfg.probeId, label: "Flee dropped: it didn't start within 6 hours", endpoint: null, ok: false, message: null });
          ap = null;
          changed = true;
        } else if (!movingNow && ap.state === "recalling") {
          const local = (v.mannies ?? []).filter((m) => m.location.type === "sector" && same(m.location.sector?.relative ?? null, pos));
          for (const m of local.filter((x) => x.currentTask !== "returning" && !busy.has(x.id)))
            fleeOps.push({
              id: `flee:recall:${m.id}`, stationId: cfg.probeId, label: `${m.name} is recalled before the flee`, why: "You confirmed the flee; Mannies outside come aboard first.",
              endpoint: `POST /api/probe/${cfg.probeId}/mannies/${m.id}/recall`, plan: { kind: "recall", probeId: cfg.probeId, mannyId: m.id },
            });
          if (!local.length)
            fleeOps.push({
              id: `flee:move:${cfg.probeId}`, stationId: cfg.probeId, label: `${v.summary.name} flees to (${ap.target.x}, ${ap.target.y}, ${ap.target.z})`,
              why: "You confirmed the flee and every local Manny is aboard.", endpoint: `POST /api/probe/${cfg.probeId}/move`,
              plan: { kind: "flee_move", probeId: cfg.probeId, target: ap.target },
            });
        }
      }
      if (v) {
        const card = fleeCard(v, cfg, this.deps.sectors?.() ?? [], this.deps.costPerSector?.() ?? {}, ap, snapshot, t);
        if (card) this.fleeCards[cfg.probeId] = card;
      }
    }
    // Trips first: they decide which Haulers leave, and their Mannies.
    const dispatch = planDispatch({
      snapshot, data: this.data, status: stationStatus(snapshot, this.data), trips: this.data.trips, handoffs: this.data.handoffs,
      sectors: this.deps.sectors?.() ?? [], costPerSector: this.deps.costPerSector?.() ?? {}, busy, now: t,
      recentRefuels: new Set(this.refuels.keys()),
    });
    const tankers = planStationTankers({
      snapshot, data: this.data, trips: this.data.trips, sectors: this.deps.sectors?.() ?? [], costPerSector: this.deps.costPerSector?.() ?? {},
      busy, recentRefuels: new Set(this.refuels.keys()), now: t,
    });
    const miners = planStationMiners({ snapshot, data: this.data, status: stationStatus(snapshot, this.data), busy });
    dispatch.ops.push(...tankers.ops, ...miners.ops);
    for (const id of miners.noMining) dispatch.noMining.add(id);
    for (const [k, n] of Object.entries(miners.notes)) (dispatch.notes[Number(k)] ??= []).push(...n);
    dispatch.changes.push(...tankers.changes);
    for (const id of tankers.noMining) dispatch.noMining.add(id);
    for (const [k, n] of Object.entries(tankers.notes)) (dispatch.notes[Number(k)] ??= []).push(...n);
    for (const { trip, note, ok } of dispatch.changes) {
      this.addLog({ stationId: trip.stationId, probeId: trip.haulerId, label: `Trip to (${trip.target.x}, ${trip.target.y}, ${trip.target.z}): ${trip.state}`, endpoint: null, ok, message: note });
      changed = true;
    }
    if (this.data.trips.length > 200) this.data.trips.splice(0, this.data.trips.length - 200);
    this.dispatchNotes = dispatch.notes;
    const grouped = new Set<number>([...this.data.stations.map((x) => x.probeId), ...Object.keys(this.data.members).map(Number)]);
    const fleeing = new Set(Object.keys(this.data.flee).map(Number));
    this.deps.hold?.(grouped, new Set([...dispatch.noMining, ...fleeing]));
    this.deps.goals?.(Object.fromEntries(this.data.stations.map((c) => [String(c.probeId), toCraftGoals(c.probeId, productionGoals(c, this.data, snapshot))])));
    const away = new Set(this.data.trips.filter((x) => ACTIVE.includes(x.state) && x.state !== "handing_over").map((x) => x.haulerId));
    for (const o of dispatch.ops) if (o.plan.kind === "trip_move") away.add(o.plan.probeId); // leaving now: no new docked work
    const service = planService({
      snapshot, data: this.data, handoffs: this.data.handoffs, busy, recentRefuels: new Set(this.refuels.keys()),
    }).filter((o) => !((o.plan.kind === "detach" || o.plan.kind === "refuel") &&
      (away.has(o.plan.probeId) || away.has(o.plan.kind === "detach" ? o.plan.toProbeId : o.plan.targetProbeId))));
    // A station that is fleeing starts nothing new: no trips out, no hand-offs, no refuels.
    const calm = (o: StationOp) => !fleeing.has(o.stationId) || (o.plan.kind === "trip_move" && o.plan.leg === "home") || o.plan.kind === "trip_mine";
    this.next = [...fleeOps, ...dispatch.ops.filter(calm), ...service.filter(calm)];
    const mode = this.deps.mode?.() ?? "auto";
    let acted = false;
    if (mode !== "off") {
      let n = 0;
      for (const op of this.next) {
        if (n >= MAX_OPS_PER_CYCLE) break;
        const retry = this.data.failures[op.id];
        if (retry && new Date(retry).getTime() > t) continue;
        if (op.plan.kind === "rules" && t - (this.rulesSent.get(op.id) ?? -Infinity) < RULES_GAP_MS) continue;
        n++;
        changed = true;
        if (await this.execute(op, snapshot, mode === "dry_run")) acted ||= mode === "auto";
      }
    }
    if (changed) await this.save();
    else this.emit("changed");
    if (acted) this.deps.onActed?.();
  }

  private async execute(op: StationOp, snapshot: Snapshot, dry: boolean): Promise<boolean> {
    const t = this.now();
    const plan = op.plan;
    if (dry) {
      this.addLog({ stationId: op.stationId, probeId: plan.probeId, label: op.label, endpoint: op.endpoint, ok: true, message: "Dry run: not sent." });
      return true;
    }
    const c = this.game.action;
    try {
      switch (plan.kind) {
        case "rules":
          unwrap(await c.PATCH("/api/probe/{probeId}/storage-containers/{containerId}/rules", {
            params: { path: { probeId: plan.probeId, containerId: plan.containerId } }, body: plan.rules,
          }));
          this.rulesSent.set(op.id, t);
          break;
        case "detach": {
          const send = () => c.POST("/api/probe/{probeId}/mannies/{mannyId}/detach-storage-container", {
            params: { path: { probeId: plan.probeId, mannyId: plan.mannyId } },
            body: { containerId: plan.containerId, mode: "attach_to_probe", objectId: String(plan.toProbeId) },
          });
          const before = detachedContainersIn(snapshot.probes.find((v) => v.summary.id === plan.toProbeId));
          let r = await send();
          if (r.response.status === 409 && (r.error as { error?: { code?: string } } | undefined)?.error?.code === "storage_container_reserved") {
            // A craft holds space in it: move the reservation to another container, then try once more.
            unwrap(await c.POST("/api/probe/{probeId}/storage-containers/{containerId}/crafting-reservations/reassign", {
              params: { path: { probeId: plan.probeId, containerId: plan.containerId } },
            }));
            this.addLog({ stationId: op.stationId, probeId: plan.probeId, label: `Moved crafting reservations off ${plan.containerId} before the hand-off`,
              endpoint: `POST /api/probe/${plan.probeId}/storage-containers/${plan.containerId}/crafting-reservations/reassign`, ok: true, message: null });
            r = await send();
          }
          unwrap(r);
          const at = new Date(t).toISOString();
          this.data.handoffs.push({
            id: `${plan.containerId}@${t}`, stationId: op.stationId, containerId: plan.containerId, fromProbeId: plan.probeId, toProbeId: plan.toProbeId,
            purpose: plan.purpose, state: "sent", at, updatedAt: at, sectorBefore: before, note: null,
          });
          break;
        }
        case "recover": {
          unwrap(await c.POST("/api/probe/{probeId}/mannies/{mannyId}/recover-storage-container", {
            params: { path: { probeId: plan.probeId, mannyId: plan.mannyId } }, body: { objectId: plan.objectId },
          }));
          const h = this.data.handoffs.find((x) => x.id === plan.handoffId);
          if (h) Object.assign(h, { state: "recovering", updatedAt: new Date(t).toISOString(), note: "Recovering it from the sector." });
          break;
        }
        case "trip_move": {
          unwrap(await c.POST("/api/probe/{probeId}/move", { params: { path: { probeId: plan.probeId } }, body: { target: plan.target } }));
          const now = new Date(t).toISOString();
          if (plan.ret) {
            this.data.trips.push({
              id: plan.tripId, stationId: op.stationId, haulerId: plan.probeId, target: plan.target, home: plan.target, resource: "", reason: plan.reason,
              state: "returning", startedAt: now, updatedAt: now, arrivedAt: null, note: "Flying home to the station.", kind: "haul",
            });
          } else if (plan.leg === "out") {
            const home = sectorOf(snapshot.probes.find((v) => v.summary.id === plan.probeId)) ?? { x: 0, y: 0, z: 0 };
            this.data.trips.push({
              id: plan.tripId, stationId: op.stationId, haulerId: plan.probeId, target: plan.target, home, resource: plan.resource, reason: plan.reason,
              state: "outbound", startedAt: now, updatedAt: now, arrivedAt: null, note: "On the way.",
              kind: plan.tripKind ?? (plan.rescue ? "rescue" : "haul"), rescue: plan.rescue ? { ...plan.rescue, sentAt: null } : undefined,
            });
          } else {
            const trip = this.data.trips.find((x) => x.id === plan.tripId);
            if (trip) Object.assign(trip, { state: "returning", updatedAt: now, note: "Flying home." });
          }
          break;
        }
        case "recall":
          unwrap(await c.POST("/api/probe/{probeId}/mannies/{mannyId}/recall", { params: { path: { probeId: plan.probeId, mannyId: plan.mannyId } } }));
          break;
        case "flee_move": {
          unwrap(await c.POST("/api/probe/{probeId}/move", { params: { path: { probeId: plan.probeId } }, body: { target: plan.target } }));
          const ap = this.data.flee[String(plan.probeId)];
          if (ap) ap.state = "moving";
          const shown = this.fleeCards[plan.probeId]?.approved;
          if (shown) shown.state = "moving";
          break;
        }
        case "manny_move":
          unwrap(await c.POST("/api/probe/{probeId}/mannies/{mannyId}/transfer-to-probe", {
            params: { path: { probeId: plan.probeId, mannyId: plan.mannyId } }, body: { targetProbeId: plan.targetProbeId },
          }));
          this.refuels.set(`manny:${plan.probeId}:${plan.targetProbeId}`, t);
          break;
        case "trip_mine":
          unwrap(await c.POST("/api/probe/{probeId}/mannies/{mannyId}/mine", {
            params: { path: { probeId: plan.probeId, mannyId: plan.mannyId } },
            body: { objectId: plan.objectId, resources: [plan.resource as never], targetAmount: plan.targetAmount },
          }));
          break;
        case "refuel":
          unwrap(await c.POST("/api/probe/{probeId}/mannies/{mannyId}/transfer-deuterium-to-probe", {
            params: { path: { probeId: plan.probeId, mannyId: plan.mannyId } }, body: { targetProbeId: plan.targetProbeId, amount: plan.amount },
          }));
          this.refuels.set(`${plan.probeId}:${plan.targetProbeId}`, t);
          if (plan.tripId) {
            const trip = this.data.trips.find((x) => x.id === plan.tripId);
            if (trip?.rescue) trip.rescue.sentAt = new Date(t).toISOString();
          }
          break;
      }
      if ("mannyId" in plan) markOrdered(plan.mannyId, t);
      delete this.data.failures[op.id];
      this.addLog({ stationId: op.stationId, probeId: plan.probeId, label: op.label, endpoint: op.endpoint, ok: true, message: null });
      return true;
    } catch (err) {
      const message = err instanceof GameError ? `${err.status} ${err.code}: ${err.message}` : String(err);
      this.data.failures[op.id] = new Date(t + FAIL_BACKOFF_MS).toISOString();
      this.addLog({ stationId: op.stationId, probeId: plan.probeId, label: op.label, endpoint: op.endpoint, ok: false, message: `${message} (retrying in 10 min)` });
      return false;
    }
  }
}
