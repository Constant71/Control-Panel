/**
 * Stations step 5b: docked service. Pure planner for what a station and its docked group
 * probes should do right now: routing rules on Hauler containers, whole-container hand-offs,
 * and deuterium top-ups. Every call is a v150 endpoint:
 *  - PATCH /api/probe/{id}/storage-containers/{cid}/rules
 *  - POST  /api/probe/{id}/mannies/{mid}/detach-storage-container {containerId, mode: attach_to_probe, objectId: "<probe id>"}
 *  - POST  /api/probe/{id}/mannies/{mid}/recover-storage-container {objectId}  (if the attach leaves it in the sector)
 *  - POST  /api/probe/{id}/mannies/{mid}/transfer-deuterium-to-probe {targetProbeId, amount}
 *  - POST  /api/probe/{id}/storage-containers/{cid}/crafting-reservations/reassign (only after a 409 storage_container_reserved)
 * Spec rules honoured: both probes in the same sector and not moving; the transfer amount must be
 * strictly below the source's deuterium; detach needs an idle onboard Manny.
 */
import type { Snapshot, ProbeView } from "./poller.js";
import type { Schemas } from "./gameClient.js";
import { isFullProbe } from "../shared/attention.js";
import { FALLBACK_MANNY_SPACE, pendingCargo } from "./automation.js";
import { sectorOf } from "./stations.js";
import type { Handoff, StationConfig, StationOp, StationsData, StorageRules } from "../shared/stations.js";
import { ROLE_LABEL } from "../shared/stations.js";

type Probe = Schemas["Probe"];
type Manny = Schemas["Manny"];
type Container = Schemas["StorageContainer"];

/** Movement link risk starts at 5 additional containers (spec: 10% at 5, +10% each). */
export const MAX_FERRY_CONTAINERS = 4;
const CARGO = ["metals", "ice", "carbon_compounds"];
/** Idle Mannies left at each probe for repairs and fixes. */
const KEEP_IDLE = 1;

export function isMoving(p: Probe): boolean {
  return (!!p.movement && !["arrived", "failed", "destroyed"].includes(p.movement.status)) ||
    ["preparing", "accelerating", "cruising", "decelerating"].includes(p.status);
}

const operational = (p: Probe) => !["dead", "disabled", "trapped_by_black_hole"].includes(p.status);
const maxFuel = (p: Probe) => p.fuel.maxDeuterium ?? (p.model === "deuterium_tanker" ? 400 : 100);
const round2 = (n: number) => Math.floor(n * 100) / 100;

export const isHandoffContainer = (c: Container) => c.kind === "container" && (c.rules?.strictExclusion ?? []).map(String).includes("manny");

/** Hand-off rules (Merchant's ferry safety): cargo first, never a Manny. */
export function handoffRules(c: Container): StorageRules {
  const r = c.rules ?? {};
  return {
    priority: [...new Set([...(r.priority ?? []).map(String).filter((x) => x !== "manny"), ...CARGO])],
    exclusion: (r.exclusion ?? []).map(String).filter((x) => x !== "manny"),
    strictExclusion: [...new Set([...(r.strictExclusion ?? []).map(String), "manny"])],
  };
}

/** Home rules: Mannies and their spares come back to the probe core first. */
export function homeRules(c: Container): StorageRules {
  const r = c.rules ?? {};
  return {
    priority: ["manny", ...(r.priority ?? []).map(String).filter((x) => x !== "manny")],
    exclusion: (r.exclusion ?? []).map(String).filter((x) => x !== "manny"),
    strictExclusion: (r.strictExclusion ?? []).map(String).filter((x) => x !== "manny"),
  };
}

/** Hand-off container space on a probe: cargo room, never Manny room. */
function isHandoffContainerList(p: Probe): { free: number } {
  return { free: (p.inventory?.containers ?? []).filter(isHandoffContainer).reduce((s, c) => s + (c.freeCapacity ?? 0), 0) };
}

function mannyIn(p: Probe, containerId: string): boolean {
  return (p.inventory?.items ?? []).some((i) => i.type === "manny" && i.container?.id === containerId);
}

