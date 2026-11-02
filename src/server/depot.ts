/**
 * Asteroid depot (Merchant, 2026-11-02): mining without the travel legs.
 *
 * A plain mine order makes every Manny fly out, mine 0.05 ECE and fly back. The spec's
 * MannyMineRequest.targetContainerId says: "When it targets a hidden container on the asteroid
 * ... being mined, travel time is deducted and only extraction time remains." So the station
 * hides one empty extra container on the asteroid it mines and its Mannies mine into it.
 *
 * Cycle, all with ordinary calls:
 *   1. hide     POST .../mannies/{id}/detach-storage-container  { mode: hidden_on_asteroid, objectId: asteroid }
 *   2. fill     POST .../mannies/{id}/mine  { targetContainerId }   (automation.ts, metals/ice/carbon only:
 *               "Detached storage containers cannot receive deuterium")
 *      read     GET  /api/probe/{id}/sector-objects/{objectId}/inventory   (how full it is)
 *   3. recover  POST .../mannies/{id}/recover-storage-container { objectId }  once full and nobody is
 *               mining into it (recovery interrupts those Mannies and drops their cargo)
 *   4. empty    POST /api/probe/{id}/storage-moves  (10 s per 0.05 ECE) into the station's other storage,
 *               then hide it again.
 */
import type { Snapshot } from "./poller.js";
import type { Schemas } from "./gameClient.js";
import { isFullProbe } from "../shared/attention.js";
import { holdsAnything, isHandoffContainer, isMoving, spareRoom } from "./stationOps.js";
import { taskOf } from "./automation.js";
import type { Depot, StationConfig, StationOp, Handoff } from "../shared/stations.js";

type Probe = Schemas["Probe"];
type Manny = Schemas["Manny"];
type Obj = Schemas["SectorObject"] & Record<string, unknown>;

export const DEPOT_RESOURCES = ["metals", "ice", "carbon_compounds"] as const;
type DepotResource = (typeof DEPOT_RESOURCES)[number];
/** Smallest container worth hiding, and the free space below which a depot counts as full. */
export const DEPOT_MIN_CAPACITY = 0.1;
export const DEPOT_FULL_FREE = 0.02;
const KEEP_IDLE = 1;
/** The game applies orders asynchronously: give a state change this long to show in a poll. */
const SETTLE_MS = 2 * 60_000;
/** A recovery that hasn't landed after this long is tried again. */
const RECOVER_TIMEOUT_MS = 60 * 60_000;

/** The game's id for a detached container (SectorDetachedContainer::idFor; matches the spec's examples). */
export function hiddenIdFor(containerId: string): string {
  return "detached-container-" + containerId.toLowerCase().replace(/[^a-z0-9_]+/g, "-");
}

/** Mannies (on any probe) whose current mining task delivers into this depot. */
export function depotMiners(snapshot: Snapshot, objectId: string): Manny[] {
  const out: Manny[] = [];
  for (const v of snapshot.probes)
    for (const m of v.mannies ?? []) {
      if (m.currentTask !== "mining") continue;
      const tc = taskOf(m).targetContainer as { id?: string } | undefined;
      if (tc?.id === objectId) out.push(m);
    }
  return out;
}

/** ECE still on its way into the depot from mining tasks under way. */
export function depotPending(snapshot: Snapshot, objectId: string): number {
  return depotMiners(snapshot, objectId).reduce((s, m) => {
    const t = taskOf(m);
    return s + Math.max(0, Number(t.targetAmount ?? 0) - Number(t.depositedAmount ?? 0));
  }, 0);
}

/** Room left for new mining orders: capacity less what is inside and what is on its way. */
export function depotFree(d: Depot, snapshot: Snapshot): number {
  return Math.max(0, d.capacity - (d.contents ?? 0) - depotPending(snapshot, d.objectId));
}

/** Every asteroid in the sector: top-level objects and solar systems' minableTargets. */
function allAsteroids(sector: Schemas["SectorObservation"] | null): Obj[] {
  const out: Obj[] = [];
  for (const o of (sector?.objects ?? []) as Obj[]) {
    if (o.type === "asteroid") out.push(o);
    if (Array.isArray(o.minableTargets)) for (const t of o.minableTargets as Obj[]) if (t.type === "asteroid") out.push(t);
  }
  return out;
}

/** Asteroids in the station's sector with metals, ice or carbon, richest first. */
function asteroids(sector: Schemas["SectorObservation"] | null): Obj[] {
  const amount = (o: Obj) => {
    const a = (o.resourceAmounts ?? {}) as Partial<Record<string, number>>;
    return DEPOT_RESOURCES.reduce((s, r) => s + (a[r] ?? 0), 0);
  };
  return allAsteroids(sector)
    .filter((o) => o.type === "asteroid" && !!o.id && (o.resourceTypes as string[] | undefined)?.some((r) => (DEPOT_RESOURCES as readonly string[]).includes(r)) && amount(o) >= DEPOT_MIN_CAPACITY)
    .sort((a, b) => amount(b) - amount(a));
}

