/**
 * Stations step 5e: flee cards. A station never moves on its own; when danger shows up the
 * panel posts a card and waits for Merchant. Triggers (spec):
 *  - an unresolved alert with phase `weapon_targeted` on the station (GET /api/probe/{id}/alerts)
 *  - integrity below the station's flee floor, or unresolved damage warnings (GET .../damage-warnings)
 *  - a missile in the sector with targetsCurrentProbe (SectorObservation)
 * After confirmation: Mannies outside in the station's own sector are recalled (POST .../recall;
 * a remote recall would leave them "forgotten", so those are left and named in the risks),
 * then POST /api/probe/{id}/move once every local Manny is aboard.
 */
import type { Snapshot, ProbeView } from "./poller.js";
import type { SectorKnowledge } from "./discovery.js";
import { isFullProbe } from "../shared/attention.js";
import { fccNeighbors, vkey } from "./exploration.js";
import { sectorOf } from "./stations.js";
import type { FleeCard, FleeOption, StationConfig } from "../shared/stations.js";

type Vec = { x: number; y: number; z: number };
const same = (a: Vec | null | undefined, b: Vec | null | undefined) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
const DAY = 86_400_000;

export interface FleeApproval {
  target: Vec;
  at: string;
  state: "recalling" | "moving";
}

export function dangerReasons(v: ProbeView, cfg: StationConfig, now: number): string[] {
  const out: string[] = [];
  if (!isFullProbe(v.detail)) return out;
  const p = v.detail;
  for (const a of v.alerts ?? [])
    if (a.phase === "weapon_targeted" && !a.resolvedAt && now - new Date(a.createdAt).getTime() < DAY) out.push(`Targeted by a weapon: ${a.message}`);
  for (const o of (v.sector?.objects ?? []) as Array<Record<string, unknown>>)
    if (o.type === "missile" && o.targetsCurrentProbe === true) out.push(`A missile in this sector is targeting ${p.name}.`);
  const integrity = p.systems?.integrityPercent ?? 100;
  if (integrity < cfg.fleeIntegrityPercent) out.push(`Integrity ${Math.round(integrity)}% is below the station's ${cfg.fleeIntegrityPercent}% flee floor.`);
  const warnings = (v.damageWarnings ?? []).filter((w) => !w.resolvedAt);
  if (warnings.length) out.push(`${warnings.length} damage warning${warnings.length > 1 ? "s" : ""}: ${warnings[0].message}`);
  return out;
}

export function fleeCard(
  v: ProbeView, cfg: StationConfig, sectors: SectorKnowledge[], costPerSector: Record<string, number>,
  approval: FleeApproval | null, snapshot: Snapshot, now: number,
): FleeCard | null {
  const reasons = dangerReasons(v, cfg, now);
  if (!reasons.length && !approval) return null;
  if (!isFullProbe(v.detail)) return null;
  const p = v.detail;
  const pos = sectorOf(v);
  if (!pos) return null;
  const known = new Map(sectors.map((s) => [vkey(s.sector), s]));
  const visited = new Set(snapshot.visitedSectors.map((s) => vkey(s.relativeCoordinates)));
  const nets = new Set((v.sector?.scutNetworks ?? []).map((n) => n.id));
  const options: Array<FleeOption & { score: number }> = [];
  for (const n of fccNeighbors(pos)) {
    const k = known.get(vkey(n));
    if (k?.hazards.length) continue;
    const inNetwork = !!k && k.scutNetworkIds.some((id) => nets.has(id));
    const notes: string[] = [];
    notes.push(inNetwork ? "Same SCUT network: the group stays in reach." : "Not on this station's SCUT network: group probes may drop out of reach.");
    notes.push(visited.has(vkey(n)) ? "Visited before, no hazard on record." : "Not visited; no scan on record.");
    options.push({ target: n, notes, inNetwork, score: (inNetwork ? 2 : 0) + (visited.has(vkey(n)) ? 1 : 0) });
  }
  options.sort((a, b) => b.score - a.score);

  const risks: string[] = [];
  const extra = p.inventory?.containers.filter((c) => c.kind === "container").length ?? 0;
  if (extra >= 5) risks.push(`${extra} additional containers: each one risks breaking off during the move (10% at 5, +10% per extra container).`);
  const remote = (v.mannies ?? []).filter((m) => m.location.type === "sector" && !same(m.location.sector?.relative, pos));
  if (remote.length) risks.push(`${remote.length} ${remote.length > 1 ? "Mannies are" : "Manny is"} working in another sector and can't be brought home first (a remote recall leaves them stranded).`);
  const local = (v.mannies ?? []).filter((m) => m.location.type === "sector" && same(m.location.sector?.relative, pos));
  if (local.length) risks.push(`${local.length} ${local.length > 1 ? "Mannies" : "Manny"} outside in this sector will be recalled first, which cancels their tasks.`);
  if (v.summary.isDefault) risks.push("This is the default probe: probes that are only in reach because they share its sector will drop out of range.");
  const cost = costPerSector[p.model] ?? null;
  if (cost !== null && p.fuel.deuterium - cost < 0) risks.push(`Fuel ${Math.round(p.fuel.deuterium)} may not cover the jump (about ${cost}).`);

  return {
    stationId: cfg.probeId,
    reasons: reasons.length ? reasons : ["You confirmed a flee."],
    options: options.slice(0, 4).map(({ score: _s, ...o }) => o),
    fuelCost: cost,
    risks,
    approved: approval ? { target: approval.target, at: approval.at, state: approval.state } : null,
  };
}