function holdsAnything(p: Probe, c: Container): boolean {
  if ((c.usedCapacity ?? 0) > 1e-9) return true;
  return (p.inventory?.items ?? []).some((i) => i.container?.id === c.id);
}

/** Free space left after every Manny outside comes home with its cargo. */
function spareRoom(p: Probe, mannies: Manny[]): number {
  const inv = p.inventory;
  if (!inv) return 0;
  const space = Math.max(0, ...inv.items.filter((i) => i.type === "manny").map((i) => i.containerSpace)) || FALLBACK_MANNY_SPACE;
  const outside = mannies.filter((m) => m.location.type === "sector");
  return inv.freeCapacity - outside.reduce((s, m) => s + space + pendingCargo(m), 0);
}

export function detachedContainersIn(v: ProbeView | undefined): string[] {
  return ((v?.sector?.objects ?? []) as Schemas["SectorObject"][]).filter((o) => o.type === "detached_container" && o.id).map((o) => o.id!);
}

export interface ServiceInput {
  snapshot: Snapshot;
  data: Pick<StationsData, "stations" | "members">;
  handoffs: Handoff[];
  /** Mannies that just got an order (the game applies orders asynchronously). */
  busy: Set<string>;
  /** Refuels ("<source>:<target>") and Manny moves ("manny:<source>:<target>") sent recently, so neither is sent twice. */
  recentRefuels: Set<string>;
}

