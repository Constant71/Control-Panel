/**
 * Stations step 5c: the dispatch loop and hauler trips.
 *
 * When a station is short of a raw resource, an idle docked Hauler flies to a known sector
 * that holds it, mines until its hand-off containers are full (or time runs out), waits for
 * every Manny to be aboard, flies home, and docked service hands the containers over.
 *
 * Calls: POST /api/probe/{id}/move {target}; POST /api/probe/{id}/mannies/{mid}/mine
 * {objectId, resources, targetAmount}. Trips only go to sectors covered by a SCUT network the
 * default probe is on, so the Hauler stays in command range (Merchant: in-range moves run on
 * their own). Sector knowledge comes from the visited-sector scans (GET /api/sector).
 */
import type { Snapshot, ProbeView } from "./poller.js";
import type { Schemas } from "./gameClient.js";
import type { SectorKnowledge } from "./discovery.js";
import { isFullProbe } from "../shared/attention.js";
import { FALLBACK_MANNY_SPACE, mineableTargets, pendingCargo } from "./automation.js";
import { fccDistance } from "./exploration.js";
import { isHandoffContainer, isMoving } from "./stationOps.js";
import { sectorOf } from "./stations.js";
import type { Handoff, StationOp, StationsData, StationStatus, Trip } from "../shared/stations.js";

type Vec = { x: number; y: number; z: number };
type Probe = Schemas["Probe"];

const RAW = ["metals", "ice", "carbon_compounds"];
const KEEP_IDLE = 1;
/** One Manny trip; the automation uses the same default order size. */
const ORDER_ECE = 0.1;
const MIN_INTEGRITY = 40;
const UNKNOWN_COST_MIN_FUEL = 80;
const same = (a: Vec | null | undefined, b: Vec | null | undefined) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
const vstr = (v: Vec) => `(${v.x}, ${v.y}, ${v.z})`;
const maxFuel = (p: Probe) => p.fuel.maxDeuterium ?? (p.model === "deuterium_tanker" ? 400 : 100);
export const ACTIVE: Trip["state"][] = ["outbound", "mining", "refuelling", "returning", "handing_over"];

/** Deuterium a probe lacks to fly from `from` to `to` (0 when it has enough), keeping a 10% cushion. */
export function fuelShortfall(p: Probe, from: Vec, to: Vec, costPerSector: Record<string, number>): number {
  const max = maxFuel(p);
  const per = costPerSector[p.model] ?? null;
  if (per === null) return p.fuel.deuterium < 0.1 * max ? Math.ceil(0.3 * max - p.fuel.deuterium) : 0;
  const need = fccDistance(from, to) * per;
  return p.fuel.deuterium <= need + 1 ? Math.ceil(need + 0.1 * max - p.fuel.deuterium) : 0;
}

export interface DispatchInput {
  snapshot: Snapshot;
  data: Pick<StationsData, "stations" | "members">;
  status: StationStatus[];
  trips: Trip[];
  handoffs: Handoff[];
  sectors: SectorKnowledge[];
  costPerSector: Record<string, number>;
  busy: Set<string>;
  /** Deuterium transfers in progress, "<source>:<target>": a Hauler being fuelled doesn't leave. */
  recentRefuels?: Set<string>;
  now: number;
}

export interface DispatchResult {
  ops: StationOp[];
  changes: Array<{ trip: Trip; note: string; ok: boolean }>;
  notes: Record<number, string[]>;
  /** Haulers whose Mannies the trip directs: the regular automation leaves their mining alone. */
  noMining: Set<number>;
}

export function handoffSpace(p: Probe): { cap: number; used: number; free: number; count: number } {
  const hs = (p.inventory?.containers ?? []).filter(isHandoffContainer);
  const cap = hs.reduce((s, c) => s + (c.capacity ?? 0), 0);
  const used = hs.reduce((s, c) => s + (c.usedCapacity ?? 0), 0);
  return { cap, used, free: cap - used, count: hs.length };
}

