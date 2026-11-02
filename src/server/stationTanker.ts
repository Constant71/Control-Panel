/**
 * Station Tanker (Merchant, 2026-11-02): a tanker whose only job is deuterium for its station.
 *
 * - Its sector has deuterium: it stays docked, its Mannies mine deuterium until the tank is full,
 *   and it gives the station everything it has (the transfer must be strictly below its own
 *   deuterium, so 1 point stays).
 * - Its sector has none: it gives the station everything above a reserve (default 20% of its tank,
 *   or the round trip to the nearest deuterium if that costs more). Once it has nothing left to
 *   give and the station isn't full, it flies to the nearest known deuterium sector on the SCUT
 *   network, mines until full, waits for every Manny, flies home, and starts giving again.
 *
 * Calls (all in the spec): POST /api/probe/{id}/mannies/{mid}/mine {objectId, resources:[deuterium],
 * targetAmount}; POST .../transfer-deuterium-to-probe {targetProbeId, amount} (5 minutes, same
 * sector, nobody moving); POST /api/probe/{id}/move {target}. 0.01 ECE of mined deuterium = 1 tank point.
 */
import type { Snapshot, ProbeView } from "./poller.js";
import type { Schemas } from "./gameClient.js";
import type { SectorKnowledge } from "./discovery.js";
import { isFullProbe } from "../shared/attention.js";
import { FALLBACK_MANNY_SPACE, mineableTargets, taskOf } from "./automation.js";
import { fccDistance } from "./exploration.js";
import { isMoving } from "./stationOps.js";
import { sectorOf } from "./stations.js";
import type { StationOp, StationsData, Trip } from "../shared/stations.js";

type Vec = { x: number; y: number; z: number };
type Probe = Schemas["Probe"];
type Manny = Schemas["Manny"];

const ACTIVE: Trip["state"][] = ["outbound", "mining", "refuelling", "returning", "handing_over"];
const KEEP_IDLE = 1;
const ORDER_ECE = 0.1;
const MIN_INTEGRITY = 40;
const FULL = 0.98;
const same = (a: Vec | null | undefined, b: Vec | null | undefined) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
const vstr = (v: Vec) => `(${v.x}, ${v.y}, ${v.z})`;
const maxFuel = (p: Probe) => p.fuel.maxDeuterium ?? (p.model === "deuterium_tanker" ? 400 : 100);
const pts = (n: number) => Math.floor(n * 100) / 100;

export interface TankerInput {
  snapshot: Snapshot;
  data: Pick<StationsData, "stations" | "members">;
  trips: Trip[];
  sectors: SectorKnowledge[];
  costPerSector: Record<string, number>;
  busy: Set<string>;
  recentRefuels: Set<string>;
  now: number;
}

export interface TankerResult {
  ops: StationOp[];
  changes: Array<{ trip: Trip; note: string; ok: boolean }>;
  notes: Record<number, string[]>;
  /** Every Station Tanker: the regular mining automation leaves it alone. */
  noMining: Set<number>;
}

/** Deuterium (tank points) that Mannies outside are still bringing in. */
function pendingDeuterium(mannies: Manny[]): number {
  let ece = 0;
  for (const m of mannies) {
    if (m.currentTask !== "mining") continue;
    const t = taskOf(m);
    const types = (t.resourceTypes as string[] | undefined) ?? [];
    if (!types.includes("deuterium")) continue;
    ece += Math.max(0, Number(t.targetAmount ?? 0) - Number(t.depositedAmount ?? 0)) / Math.max(1, types.length);
  }
  return ece * 100;
}

const deuteriumTargets = (v: ProbeView | undefined) =>
  mineableTargets(v?.sector ?? null).filter((x) => x.resourceTypes?.includes("deuterium" as never));