export function planService({ snapshot, data, handoffs, busy, recentRefuels }: ServiceInput): StationOp[] {
  const ops: StationOp[] = [];
  const views = new Map(snapshot.probes.map((v) => [v.summary.id, v]));
  const active = handoffs.filter((h) => h.state === "sent" || h.state === "recovering");
  const inFlight = new Set(active.map((h) => h.containerId));

  const idlePool = (v: ProbeView) => {
    const idle = (v.mannies ?? []).filter((m) => m.location.type === "probe" && m.currentTask === null && m.canReceiveOrders && !busy.has(m.id));
    let spare = idle.length - KEEP_IDLE;
    return () => {
      if (spare <= 0) return null;
      spare--;
      const m = idle.shift()!;
      busy.add(m.id);
      return m;
    };
  };

  for (const cfg of data.stations) {
    if (!cfg.service) continue;
    const sv = views.get(cfg.probeId);
    if (!sv || !sv.summary.isReachable || !isFullProbe(sv.detail) || !sv.mannies) continue;
    const S = sv.detail;
    const stationName = sv.summary.name;
    const sTake = idlePool(sv);
    const sSector = sectorOf(sv);
    const sOk = operational(S) && !isMoving(S);
    let sRoom = spareRoom(S, sv.mannies);
    let sFuel = S.fuel.deuterium;
    const sFloor = (cfg.fuelFloorPercent / 100) * maxFuel(S);
    const push = (op: Omit<StationOp, "stationId">) => ops.push({ ...op, stationId: cfg.probeId });

    // Recover containers that an attach left drifting in the sector (the spec doesn't say which happens).
    for (const h of active.filter((x) => x.stationId === cfg.probeId)) {
      const to = views.get(h.toProbeId);
      if (!to || !to.summary.isReachable || !isFullProbe(to.detail) || !to.mannies) continue;
      if (to.detail.inventory?.containers.some((c) => c.id === h.containerId)) continue;
      const from = views.get(h.fromProbeId);
      if (from?.mannies?.some((m) => m.currentTask === "detaching_storage_container")) continue; // still detaching
      const fresh = detachedContainersIn(to).filter((id) => !h.sectorBefore.includes(id));
      if (fresh.length !== 1 || isMoving(to.detail)) continue; // ambiguous or none: the tracker reports it
      if (to.mannies.some((m) => m.currentTask === "salvage" || m.currentTask === "inspecting_sector_object")) continue;
      const m = idlePool(to)();
      if (!m) continue;
      push({
        id: `recover:${h.id}`, label: `${m.name} takes in the hand-off container at ${to.summary.name}`,
        why: "The container was attached but left in the sector, so the receiver recovers it.",
        endpoint: `POST /api/probe/${h.toProbeId}/mannies/${m.id}/recover-storage-container`,
        plan: { kind: "recover", probeId: h.toProbeId, mannyId: m.id, objectId: fresh[0], handoffId: h.id },
      });
    }

    for (const [key, mem] of Object.entries(data.members)) {
      if (mem.stationId !== cfg.probeId || !mem.role) continue;
      const mv = views.get(Number(key));
      if (!mv || !mv.summary.isReachable || !isFullProbe(mv.detail) || !mv.mannies) continue;
      const M = mv.detail;
      const name = mv.summary.name;
      const inv = M.inventory;

      // Hauler routing rules hold at all times, docked or not: Mannies never land in a hand-off container.
      if ((mem.role === "Hauler" || mem.role === "Miner") && inv) {
        for (const c of inv.containers) {
          if (inFlight.has(c.id)) continue;
          if (c.kind === "container" && !isHandoffContainer(c)) {
            push({
              id: `rules:${M.id}:${c.id}`, label: `Mark ${name}'s "${c.label}" as a hand-off container`,
              why: "Hand-off containers get cargo first and never a Manny (strictExclusion: manny), so no Manny is ever handed over.",
              endpoint: `PATCH /api/probe/${M.id}/storage-containers/${c.id}/rules`,
              plan: { kind: "rules", probeId: M.id, containerId: c.id, rules: handoffRules(c) },
            });
          }
          if (c.kind === "probe" && !(c.rules?.priority ?? []).map(String).includes("manny")) {
            push({
              id: `rules:${M.id}:${c.id}`, label: `Make ${name}'s core the Mannies' home`,
              why: "Mannies coming back go to the probe core first, keeping hand-off containers free for cargo.",
              endpoint: `PATCH /api/probe/${M.id}/storage-containers/${c.id}/rules`,
              plan: { kind: "rules", probeId: M.id, containerId: c.id, rules: homeRules(c) },
            });
          }
        }
      }

      const docked = sOk && operational(M) && !isMoving(M) && JSON.stringify(sectorOf(mv)) === JSON.stringify(sSector);
      if (!docked || !inv) continue;
      const mTake = idlePool(mv);
      let mRoom = spareRoom(M, mv.mannies);

      if (mem.role === "Hauler" || mem.role === "Miner") {
        // Hand over full hand-off containers.
        let extra = inv.containers.filter((c) => c.kind === "container").length;
        for (const c of inv.containers) {
          if (!isHandoffContainer(c) || inFlight.has(c.id) || !c.capacity) continue;
          const fill = ((c.usedCapacity ?? 0) / c.capacity) * 100;
          if (fill < cfg.handoffMinFillPercent) continue;
          if (mannyIn(M, c.id)) continue; // never hand over a Manny; the fixer moves it first
          if (mRoom - (c.freeCapacity ?? 0) < 0) continue; // its free part may be room an outside Manny needs
          const m = mTake();
          if (!m) break;
          mRoom -= c.freeCapacity ?? 0;
          extra--;
          push({
            id: `detach:${c.id}`, label: `${m.name} hands "${c.label}" (${Math.round(fill)}% full) from ${name} to ${stationName}`,
            why: `${name} is docked and this hand-off container is at least ${cfg.handoffMinFillPercent}% full.`,
            endpoint: `POST /api/probe/${M.id}/mannies/${m.id}/detach-storage-container`,
            plan: { kind: "detach", probeId: M.id, mannyId: m.id, containerId: c.id, toProbeId: cfg.probeId, purpose: "full" },
          });
        }
        // Give empty containers to carry back out.
        const want = Math.min(cfg.containersPerHauler, MAX_FERRY_CONTAINERS);
        const incoming = active.filter((h) => h.toProbeId === M.id).length;
        let need = want - extra - incoming;
        // A probe yard keeps two empty containers for the assembly kit (assemble-probe takes 2 containerIds).
        let keep = cfg.mode === "probe_yard" ? 2 : 0;
        for (const c of S.inventory?.containers ?? []) {
          if (need <= 0) break;
          if (c.kind !== "container" || inFlight.has(c.id) || holdsAnything(S, c)) continue;
          if (keep > 0) { keep--; continue; }
          if (sRoom - (c.capacity ?? 0) < 0) continue; // the station's outside Mannies still need room
          const m = sTake();
          if (!m) break;
          sRoom -= c.capacity ?? 0;
          need--;
          push({
            id: `detach:${c.id}`, label: `${m.name} gives empty "${c.label}" from ${stationName} to ${name}`,
            why: `${name} carries ${extra + incoming} of ${want} additional containers; it needs empties to carry cargo back.`,
            endpoint: `POST /api/probe/${cfg.probeId}/mannies/${m.id}/detach-storage-container`,
            plan: { kind: "detach", probeId: cfg.probeId, mannyId: m.id, containerId: c.id, toProbeId: M.id, purpose: "empty" },
          });
        }
      }

      // Manny split: keep each role's Manny target, moving idle Mannies between station and ferry.
      const target = cfg.mannyPerRole[mem.role];
      const mCount = mv.mannies.length;
      const sCount = sv.mannies.length;
      const space = (p: Probe) => Math.max(0, ...(p.inventory?.items ?? []).filter((i) => i.type === "manny").map((i) => i.containerSpace)) || FALLBACK_MANNY_SPACE;
      const homeFree = (p: Probe, room: number) => room - (isHandoffContainerList(p).free);
      const moving = [...mv.mannies, ...sv.mannies].some((m) => m.currentTask === "transferring_to_probe")
        || recentRefuels.has(`manny:${cfg.probeId}:${M.id}`) || recentRefuels.has(`manny:${M.id}:${cfg.probeId}`);
      if (moving) {
        // one Manny move at a time per pair: counts only update once the transfer completes
      } else if (mCount < target && sCount > cfg.mannyTarget && homeFree(M, mRoom) >= space(M)) {
        const m = sTake();
        if (m) {
          mRoom -= space(M);
          push({
            id: `manny:${m.id}:${M.id}`, label: `${m.name} moves from ${stationName} to ${name}`,
            why: `${name} has ${mCount} Mannies (${ROLE_LABEL[mem.role]} target ${target}); ${stationName} has ${sCount}, above its ${cfg.mannyTarget}.`,
            endpoint: `POST /api/probe/${cfg.probeId}/mannies/${m.id}/transfer-to-probe`,
            plan: { kind: "manny_move", probeId: cfg.probeId, mannyId: m.id, targetProbeId: M.id },
          });
        }
      } else if (mCount > target && sCount < cfg.mannyTarget && sRoom >= space(S)) {
        const m = mTake();
        if (m) {
          sRoom -= space(S);
          push({
            id: `manny:${m.id}:${cfg.probeId}`, label: `${m.name} moves from ${name} to ${stationName}`,
            why: `${name} has ${mCount} Mannies (${ROLE_LABEL[mem.role]} target ${target}); ${stationName} has ${sCount}, below its ${cfg.mannyTarget}.`,
            endpoint: `POST /api/probe/${M.id}/mannies/${m.id}/transfer-to-probe`,
            plan: { kind: "manny_move", probeId: M.id, mannyId: m.id, targetProbeId: cfg.probeId },
          });
        }
      }

      if (mem.role === "StationTanker") {
        // Its deuterium hand-overs are planned in stationTanker.ts; the station never fuels it.
      } else if (mem.role === "Tanker") {
        // A docked tanker tops the station up, keeping its own reserve.
        const sMax = maxFuel(S);
        const give = round2(Math.min(sMax - sFuel, M.fuel.deuterium - (cfg.tankerReservePercent / 100) * maxFuel(M)));
        if (sFuel < sMax * 0.98 && give >= 1 && give < M.fuel.deuterium && !recentRefuels.has(`${M.id}:${cfg.probeId}`)) {
          const m = mTake();
          if (m) {
            sFuel += give;
            push({
              id: `refuel:${M.id}:${cfg.probeId}`, label: `${m.name} moves ${give} deuterium from ${name} to ${stationName}`,
              why: `${stationName} is at ${Math.round((S.fuel.deuterium / sMax) * 100)}%; ${name} keeps its ${cfg.tankerReservePercent}% reserve.`,
              endpoint: `POST /api/probe/${M.id}/mannies/${m.id}/transfer-deuterium-to-probe`,
              plan: { kind: "refuel", probeId: M.id, mannyId: m.id, targetProbeId: cfg.probeId, amount: give },
            });
          }
        }
      } else if (mem.role !== "Miner") {
        // Top up docked ferries from the station, never below the station's own fuel floor (a Miner never flies).
        const mMax = maxFuel(M);
        const pct = (M.fuel.deuterium / mMax) * 100;
        const give = round2(Math.min((cfg.ferryFuelTargetPercent / 100) * mMax - M.fuel.deuterium, sFuel - sFloor - 0.01));
        if (pct < cfg.ferryFuelTargetPercent && give >= 1 && give < sFuel && !recentRefuels.has(`${cfg.probeId}:${M.id}`)) {
          const m = sTake();
          if (m) {
            sFuel -= give;
            push({
              id: `refuel:${cfg.probeId}:${M.id}`, label: `${m.name} moves ${give} deuterium from ${stationName} to ${name}`,
              why: `${name} is docked at ${Math.round(pct)}% fuel (target ${cfg.ferryFuelTargetPercent}%). ${stationName} stays above its ${cfg.fuelFloorPercent}% floor.`,
              endpoint: `POST /api/probe/${cfg.probeId}/mannies/${m.id}/transfer-deuterium-to-probe`,
              plan: { kind: "refuel", probeId: cfg.probeId, mannyId: m.id, targetProbeId: M.id, amount: give },
            });
          }
        }
      }
    }
  }
  return ops;
}