export function homeRoom(p: Probe, mannies: Schemas["Manny"][]): number {
  const inv = p.inventory;
  if (!inv) return 0;
  const space = Math.max(0, ...inv.items.filter((i) => i.type === "manny").map((i) => i.containerSpace)) || FALLBACK_MANNY_SPACE;
  const outside = mannies.filter((m) => m.location.type === "sector").length;
  // Hand-off free space is cargo space, not room for Mannies.
  return inv.freeCapacity - handoffSpace(p).free - outside * space;
}

export function planDispatch(input: DispatchInput): DispatchResult {
  const { snapshot, data, status, trips, handoffs, sectors, costPerSector, busy, now, recentRefuels = new Set() } = input;
  const res: DispatchResult = { ops: [], changes: [], notes: {}, noMining: new Set() };
  const views = new Map(snapshot.probes.map((v) => [v.summary.id, v]));
  const iso = new Date(now).toISOString();
  const cfgOf = new Map(data.stations.map((s) => [s.probeId, s]));
  const def = views.get(snapshot.defaultProbeId ?? -1);
  const defNets = new Set((def?.sector?.scutNetworks ?? []).map((n) => n.id));

  const set = (t: Trip, state: Trip["state"], note: string, ok = true) => {
    t.state = state;
    t.note = note;
    t.updatedAt = iso;
    res.changes.push({ trip: t, note, ok });
  };
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

  // 1. Move every active trip forward.
  for (const t of trips) {
    if (!ACTIVE.includes(t.state) || t.kind === "deuterium") continue; // Station Tanker trips: stationTanker.ts
    const cfg = cfgOf.get(t.stationId);
    const hv = views.get(t.haulerId);
    const name = hv?.summary.name ?? `Probe ${t.haulerId}`;
    if (!cfg) { set(t, "failed", "The station was removed.", false); continue; }
    if (!hv) { set(t, "failed", `${name} is no longer in your fleet.`, false); continue; }
    const mem = data.members[String(t.haulerId)];
    if (!mem || mem.stationId !== t.stationId || !mem.role) { set(t, "done", `${name} left the group or lost its role, so the trip was dropped.`); continue; }
    if (t.state !== "handing_over") res.noMining.add(t.haulerId);
    if (!hv.summary.isReachable || !isFullProbe(hv.detail)) {
      if (now - new Date(t.updatedAt).getTime() > 30 * 60_000) set(t, "failed", `${name} has been out of command range for 30 minutes. It can't be ordered home until coverage returns.`, false);
      else t.note = `${name} is out of command range right now.`;
      continue;
    }
    const H = hv.detail;
    const pos = sectorOf(hv);
    const moving = isMoving(H);
    if (["dead", "disabled", "trapped_by_black_hole"].includes(H.status)) { set(t, "failed", `${name} is ${H.status}.`, false); continue; }
    if (H.movement?.status === "failed") { set(t, "failed", `${name}'s move failed.`, false); continue; }
    const op = (o: Omit<StationOp, "stationId">) => res.ops.push({ ...o, stationId: t.stationId });
    const goHome = (why: string) => {
      const short = pos ? fuelShortfall(H, pos, t.home, costPerSector) : 0;
      if (short > 0) {
        if (!t.needsFuel) res.changes.push({ trip: t, note: `${name} lacks about ${short} deuterium to fly home.`, ok: false });
        t.needsFuel = true;
        t.note = `${name} doesn't have the fuel to fly home (short about ${short}). A Tanker is sent if one is free.`;
        return;
      }
      t.needsFuel = false;
      op({
        id: `trip:${t.id}:home`, label: `${name} flies home to ${vstr(t.home)}`, why,
        endpoint: `POST /api/probe/${t.haulerId}/move`,
        plan: { kind: "trip_move", probeId: t.haulerId, target: t.home, tripId: t.id, leg: "home", resource: t.resource, reason: t.reason },
      });
    };

    if (t.state === "outbound" && t.kind === "rescue") {
      if (!moving && same(pos, t.target)) { t.arrivedAt = iso; set(t, "refuelling", `Arrived at ${vstr(t.target)} to refuel the stranded Hauler.`); }
      else if (!moving && same(pos, t.home) && now - new Date(t.startedAt).getTime() > 10 * 60_000) set(t, "failed", `${name} never left: the move was not carried out.`, false);
      continue;
    }

    if (t.state === "refuelling" && t.rescue) {
      const target = views.get(t.rescue.haulerId);
      const here = !!target && isFullProbe(target.detail) && same(sectorOf(target), pos) && !isMoving(target.detail);
      if (t.rescue.sentAt) {
        if (now - new Date(t.rescue.sentAt).getTime() > 6 * 60_000 || !here) goHome("Fuel delivered (the transfer takes 5 minutes).");
        continue;
      }
      if (!here) { goHome("The Hauler is no longer here."); continue; }
      const m = idlePool(hv)();
      if (!m) { t.note = "Waiting for an idle Manny to run the fuel transfer."; continue; }
      const amount = Math.min(t.rescue.amount, Math.floor((H.fuel.deuterium - 1) * 100) / 100);
      if (amount < 1) { goHome("Not enough fuel left to give."); continue; }
      op({
        id: `trip:${t.id}:refuel`, label: `${m.name} moves ${amount} deuterium from ${name} to ${target!.summary.name}`,
        why: `${target!.summary.name} is stranded without the fuel to fly home.`,
        endpoint: `POST /api/probe/${t.haulerId}/mannies/${m.id}/transfer-deuterium-to-probe`,
        plan: { kind: "refuel", probeId: t.haulerId, mannyId: m.id, targetProbeId: t.rescue.haulerId, amount, tripId: t.id },
      });
      continue;
    }

    if (t.state === "outbound") {
      if (!moving && same(pos, t.target)) { t.arrivedAt = iso; set(t, "mining", `Arrived at ${vstr(t.target)}. Mining ${t.resource.replace("_", " ")}.`); }
      else if (!moving && same(pos, t.home) && now - new Date(t.startedAt).getTime() > 10 * 60_000) set(t, "failed", `${name} never left: the move was not carried out.`, false);
      continue;
    }

    if (t.state === "mining") {
      const hs = handoffSpace(H);
      const mannies = hv.mannies ?? [];
      const outside = mannies.filter((m) => m.location.type === "sector");
      const pending = outside.reduce((s, m) => s + pendingCargo(m), 0);
      const fill = hs.cap > 0 ? ((hs.used + pending) / hs.cap) * 100 : 100;
      const targets = mineableTargets(hv.sector).filter((x) => x.resourceTypes?.includes(t.resource as never));
      const timeUp = now - new Date(t.arrivedAt ?? t.updatedAt).getTime() > cfg.maxTripHours * 3_600_000;
      const done = fill >= cfg.handoffMinFillPercent || hs.free - pending < 0.01 || !targets.length || timeUp;
      if (done) {
        const why = fill >= cfg.handoffMinFillPercent || hs.free - pending < 0.01 ? `hand-off containers are ${Math.round(fill)}% full`
          : !targets.length ? `nothing here holds ${t.resource.replace("_", " ")} any more` : `${cfg.maxTripHours} h at the mining sector`;
        if (outside.length) { t.note = `Heading home soon (${why}). Waiting for ${outside.length} ${outside.length > 1 ? "Mannies" : "Manny"} to come back aboard first.`; continue; }
        goHome(`Trip done: ${why}. Every Manny is aboard.`);
        continue;
      }
      // Keep Mannies mining the trip's resource, only with room for each to come home and its cargo to fit.
      let room = homeRoom(H, mannies);
      let cargoRoom = hs.free - pending;
      const space = Math.max(0, ...(H.inventory?.items ?? []).filter((i) => i.type === "manny").map((i) => i.containerSpace)) || FALLBACK_MANNY_SPACE;
      const take = idlePool(hv);
      let i = 0;
      while (cargoRoom >= 0.01 && room >= space) {
        const m = take();
        if (!m) break;
        const target = targets[i++ % targets.length];
        const amount = Math.floor(Math.min(ORDER_ECE, cargoRoom) * 1000) / 1000;
        if (amount <= 0) break;
        cargoRoom -= amount;
        room -= space;
        op({
          id: `trip:${t.id}:mine:${m.id}`, label: `${m.name} mines ${amount} ECE of ${t.resource.replace("_", " ")} from ${target.name ?? target.id}`,
          why: `Trip for ${t.reason}. Hand-off containers ${Math.round(fill)}% full.`,
          endpoint: `POST /api/probe/${t.haulerId}/mannies/${m.id}/mine`,
          plan: { kind: "trip_mine", probeId: t.haulerId, mannyId: m.id, objectId: target.id, resource: t.resource, targetAmount: amount, tripId: t.id },
        });
      }
      t.note = `Mining ${t.resource.replace("_", " ")}: hand-off containers ${Math.round(fill)}% full.`;
      continue;
    }

    if (t.state === "returning") {
      if (!moving && same(pos, t.home)) {
        if (t.kind === "rescue" || !t.resource) set(t, "done", "Back at the station.");
        else set(t, "handing_over", "Back at the station. Handing over full containers.");
      }
      else if (!moving && now - new Date(t.updatedAt).getTime() > 10 * 60_000) goHome("The move home hasn't started yet, so it is sent again.");
      continue;
    }

    if (t.state === "handing_over") {
      const busyHandoff = handoffs.some((h) => (h.fromProbeId === t.haulerId || h.toProbeId === t.haulerId) && (h.state === "sent" || h.state === "recovering"));
      const full = (H.inventory?.containers ?? []).some((c) => isHandoffContainer(c) && c.capacity && ((c.usedCapacity ?? 0) / c.capacity) * 100 >= cfg.handoffMinFillPercent);
      if (!busyHandoff && !full) set(t, "done", "Containers handed over.");
      else if (now - new Date(t.updatedAt).getTime() > 2 * 3_600_000) set(t, "done", "Hand-over is taking more than 2 hours; check the station log.", false);
    }
  }

  // 2. Start new trips.
  for (const cfg of data.stations) {
    const notes: string[] = (res.notes[cfg.probeId] = []);
    if (!cfg.dispatch) { notes.push("Dispatch is off."); continue; }
    const sv = views.get(cfg.probeId);
    const st = status.find((s) => s.probeId === cfg.probeId);
    if (!sv || !sv.summary.isReachable || !isFullProbe(sv.detail) || !st) { notes.push("The station is out of command range."); continue; }
    if (isMoving(sv.detail)) { notes.push("The station is moving."); continue; }
    const home = sectorOf(sv)!;
    const short = st.targets
      .filter((x) => x.key.startsWith("resource:") && RAW.includes(x.key.slice(9)) && x.short > 0)
      .sort((a, b) => b.short / Math.max(b.min, 1e-9) - a.short / Math.max(a.min, 1e-9));
    if (!short.length) { notes.push("Stock meets every raw resource target, so no trip is needed."); continue; }
    if (!defNets.size) {
      notes.push("The default probe isn't on a SCUT network, so a Hauler that leaves this sector couldn't be ordered back. Trips start once a network covers it (a Scout can build one).");
      continue;
    }

    const haulers = Object.entries(data.members)
      .filter(([, m]) => m.stationId === cfg.probeId && m.role === "Hauler")
      .map(([id]) => views.get(Number(id)))
      .filter((v): v is ProbeView => !!v);
    if (!haulers.length) { notes.push("No Hauler in this group yet."); continue; }
    const onTrip = new Set(trips.filter((t) => ACTIVE.includes(t.state)).map((t) => t.haulerId));

    let sent = false;
    for (const hv of haulers) {
      const name = hv.summary.name;
      if (onTrip.has(hv.summary.id)) continue;
      if (!hv.summary.isReachable || !isFullProbe(hv.detail) || !hv.mannies) { notes.push(`${name} is out of command range.`); continue; }
      const H = hv.detail;
      if (isMoving(H) || !same(sectorOf(hv), home)) { notes.push(`${name} isn't docked at the station.`); continue; }
      if (["dead", "disabled", "trapped_by_black_hole"].includes(H.status)) continue;
      if ((H.systems?.integrityPercent ?? 0) < MIN_INTEGRITY) { notes.push(`${name} is at ${Math.round(H.systems?.integrityPercent ?? 0)}% integrity; repairs come before a trip (floor ${MIN_INTEGRITY}%).`); continue; }
      const hs = handoffSpace(H);
      if (!hs.count) { notes.push(`${name} has no hand-off containers yet; docked service gives it empties.`); continue; }
      if (hs.free < Math.max(0.05, hs.cap * 0.5)) { notes.push(`${name}'s hand-off containers are still ${Math.round((hs.used / hs.cap) * 100)}% full; they go to the station first.`); continue; }
      if (handoffs.some((h) => (h.fromProbeId === H.id || h.toProbeId === H.id) && (h.state === "sent" || h.state === "recovering"))) { notes.push(`${name} has a hand-off in progress.`); continue; }
      if ([...recentRefuels].some((k) => k.endsWith(`:${H.id}`))) { notes.push(`${name} is being refuelled (5 minutes).`); continue; }

      for (const need of short) {
        const resource = need.key.slice(9);
        const label = resource.replace("_", " ");
        const options = sectors
          .filter((s) => resource in s.resources && !same(s.sector, home) && !s.hazards.length)
          .filter((s) => s.scutNetworkIds.some((id) => defNets.has(id)))
          .map((s) => ({ s, d: fccDistance(home, s.sector) }))
          .sort((a, b) => a.d - b.d || (b.s.resources[resource] ?? 0) - (a.s.resources[resource] ?? 0));
        if (!options.length) {
          notes.push(`No known sector with ${label} inside the SCUT network. Visited sectors are scanned automatically; a Scout can find more.`);
          continue;
        }
        const { s: best, d } = options[0];
        const max = maxFuel(H);
        const per = costPerSector[H.model] ?? null;
        const roundTrip = per === null ? null : 2 * d * per;
        const floor = (cfg.tripFuelMarginPercent / 100) * max;
        if (roundTrip === null ? (H.fuel.deuterium / max) * 100 < UNKNOWN_COST_MIN_FUEL : H.fuel.deuterium - roundTrip < floor) {
          notes.push(roundTrip === null
            ? `${name} has ${Math.round(H.fuel.deuterium)}/${max} fuel. The move cost isn't known yet, so a trip waits for ${UNKNOWN_COST_MIN_FUEL}%; docked service tops it up.`
            : `${name} has ${Math.round(H.fuel.deuterium)}/${max} fuel; the round trip costs about ${roundTrip} and must leave ${cfg.tripFuelMarginPercent}%. Docked service tops it up.`);
          break;
        }
        const outside = hv.mannies.filter((m) => m.location.type === "sector" || m.currentTask !== null);
        res.noMining.add(H.id);
        if (outside.length) { notes.push(`${name} leaves for ${label} at ${vstr(best.sector)} once its ${outside.length} busy ${outside.length > 1 ? "Mannies are" : "Manny is"} done and aboard.`); sent = true; break; }
        const reason = `${label} ${+((need.have ?? 0).toFixed(3))} / ${need.min} ECE`;
        res.ops.push({
          id: `trip:new:${H.id}:${resource}`, stationId: cfg.probeId,
          label: `${name} flies to ${vstr(best.sector)} for ${label}`,
          why: `${st.name} is short: ${reason}. Nearest known ${label} on the SCUT network, ${d} sector${d > 1 ? "s" : ""} away${roundTrip !== null ? `, about ${roundTrip} fuel there and back` : ""}.`,
          endpoint: `POST /api/probe/${H.id}/move`,
          plan: { kind: "trip_move", probeId: H.id, target: best.sector, tripId: `${H.id}@${now}`, leg: "out", resource, reason },
        });
        sent = true;
        break;
      }
      if (sent) break; // one new trip per station per cycle
    }
    if (sent) notes.unshift("Sending a Hauler.");
  }

  // 3. Rescues and stragglers, for every station (whatever its stock).
  for (const cfg of data.stations) {
    const notes = (res.notes[cfg.probeId] ??= []);
    const sv = views.get(cfg.probeId);
    if (!sv || !sv.summary.isReachable || !isFullProbe(sv.detail) || isMoving(sv.detail)) continue;
    const home = sectorOf(sv)!;
    const busyIds = new Set(trips.filter((t) => ACTIVE.includes(t.state)).map((t) => t.haulerId));
    for (const o of res.ops) if (o.plan.kind === "trip_move") busyIds.add(o.plan.probeId);
    const members = Object.entries(data.members).filter(([, m]) => m.stationId === cfg.probeId && m.role).map(([id, m]) => ({ id: Number(id), role: m.role!, v: views.get(Number(id)) }));

    // A stranded Hauler gets a Tanker.
    for (const t of trips.filter((x) => x.stationId === cfg.probeId && x.needsFuel && ACTIVE.includes(x.state))) {
      if (trips.some((r) => r.kind === "rescue" && r.rescue?.haulerId === t.haulerId && ACTIVE.includes(r.state))) continue;
      const hv = views.get(t.haulerId);
      const where = hv ? sectorOf(hv) : null;
      if (!hv || !isFullProbe(hv.detail) || !where) continue;
      const short = fuelShortfall(hv.detail, where, t.home, costPerSector) || Math.ceil(0.3 * maxFuel(hv.detail));
      const tanker = members.find((m) => m.role === "Tanker" && m.v && !busyIds.has(m.id) && m.v.summary.isReachable && isFullProbe(m.v.detail)
        && !isMoving(m.v.detail) && same(sectorOf(m.v), home) && (m.v.mannies ?? []).every((x) => x.location.type === "probe"));
      if (!tanker) { notes.push(`${hv.summary.name} is stranded at ${vstr(where)} without fuel to fly home, and no Tanker is docked and free. A Tanker in this group would be sent automatically.`); continue; }
      const T = tanker.v!.detail as Probe;
      const per = costPerSector[T.model] ?? null;
      if (per === null) { notes.push(`${hv.summary.name} is stranded, but the Tanker's move cost isn't known yet, so the panel won't risk the trip. Send fuel from the Console.`); continue; }
      const d = fccDistance(home, where);
      const left = T.fuel.deuterium - 2 * d * per - short;
      if (left < (cfg.tankerReservePercent / 100) * maxFuel(T)) { notes.push(`${tanker.v!.summary.name} can't rescue ${hv.summary.name}: the trip and ${short} deuterium would take it below its ${cfg.tankerReservePercent}% reserve.`); continue; }
      busyIds.add(tanker.id);
      res.noMining.add(tanker.id);
      res.ops.push({
        id: `trip:rescue:${t.haulerId}`, stationId: cfg.probeId, label: `${tanker.v!.summary.name} flies to ${vstr(where)} to refuel ${hv.summary.name}`,
        why: `${hv.summary.name} lacks about ${short} deuterium to fly home. ${d} sector${d > 1 ? "s" : ""}, about ${2 * d * per} fuel there and back.`,
        endpoint: `POST /api/probe/${tanker.id}/move`,
        plan: { kind: "trip_move", probeId: tanker.id, target: where, tripId: `${tanker.id}@${now}`, leg: "out", resource: "deuterium", reason: `rescue ${hv.summary.name}`, rescue: { haulerId: t.haulerId, amount: short } },
      });
    }

    // A group Hauler or Tanker left away from the station with nothing to do comes home.
    for (const m of members) {
      if (m.role === "Scout" || m.role === "StationTanker" || busyIds.has(m.id) || !m.v || !m.v.summary.isReachable || !isFullProbe(m.v.detail)) continue;
      const P = m.v.detail;
      const where = sectorOf(m.v);
      if (!where || same(where, home) || isMoving(P) || ["dead", "disabled", "trapped_by_black_hole"].includes(P.status)) continue;
      const out = (m.v.mannies ?? []).filter((x) => x.location.type === "sector" || x.currentTask !== null);
      res.noMining.add(m.id);
      if (out.length) { notes.push(`${m.v.summary.name} is away from the station with nothing to do; it flies home once its ${out.length} busy ${out.length > 1 ? "Mannies are" : "Manny is"} aboard.`); continue; }
      if (fuelShortfall(P, where, home, costPerSector) > 0) { notes.push(`${m.v.summary.name} is away from the station without the fuel to fly home.`); continue; }
      res.ops.push({
        id: `trip:return:${m.id}`, stationId: cfg.probeId, label: `${m.v.summary.name} flies home to ${vstr(home)}`,
        why: `It is a ${m.role} of this station, idle at ${vstr(where)}.`, endpoint: `POST /api/probe/${m.id}/move`,
        plan: { kind: "trip_move", probeId: m.id, target: home, tripId: `${m.id}@${now}`, leg: "home", resource: "", reason: "return to the station", ret: true },
      });
    }
  }
  return res;
}