export interface DepotInput {
  snapshot: Snapshot;
  stations: StationConfig[];
  depots: Depot[];
  handoffs: Handoff[];
  busy: Set<string>;
  now: number;
  /** Containers other station ops already use this cycle (a hand-off detach). */
  reserved?: Set<string>;
}

export interface DepotPlan {
  ops: StationOp[];
  /** State changes to apply, by container (null removes the depot). */
  changes: Array<{ stationId: number; containerId: string; depot: Depot | null; log: string }>;
  notes: Record<number, string>;
}

export function planDepots({ snapshot, stations, depots, handoffs, busy, now, reserved = new Set() }: DepotInput): DepotPlan {
  const out: DepotPlan = { ops: [], changes: [], notes: {} };
  const inFlight = new Set(handoffs.filter((h) => h.state === "sent" || h.state === "recovering").map((h) => h.containerId));
  const iso = new Date(now).toISOString();

  for (const cfg of stations) {
    const ds = depots.filter((x) => x.stationId === cfg.probeId);
    if (!cfg.depot && !ds.length) continue;
    const sv = snapshot.probes.find((v) => v.summary.id === cfg.probeId);
    if (!sv || !sv.summary.isReachable || !isFullProbe(sv.detail) || !sv.mannies) continue;
    const S = sv.detail as Probe;
    const name = sv.summary.name;
    const notes: string[] = [];
    const idle = sv.mannies.filter((m) => m.location.type === "probe" && m.currentTask === null && m.canReceiveOrders && !busy.has(m.id));
    const take = () => {
      if (idle.length <= KEEP_IDLE) return null;
      const m = idle.shift()!;
      busy.add(m.id);
      return m;
    };
    const settled = (x: Depot) => now - new Date(x.updatedAt).getTime() > SETTLE_MS;
    const onboard = (id: string) => S.inventory?.containers.find((c) => c.id === id) ?? null;
    if (["dead", "disabled", "trapped_by_black_hole"].includes(S.status)) continue;

    for (const d0 of ds) {
      let d = d0;
      const note = (text: string) => notes.push(text);
      const change = (depot: Depot | null, log: string) => out.changes.push({ stationId: cfg.probeId, containerId: d0.containerId, depot, log });
      switch (d.state) {
        case "hiding": {
          const detaching = sv.mannies.find((m) => m.currentTask === "detaching_storage_container");
          const seen = detaching ? (taskOf(detaching).artificialObjectDetected as { objectId?: string } | undefined)?.objectId : undefined;
          if (seen && seen !== d.objectId) d = { ...d, objectId: seen };
          if (detaching || !settled(d)) {
            if (d !== d0) change(d, `Depot id is ${d.objectId}`);
            note(`Hiding "${d.containerId}" on ${d.asteroidName}.`);
            break;
          }
          if (onboard(d.containerId)) {
            change(null, `Depot on ${d.asteroidName} was not hidden; the container is still aboard ${name}.`);
            break;
          }
          change({ ...d, state: "active", updatedAt: iso, note: null }, `Depot hidden on ${d.asteroidName}; Mannies now mine into it.`);
          break;
        }
        case "active": {
          if (d.lost) { note(`The depot ${d.objectId} on ${d.asteroidName} can't be found (GET sector-objects inventory: 404). Nothing new is mined into it; check that asteroid in the game.`); break; }
          const miners = depotMiners(snapshot, d.objectId);
          const rockThere = !sv.sector || allAsteroids(sv.sector).some((o) => o.id === d.asteroidId);
          const full = d.contents !== null && d.capacity - d.contents < DEPOT_FULL_FREE;
          const leaving = isMoving(S) || !rockThere;
          if (!full && !leaving && cfg.depot) {
            note(`Mining into the depot on ${d.asteroidName}: ${d.contents === null ? "?" : round(d.contents)} of ${round(d.capacity)} ECE, ${miners.length} Manny${miners.length === 1 ? "" : "s"} on it.`);
            break;
          }
          if (miners.length) { note(`Depot ${full ? "is full" : "is being closed"}; waiting for ${miners.length} Manny${miners.length === 1 ? "" : "s"} to finish mining into it.`); break; }
          if (isMoving(S)) { note("The station is moving; the depot stays hidden on the asteroid until it is back."); break; }
          const m = take();
          if (!m) { note("Depot is ready to bring home; waiting for an idle Manny."); break; }
          out.ops.push({
            id: `depot_recover:${d.objectId}`, stationId: cfg.probeId,
            label: `${m.name} brings the depot on ${d.asteroidName} home`,
            why: full ? `It holds ${round(d.contents!)} of ${round(d.capacity)} ECE.` : !rockThere ? "Its asteroid is no longer in the sector scan." : "The depot was switched off.",
            endpoint: `POST /api/probe/${cfg.probeId}/mannies/${m.id}/recover-storage-container`,
            plan: { kind: "depot_recover", probeId: cfg.probeId, mannyId: m.id, objectId: d.objectId },
          });
          break;
        }
        case "recovering": {
          if (onboard(d.containerId)) {
            change({ ...d, state: "emptying", updatedAt: iso }, `Depot container is back aboard ${name}; emptying it into the station's storage.`);
            break;
          }
          if (now - new Date(d.updatedAt).getTime() > RECOVER_TIMEOUT_MS) {
            change({ ...d, state: "active", updatedAt: iso, note: "The recovery didn't land; trying again." }, "Depot recovery didn't land within an hour; trying again.");
            break;
          }
          note(`Bringing the depot home from ${d.asteroidName}.`);
          break;
        }
        case "emptying": {
          const box = onboard(d.containerId);
          if (!box) { change(null, "Depot container is no longer aboard; starting over."); break; }
          if (sv.mannies.some((m) => m.currentTask === "moving_stockage")) { note("Moving the depot's resources into the station's storage."); break; }
          const lines = (S.inventory?.resourceStocks ?? []).flatMap((s) =>
            (s.containers ?? []).filter((c) => c.container.id === d.containerId && c.amount > 0.0005).map((c) => ({ type: s.type as DepotResource, amount: c.amount })));
          if (!lines.length || !cfg.depot) {
            change(null, lines.length ? "Depot switched off; its container stays aboard as normal storage." : "Depot emptied; it will be hidden again.");
            break;
          }
          const dest = (S.inventory?.containers ?? [])
            .filter((c) => c.id !== d.containerId && !inFlight.has(c.id) && (c.kind === "probe" || !isHandoffContainer(c)) && (c.freeCapacity ?? 0) > 0.005)
            // Top up containers already in use first, keeping empty ones free for the next depot.
            .sort((a, b) => Number(holdsAnything(S, b)) - Number(holdsAnything(S, a)) || (b.freeCapacity ?? 0) - (a.freeCapacity ?? 0))[0];
          if (!dest) {
            change(null, "No room elsewhere aboard to empty the depot container; it stays aboard as normal storage and crafting will use it.");
            break;
          }
          const m = take();
          if (!m) { note("Waiting for an idle Manny to empty the depot container."); break; }
          const line = lines[0];
          const amount = Math.floor(Math.min(line.amount, (dest.freeCapacity ?? 0)) * 1000) / 1000;
          if (amount < 0.001) { change(null, "Depot container is almost empty; it stays aboard as normal storage."); break; }
          out.ops.push({
            id: `depot_empty:${d.containerId}`, stationId: cfg.probeId,
            label: `${m.name} moves ${amount} ECE ${line.type.replace("_", " ")} from the depot container to "${dest.label}"`,
            why: "The depot container is emptied so it can go back out to the asteroid.",
            endpoint: `POST /api/probe/${cfg.probeId}/storage-moves`,
            plan: { kind: "depot_empty", probeId: cfg.probeId, mannyId: m.id, fromContainerId: d.containerId, toContainerId: dest.id, resourceType: line.type, amount },
          });
          break;
        }
      }
    }

    // More depots, one per poll, up to the setting: miners spread over them, so one can fill and come home while the others take loads.
    const used = new Set(ds.map((x) => x.containerId));
    if (cfg.depot && ds.length < cfg.depotContainers) {
      if (isMoving(S)) { notes.push("The station is moving."); }
      else {
        const rock = asteroids(sv.sector)[0];
        const room = spareRoom(S, sv.mannies);
        const box = (S.inventory?.containers ?? [])
          .filter((c) => c.kind === "container" && !used.has(c.id) && !isHandoffContainer(c) && !inFlight.has(c.id) && !reserved.has(c.id) && !holdsAnything(S, c) && (c.capacity ?? 0) >= DEPOT_MIN_CAPACITY)
          .filter((c) => room - (c.capacity ?? 0) >= 0) // the Mannies outside still need room to dock
          .sort((a, b) => (b.capacity ?? 0) - (a.capacity ?? 0))[0];
        const m = rock && box ? take() : null;
        if (!rock) notes.push("No asteroid with metals, ice or carbon in this sector.");
        else if (!box) { if (!ds.length) notes.push("Waiting for an empty extra container on the station (with room left for the Mannies outside)."); }
        else if (!m) notes.push(ds.length ? `Waiting for an idle Manny to hide depot ${ds.length + 1} of ${cfg.depotContainers}.` : "Waiting for an idle Manny to hide the depot.");
        else {
          const rockName = (rock.name as string | undefined) ?? rock.id!;
          out.ops.push({
            id: `depot_hide:${cfg.probeId}:${box.id}`, stationId: cfg.probeId,
            label: `${m.name} hides "${box.label}" on ${rockName} as a mining depot`,
            why: "Mining into a container hidden on the mined asteroid drops both travel legs (spec: MannyMineRequest.targetContainerId), so each load takes about half the time.",
            endpoint: `POST /api/probe/${cfg.probeId}/mannies/${m.id}/detach-storage-container`,
            plan: { kind: "depot_hide", probeId: cfg.probeId, mannyId: m.id, containerId: box.id, asteroidId: rock.id!, asteroidName: rockName, capacity: box.capacity ?? 0 },
          });
        }
      }
    }
    if (notes.length) out.notes[cfg.probeId] = notes.join(" ");
  }
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