/** Moves hand-offs forward from what the latest poll shows. */
export function trackHandoffs(snapshot: Snapshot, handoffs: Handoff[], now: number): Array<{ h: Handoff; note: string; ok: boolean }> {
  const changes: Array<{ h: Handoff; note: string; ok: boolean }> = [];
  const views = new Map(snapshot.probes.map((v) => [v.summary.id, v]));
  for (const h of handoffs) {
    if (h.state !== "sent" && h.state !== "recovering") continue;
    const to = views.get(h.toProbeId);
    const from = views.get(h.fromProbeId);
    const has = (v: ProbeView | undefined) => !!v && isFullProbe(v.detail) && !!v.detail.inventory?.containers.some((c) => c.id === h.containerId);
    const set = (state: Handoff["state"], note: string, ok: boolean) => {
      h.state = state;
      h.note = note;
      h.updatedAt = new Date(now).toISOString();
      changes.push({ h, note, ok });
    };
    if (has(to)) set("done", `Arrived at ${to!.summary.name}.`, true);
    else if (has(from) && now - new Date(h.at).getTime() > 10 * 60_000)
      set("failed", "The container is still aboard the sender: the detach did not happen.", false);
    else if (now - new Date(h.at).getTime() > 2 * 3_600_000)
      set("failed", "Not seen at the receiver after 2 hours. Check the sector for a detached container.", false);
  }
  return changes;
}

export function sanitizeService(cfg: StationConfig, patch: Partial<StationConfig>, clamp: (v: unknown, lo: number, hi: number, d: number) => number): void {
  if (typeof patch.service === "boolean") cfg.service = patch.service;
  if (patch.handoffMinFillPercent !== undefined) cfg.handoffMinFillPercent = clamp(patch.handoffMinFillPercent, 1, 100, cfg.handoffMinFillPercent);
  if (patch.containersPerHauler !== undefined) cfg.containersPerHauler = clamp(patch.containersPerHauler, 0, MAX_FERRY_CONTAINERS, cfg.containersPerHauler);
  if (patch.ferryFuelTargetPercent !== undefined) cfg.ferryFuelTargetPercent = clamp(patch.ferryFuelTargetPercent, 0, 100, cfg.ferryFuelTargetPercent);
  if (patch.tankerReservePercent !== undefined) cfg.tankerReservePercent = clamp(patch.tankerReservePercent, 0, 100, cfg.tankerReservePercent);
}
