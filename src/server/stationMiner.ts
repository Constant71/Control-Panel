/**
 * Station Miner (Merchant, 2026-11-02): a group probe that stays in the station's sector and mines
 * what the station is short of. Its containers are hand-off containers (docked service sets the
 * rules and hands them over once full, like a Hauler's); it never flies out on trips.
 *
 * Call: POST /api/probe/{id}/mannies/{mid}/mine {objectId, resources, targetAmount}. Room checks:
 * each Manny must fit back aboard, and the order must fit in the hand-off containers.
 */
import type { Snapshot } from "./poller.js";
import type { Schemas } from "./gameClient.js";
import { isFullProbe } from "../shared/attention.js";
import { FALLBACK_MANNY_SPACE, mineableTargets, pendingCargo } from "./automation.js";
import { handoffSpace, homeRoom } from "./dispatch.js";
import { isMoving } from "./stationOps.js";
import { sectorOf } from "./stations.js";
import type { StationOp, StationsData, StationStatus } from "../shared/stations.js";

const RAW = ["metals", "ice", "carbon_compounds"];
const KEEP_IDLE = 1;
const ORDER_ECE = 0.1;
type Vec = { x: number; y: number; z: number };
const same = (a: Vec | null, b: Vec | null) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;

export interface MinerInput {
  snapshot: Snapshot;
  data: Pick<StationsData, "stations" | "members">;
  status: StationStatus[];
  busy: Set<string>;
}

export function planStationMiners(input: MinerInput): { ops: StationOp[]; notes: Record<number, string[]>; noMining: Set<number> } {
  const { snapshot, data, status, busy } = input;
  const res = { ops: [] as StationOp[], notes: {} as Record<number, string[]>, noMining: new Set<number>() };
  const views = new Map(snapshot.probes.map((v) => [v.summary.id, v]));
  for (const cfg of data.stations) {
    const miners = Object.entries(data.members).filter(([, m]) => m.stationId === cfg.probeId && m.role === "Miner").map(([id]) => Number(id));
    if (!miners.length) continue;
    const notes = (res.notes[cfg.probeId] ??= []);
    const sv = views.get(cfg.probeId);
    const st = status.find((s) => s.probeId === cfg.probeId);
    const home = sectorOf(sv);
    // What the station is short of, most short first (by share of the target).
    const short = (st?.targets ?? [])
      .filter((x) => x.key.startsWith("resource:") && RAW.includes(x.key.slice(9)) && x.short > 0)
      .sort((a, b) => b.short / Math.max(b.min, 1e-9) - a.short / Math.max(a.min, 1e-9))
      .map((x) => x.key.slice(9));
    for (const id of miners) {
      const v = views.get(id);
      const name = v?.summary.name ?? `Probe ${id}`;
      if (!v || !v.summary.isReachable || !isFullProbe(v.detail) || !v.mannies) { notes.push(`${name} (Miner) is out of command range.`); continue; }
      const P = v.detail as Schemas["Probe"];
      if (isMoving(P) || !same(sectorOf(v), home)) continue; // away: sent home like other group probes
      res.noMining.add(id); // the station decides what it mines
      if (!short.length) { notes.push(`${name} (Miner) waits: the station meets every raw resource target.`); continue; }
      const targets = mineableTargets(v.sector);
      const wanted = short.filter((r) => targets.some((t) => t.resourceTypes?.includes(r as never)));
      if (!wanted.length) { notes.push(`${name} (Miner): nothing in this sector holds ${short.map((r) => r.replace("_", " ")).join(", ")}. A Hauler trip fetches it.`); continue; }
      const hs = handoffSpace(P);
      if (!hs.count) { notes.push(`${name} (Miner) has no hand-off containers yet; docked service gives it empties.`); continue; }
      const mannies = v.mannies;
      let cargoRoom = hs.free - mannies.filter((m) => m.location.type === "sector").reduce((s, m) => s + pendingCargo(m), 0);
      let room = homeRoom(P, mannies);
      const space = Math.max(0, ...(P.inventory?.items ?? []).filter((i) => i.type === "manny").map((i) => i.containerSpace)) || FALLBACK_MANNY_SPACE;
      const idle = mannies.filter((m) => m.location.type === "probe" && m.currentTask === null && m.canReceiveOrders && !busy.has(m.id));
      let spare = idle.length - KEEP_IDLE;
      let i = 0;
      while (spare > 0 && cargoRoom >= 0.01 && room >= space) {
        const resource = wanted[i % wanted.length];
        const pool = targets.filter((t) => t.resourceTypes?.includes(resource as never));
        const target = pool[Math.floor(i / wanted.length) % pool.length];
        const m = idle.shift()!;
        spare--;
        i++;
        const amount = Math.floor(Math.min(ORDER_ECE, cargoRoom) * 1000) / 1000;
        cargoRoom -= amount;
        room -= space;
        busy.add(m.id);
        res.ops.push({
          id: `miner:${id}:mine:${m.id}`, stationId: cfg.probeId,
          label: `${m.name} mines ${amount} ECE of ${resource.replace("_", " ")} from ${target.name ?? target.id}`,
          why: `${name} is this station's Miner and the station is short of ${resource.replace("_", " ")}.`,
          endpoint: `POST /api/probe/${id}/mannies/${m.id}/mine`,
          plan: { kind: "trip_mine", probeId: id, mannyId: m.id, objectId: target.id, resource, targetAmount: amount, tripId: "" },
        });
      }
      if (cargoRoom < 0.01) notes.push(`${name} (Miner): hand-off containers are full; they go to the station next.`);
    }
  }
  return res;
}