export function planStationTankers(input: TankerInput): TankerResult {
  const { snapshot, data, trips, sectors, costPerSector, busy, recentRefuels, now } = input;
  const res: TankerResult = { ops: [], changes: [], notes: {}, noMining: new Set() };
  const views = new Map(snapshot.probes.map((v) => [v.summary.id, v]));
  const iso = new Date(now).toISOString();
  const def = views.get(snapshot.defaultProbeId ?? -1);
  const defNets = new Set((def?.sector?.scutNetworks ?? []).map((n) => n.id));
  const set = (t: Trip, state: Trip["state"], note: string, ok = true) => {
    t.state = state;
    t.note = note;
    t.updatedAt = iso;
    res.changes.push({ trip: t, note, ok });
  };
  const idle = (v: ProbeView) => (v.mannies ?? []).filter((m) => m.location.type === "probe" && m.currentTask === null && m.canReceiveOrders && !busy.has(m.id));
  const mannySpace = (p: Probe) => Math.max(0, ...(p.inventory?.items ?? []).filter((i) => i.type === "manny").map((i) => i.containerSpace)) || FALLBACK_MANNY_SPACE;

  /** Mine deuterium into the tank with spare idle Mannies, keeping room for each to come home. */
  const mine = (v: ProbeView, P: Probe, stationId: number, pool: Manny[], why: string, tripId?: string, keepIdle = KEEP_IDLE) => {
    const mannies = v.mannies ?? [];
    const targets = deuteriumTargets(v);
    let need = maxFuel(P) - P.fuel.deuterium - pendingDeuterium(mannies);
    const space = mannySpace(P);
    let room = (P.inventory?.freeCapacity ?? 0) - mannies.filter((m) => m.location.type === "sector").length * space;
    let spare = pool.length - keepIdle;
    let i = 0;
    while (targets.length && need >= 1 && spare > 0 && room >= space) {
      const m = pool.shift()!;
      spare--;
      room -= space;
      const amount = Math.floor(Math.min(ORDER_ECE, need / 100) * 1000) / 1000;
      if (amount <= 0) break;
      need -= amount * 100;
      const target = targets[i++ % targets.length];
      busy.add(m.id);
      res.ops.push({
        id: `stanker:${P.id}:mine:${m.id}`, stationId,
        label: `${m.name} mines ${amount} ECE of deuterium from ${target.name ?? target.id}`, why,
        endpoint: `POST /api/probe/${P.id}/mannies/${m.id}/mine`,
        plan: { kind: "trip_mine", probeId: P.id, mannyId: m.id, objectId: target.id, resource: "deuterium", targetAmount: amount, tripId: tripId ?? "" },
      });
    }
  };

  for (const cfg of data.stations) {
    const notes = (res.notes[cfg.probeId] ??= []);
    const sv = views.get(cfg.probeId);
    const tankers = Object.entries(data.members)
      .filter(([, m]) => m.stationId === cfg.probeId && m.role === "StationTanker")
      .map(([id]) => Number(id));
    if (!tankers.length) continue;
    for (const id of tankers) res.noMining.add(id);
    if (!sv || !sv.summary.isReachable || !isFullProbe(sv.detail)) { notes.push("Station Tankers wait: the station is out of command range."); continue; }
    const S = sv.detail;
    const home = sectorOf(sv);
    if (!home) continue;
    const homeHas = deuteriumTargets(sv).length > 0;
    const sMax = maxFuel(S);
    let sFuel = S.fuel.deuterium;

    for (const id of tankers) {
      const tv = views.get(id);
      const name = tv?.summary.name ?? `Probe ${id}`;
      const trip = trips.find((t) => t.haulerId === id && t.kind === "deuterium" && ACTIVE.includes(t.state)) ?? null;
      if (!tv || !tv.summary.isReachable || !isFullProbe(tv.detail) || !tv.mannies) {
        if (trip && now - new Date(trip.updatedAt).getTime() > 30 * 60_000) set(trip, "failed", `${name} has been out of command range for 30 minutes.`, false);
        notes.push(`${name} (Station Tanker) is out of command range.`);
        continue;
      }
      const T = tv.detail;
      const pos = sectorOf(tv);
      const moving = isMoving(T);
      const tMax = maxFuel(T);
      if (["dead", "disabled", "trapped_by_black_hole"].includes(T.status)) { if (trip) set(trip, "failed", `${name} is ${T.status}.`, false); continue; }
      if (trip && T.movement?.status === "failed") { set(trip, "failed", `${name}'s move failed.`, false); continue; }
      const pool = idle(tv);

      // Nearest known deuterium on the network, and the reserve kept for getting there and back.
      const per = costPerSector[T.model] ?? null;
      const options = homeHas ? [] : sectors
        .filter((s) => "deuterium" in s.resources && !same(s.sector, home) && !s.hazards.length && s.scutNetworkIds.some((n) => defNets.has(n)))
        .map((s) => ({ s, d: fccDistance(home, s.sector) }))
        .sort((a, b) => a.d - b.d || (b.s.resources.deuterium ?? 0) - (a.s.resources.deuterium ?? 0));
      const best = options[0] ?? null;
      const roundTrip = best && per !== null ? 2 * best.d * per : null;
      const reserve = homeHas ? 1 : Math.max((cfg.stationTankerReservePercent / 100) * tMax, (roundTrip ?? 0) + 1);

      // ---- On a collecting trip ----
      if (trip) {
        if (trip.state === "outbound") {
          if (!moving && same(pos, trip.target)) { trip.arrivedAt = iso; set(trip, "mining", `Arrived at ${vstr(trip.target)}. Mining deuterium.`); }
          else if (!moving && same(pos, trip.home) && now - new Date(trip.startedAt).getTime() > 10 * 60_000) set(trip, "failed", `${name} never left: the move was not carried out.`, false);
          continue;
        }
        const goHome = (why: string) => res.ops.push({
          id: `stanker:${id}:home`, stationId: cfg.probeId, label: `${name} flies home to ${vstr(trip.home)}`, why,
          endpoint: `POST /api/probe/${id}/move`,
          plan: { kind: "trip_move", probeId: id, target: trip.home, tripId: trip.id, leg: "home", resource: "deuterium", reason: trip.reason },
        });
        if (trip.state === "mining") {
          const outside = tv.mannies.filter((m) => m.location.type === "sector");
          const full = T.fuel.deuterium >= FULL * tMax;
          const gone = !deuteriumTargets(tv).length;
          const timeUp = now - new Date(trip.arrivedAt ?? trip.updatedAt).getTime() > cfg.maxTripHours * 3_600_000;
          if (full || gone || timeUp) {
            const why = full ? "the tank is full" : gone ? "nothing here holds deuterium any more" : `${cfg.maxTripHours} h at the sector`;
            if (outside.length) { trip.note = `Heading home soon (${why}). Waiting for ${outside.length} ${outside.length > 1 ? "Mannies" : "Manny"} to come back aboard first.`; continue; }
            goHome(`Collecting done: ${why}. Every Manny is aboard.`);
            continue;
          }
          mine(tv, T, cfg.probeId, pool, `Collecting deuterium for ${sv.summary.name}: tank ${Math.round((T.fuel.deuterium / tMax) * 100)}%.`, trip.id);
          trip.note = `Mining deuterium: tank ${Math.round((T.fuel.deuterium / tMax) * 100)}%.`;
          continue;
        }
        if (trip.state === "returning") {
          if (!moving && same(pos, trip.home)) set(trip, "done", "Back at the station. Handing over its deuterium.");
          else if (!moving && now - new Date(trip.updatedAt).getTime() > 10 * 60_000) goHome("The move home hasn't started yet, so it is sent again.");
          continue;
        }
        continue;
      }

      // ---- Away without a trip (moved by hand, or a trip failed): come home once everyone is aboard ----
      if (!same(pos, home)) {
        if (moving) continue;
        const out = tv.mannies.filter((m) => m.location.type === "sector" || m.currentTask !== null);
        if (out.length) { notes.push(`${name} is away from the station; it flies home once its Mannies are aboard.`); continue; }
        res.ops.push({
          id: `stanker:${id}:return`, stationId: cfg.probeId, label: `${name} flies home to ${vstr(home)}`,
          why: "It is this station's Station Tanker and is away with nothing to do.", endpoint: `POST /api/probe/${id}/move`,
          plan: { kind: "trip_move", probeId: id, target: home, tripId: `${id}@${now}`, leg: "home", resource: "", reason: "return to the station", ret: true },
        });
        continue;
      }
      if (moving) continue;

      // ---- Docked: give the station what it can ----
      const give = pts(Math.min(sMax - sFuel, T.fuel.deuterium - reserve));
      let gave = false;
      if (sFuel < FULL * sMax && give >= 1 && give < T.fuel.deuterium && !recentRefuels.has(`${id}:${cfg.probeId}`) && pool.length) {
        gave = true;
        const m = pool.shift()!;
        busy.add(m.id);
        sFuel += give;
        res.ops.push({
          id: `refuel:${id}:${cfg.probeId}`, stationId: cfg.probeId,
          label: `${m.name} moves ${give} deuterium from ${name} to ${sv.summary.name}`,
          why: homeHas
            ? `${sv.summary.name} is at ${Math.round((S.fuel.deuterium / sMax) * 100)}%. A Station Tanker with deuterium at home gives it everything it has.`
            : `${sv.summary.name} is at ${Math.round((S.fuel.deuterium / sMax) * 100)}%. ${name} keeps ${Math.ceil(reserve)} for its next collecting trip.`,
          endpoint: `POST /api/probe/${id}/mannies/${m.id}/transfer-deuterium-to-probe`,
          plan: { kind: "refuel", probeId: id, mannyId: m.id, targetProbeId: cfg.probeId, amount: give },
        });
      }
      const giving = recentRefuels.has(`${id}:${cfg.probeId}`);

      // ---- Deuterium at home: mine it, never leave ----
      if (homeHas) {
        // The Manny handing over fuel already counts as the one kept back.
        mine(tv, T, cfg.probeId, pool, `Station Tanker: deuterium for ${sv.summary.name}. Tank ${Math.round((T.fuel.deuterium / tMax) * 100)}%.`, undefined, gave ? 0 : KEEP_IDLE);
        continue;
      }

      // ---- No deuterium at home: collect once there is nothing left to give ----
      const left = T.fuel.deuterium - reserve;
      if (left >= 1 || sFuel >= FULL * sMax) continue; // still giving, or the station is full
      if (giving) { notes.push(`${name} is handing over deuterium (5 minutes).`); continue; }
      if (!best) { notes.push(`${name} has no deuterium to give and no known deuterium sector on the SCUT network. Visited sectors are scanned automatically; a Scout can find more.`); continue; }
      if (!defNets.size) { notes.push(`${name} waits: the default probe isn't on a SCUT network, so it couldn't be ordered back.`); continue; }
      if ((T.systems?.integrityPercent ?? 0) < MIN_INTEGRITY) { notes.push(`${name} is at ${Math.round(T.systems?.integrityPercent ?? 0)}% integrity; repairs come before a trip.`); continue; }
      if (roundTrip !== null && T.fuel.deuterium <= roundTrip) { notes.push(`${name} has ${Math.round(T.fuel.deuterium)} fuel; the trip to ${vstr(best.s.sector)} and back costs about ${roundTrip}.`); continue; }
      const out = tv.mannies.filter((m) => m.location.type === "sector" || m.currentTask !== null);
      if (out.length) { notes.push(`${name} leaves to collect deuterium once its ${out.length} busy ${out.length > 1 ? "Mannies are" : "Manny is"} aboard.`); continue; }
      const reason = `${sv.summary.name} at ${Math.round((sFuel / sMax) * 100)}% fuel`;
      res.ops.push({
        id: `stanker:${id}:out`, stationId: cfg.probeId, label: `${name} flies to ${vstr(best.s.sector)} to collect deuterium`,
        why: `No deuterium in the station's sector and ${name} has given all but its ${Math.ceil(reserve)} reserve. Nearest known deuterium on the network, ${best.d} sector${best.d > 1 ? "s" : ""} away${roundTrip !== null ? `, about ${roundTrip} fuel there and back` : ""}.`,
        endpoint: `POST /api/probe/${id}/move`,
        plan: { kind: "trip_move", probeId: id, target: best.s.sector, tripId: `${id}@${now}`, leg: "out", resource: "deuterium", reason, tripKind: "deuterium" },
      });
    }
  }
  return res;
}
