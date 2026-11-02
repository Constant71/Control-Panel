/**
 * Exploration (step 3c): probes marked "explore" hop to unvisited neighbour sectors.
 *
 * Grounding in the spec:
 *  - Sectors are an FCC grid in player-relative coordinates (x+y+z must be even,
 *    `/api/sector` 400 example); direct neighbours are the 12 offsets with two ±1s and a 0.
 *  - `GET /api/sector?x&y&z` gives neighbour scans: estimatedObjects (star, planet counts,
 *    blackHoleProbability, dangerEstimate), navigationalRisk, scutCoverageStatus, scutNetworks.
 *  - `POST /api/probe/{id}/move {target}` starts a move (needs ≥10% integrity and fuel).
 *  - ProbeSummary.isReachable: a probe can be commanded when it is the default probe, in the
 *    default probe's sector, or inside a SCUT network shared with it.
 *
 * Merchant's rule: a move that keeps the probe commandable runs on its own; a move that
 * would leave control range becomes a confirm card.
 *
 * Nothing gets stranded: a probe only leaves when every Manny is aboard and idle-or-onboard,
 * no Manny is assembling/working outside, and dormant constructs here are inspected first.
 */
import type { Schemas } from "./gameClient.js";
import type { Snapshot, ProbeView } from "./poller.js";
import { isFullProbe } from "../shared/attention.js";
import type { AutomationSettings } from "../shared/automation.js";
import type { Suggestion } from "../shared/crafting.js";
import type { ExploreStatus } from "../shared/exploration.js";
import { settingsFor } from "./automation.js";

export type Vec = { x: number; y: number; z: number };
export const vkey = (v: Vec) => `${v.x},${v.y},${v.z}`;
const same = (a?: Vec | null, b?: Vec | null) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;

export function fccNeighbors(v: Vec): Vec[] {
  const out: Vec[] = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) {
    out.push({ x: v.x + a, y: v.y + b, z: v.z }, { x: v.x + a, y: v.y, z: v.z + b }, { x: v.x, y: v.y + a, z: v.z + b });
  }
  return out;
}

export function fccDistance(a: Vec, b: Vec): number {
  const d = [Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z)];
  return Math.max(...d, (d[0] + d[1] + d[2]) / 2);
}

export interface MovePlan {
  probeId: number;
  probeName: string;
  target: Vec;
  label: string;
  why: string;
}

export interface ExploreInput {
  snapshot: Snapshot;
  settings: AutomationSettings;
  /** Neighbour scans keyed by "x,y,z". */
  scans: Record<string, Schemas["SectorObservation"]>;
  /** When each probe was first seen settled in its current sector. */
  settledSince: Record<string, string>;
  /** Learned deuterium points per sector of distance, by probe model (from observed moves). */
  costPerSector: Record<string, number>;
  /** Inspected dormant constructs (they unlock blueprints, so they come before leaving). */
  inspected: Set<string>;
  /** Moves Merchant confirmed, by probe id: target key and when. */
  approved?: Record<string, { key: string; at: string }>;
  now: number;
}

export interface ExploreResult {
  moves: MovePlan[];
  suggestions: Suggestion[];
  /** Probes getting ready to leave: no new exterior work for their Mannies. */
  departing: Set<number>;
  status: ExploreStatus[];
}

type Obj = Record<string, unknown>;

export function planExploration(input: ExploreInput): ExploreResult {
  const { snapshot, settings, scans, settledSince, costPerSector, inspected, now, approved = {} } = input;
  const res: ExploreResult = { moves: [], suggestions: [], departing: new Set(), status: [] };
  const visited = new Set(snapshot.visitedSectors.map((s) => vkey(s.relativeCoordinates)));
  const def = snapshot.probes.find((v) => v.summary.id === snapshot.defaultProbeId) ?? null;
  const defDetail = def && isFullProbe(def.detail) ? def.detail : null;
  const defPos = defDetail?.sector?.relative ?? null;
  const defMoving = !!defDetail && isMoving(defDetail);
  const defNets = new Set((def?.sector?.scutNetworks ?? []).map((n) => n.id));
  // Sectors other probes already occupy or head to: don't send two explorers to the same place.
  const claimed = new Set<string>();
  for (const v of snapshot.probes) {
    const d = v.detail;
    if (d?.sector?.relative) claimed.add(vkey(d.sector.relative));
    if (isFullProbe(d) && d.movement && isMoving(d)) claimed.add(vkey(d.movement.target));
  }

  for (const v of snapshot.probes) {
    const cfg = settingsFor(settings, v.summary.id);
    if (!cfg.explore) continue;
    const st: ExploreStatus = { probeId: v.summary.id, probeName: v.summary.name, state: "waiting", text: "", candidates: [] };
    res.status.push(st);
    const say = (state: ExploreStatus["state"], text: string) => Object.assign(st, { state, text });

    if (!v.summary.isReachable || !isFullProbe(v.detail)) { say("blocked", "Out of command range, so the panel can't move it."); continue; }
    const p = v.detail;
    const pos = p.sector?.relative;
    if (isMoving(p)) { say("moving", `Moving to (${p.movement!.target.x}, ${p.movement!.target.y}, ${p.movement!.target.z}).`); continue; }
    if (["dead", "disabled", "trapped_by_black_hole"].includes(p.status) || !pos) { say("blocked", `Probe is ${p.status}.`); continue; }
    const integrity = p.systems?.integrityPercent ?? 0;
    if (integrity < cfg.exploreMinIntegrity) { say("blocked", `Integrity ${Math.round(integrity)}% is below the ${cfg.exploreMinIntegrity}% you set for exploring (the game needs 10%). Repairs come first.`); continue; }

    const settled = settledSince[String(p.id)] ? new Date(settledSince[String(p.id)]).getTime() : now;
    const dwellLeft = settled + cfg.exploreDwellMinutes * 60_000 - now;
    if (dwellLeft > 0) { say("dwelling", `Working this sector for ${Math.ceil(dwellLeft / 60_000)} more min (scans, constructs, mining) before moving on.`); continue; }

    const objects = (v.sector?.objects ?? []) as Obj[];
    const constructs = objects.filter((o) => o.type === "dormant_construct" && o.inspectable !== false && !inspected.has(String(o.id)));
    if (constructs.length && settings.inspectConstructs) { say("dwelling", `Waiting to inspect ${constructs.length} dormant construct(s) here first (blueprints).`); continue; }

    // Candidates: unvisited, unclaimed neighbours with a usable scan.
    const max = p.fuel.maxDeuterium ?? 100;
    const perSector = costPerSector[p.model] ?? null;
    const cands = fccNeighbors(pos)
      .filter((n) => !visited.has(vkey(n)) && !claimed.has(vkey(n)))
      .map((n) => scoreTarget(n, scans[vkey(n)]))
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => b.score - a.score);
    st.candidates = cands.slice(0, 5).map((c) => ({ target: c.target, score: c.score, notes: c.notes, safe: c.safe }));
    if (!cands.length) {
      const scanned = fccNeighbors(pos).filter((n) => scans[vkey(n)]).length;
      say("blocked", scanned < 12 ? `Scanning neighbour sectors (${scanned}/12 so far).` : "Every neighbour sector is visited, claimed by another probe, or has no usable scan.");
      continue;
    }
    const ok = approved[String(p.id)];
    const okFresh = ok && now - new Date(ok.at).getTime() < 24 * 3600_000;
    const best = (okFresh && cands.find((c) => vkey(c.target) === ok.key)) || cands[0];
    const isApproved = !!okFresh && vkey(best.target) === ok.key;
    const cost = perSector ?? null;
    const after = cost === null ? null : p.fuel.deuterium - cost;
    const minFuel = (cfg.exploreMinFuelPercent / 100) * max;
    if (after !== null ? after < minFuel : p.fuel.deuterium < minFuel + 0.1 * max) {
      say("blocked", `Fuel ${Math.round(p.fuel.deuterium)}/${max}: ${cost === null ? "the move cost isn't known yet, so it keeps a 10-point margin above" : `a move costs about ${cost}, which would drop below`} your ${cfg.exploreMinFuelPercent}% floor. Mining deuterium first.`);
      continue;
    }

    // Will the probe stay commandable after the move?
    const tScan = scans[vkey(best.target)];
    const tNets = new Set((tScan?.scutNetworks ?? []).map((n) => n.id));
    const sharesNet = tScan?.scutCoverageStatus === "covered" && [...tNets].some((id) => defNets.has(id));
    const isDefault = p.id === snapshot.defaultProbeId;
    let inRange: boolean;
    let rangeWhy: string;
    if (isDefault) {
      const ownNets = new Set((v.sector?.scutNetworks ?? []).map((n) => n.id));
      inRange = tScan?.scutCoverageStatus === "covered" && [...tNets].some((id) => ownNets.has(id));
      rangeWhy = inRange ? "Both sectors are in the same SCUT network, so probes it reaches through that network stay reachable."
        : `${p.name} is your default probe: probes that are only reachable because they share its sector would drop out of command range.`;
    } else if (!defMoving && same(defPos, best.target)) {
      inRange = true; rangeWhy = "It joins your default probe's sector.";
    } else {
      inRange = sharesNet;
      rangeWhy = sharesNet ? "The target is covered by a SCUT network your default probe is in." : `SCUT coverage there is ${tScan?.scutCoverageStatus ?? "unknown"}, so ${p.name} would be out of command range until it returns or a relay covers it.`;
    }
    const autoOk = (inRange && best.safe) || isApproved;
    const label = `Move ${p.name} to (${best.target.x}, ${best.target.y}, ${best.target.z})`;
    const why = [isApproved ? "You approved this move." : "Unvisited neighbour sector.", ...best.notes, rangeWhy].join(" ");
    if (autoOk) {
      // Allowed to go: stop sending Mannies out until it leaves.
      res.departing.add(p.id);
      const mannies = v.mannies ?? [];
      const outside = mannies.filter((m) => m.location.type === "sector");
      if (outside.length) {
        const here = outside.filter((m) => same(m.location.sector?.relative, pos) && m.currentTask !== "waiting_for_space");
        const waiting = outside.filter((m) => m.currentTask === "waiting_for_space");
        const away = outside.filter((m) => !same(m.location.sector?.relative, pos) || m.currentTask === "unknown_too_far");
        const parts = [
          here.length ? `${here.length} finishing work outside (${here.map((m) => m.name).join(", ")})` : "",
          waiting.length ? `${waiting.length} waiting for storage room to dock (${waiting.map((m) => m.name).join(", ")}): see Problems` : "",
          away.length ? `${away.length} in another sector or out of telemetry (${away.map((m) => m.name).join(", ")}): leaving could strand them, so this needs a fix on the Problems page first` : "",
        ].filter(Boolean);
        // A Manny that can't come home by itself is a Problems-page fix; keep the probe working meanwhile.
        if (away.length || waiting.length) res.departing.delete(p.id);
        say(away.length || waiting.length ? "blocked" : "recalling", `Won't leave until every Manny is aboard. ${parts.join("; ")}. No new outside work is given meanwhile.`);
        continue;
      }
      const assembling = mannies.find((m) => m.currentTask === "assembling_probe");
      if (assembling) { say("recalling", `${assembling.name} is assembling a probe here.`); continue; }
      res.moves.push({ probeId: p.id, probeName: p.name, target: best.target, label, why });
      say("moving", `${label}: ${isApproved ? "approved by you. " : ""}${best.notes.join(" ")}`);
    } else {
      // Waiting for Merchant: keep working the sector meanwhile (mining is not stopped).
      const risks = [
        ...(inRange ? [] : [rangeWhy, "While it's out of range, the panel can't fix problems, mine, craft or rename there; the Problems page keeps showing what the API still reports."]),
        ...(!best.safe ? [`Scan flags danger: ${best.dangers.join(", ")}.`] : []),
        `Fuel: ${Math.round(p.fuel.deuterium)}/${max}${cost !== null ? `, about ${cost} for this jump (learned from earlier moves)` : "; the exact cost is reserved when the game accepts the move"}.`,
        "A move can be cancelled only while it is still preparing.",
      ];
      res.suggestions.push({
        id: `move:${p.id}:${vkey(best.target)}`, kind: "move_probe", probeId: p.id, probeName: p.name,
        title: label, ready: true,
        why: [
          `${p.name} is set to explore and has finished this sector.`, `Target is an unvisited neighbour.`, ...best.notes, ...(inRange ? [rangeWhy] : []),
          "When you confirm, the panel stops new outside work, waits for every Manny to be aboard, then sends the move (the OK lasts 24 hours).",
        ],
        consumes: cost !== null ? [{ item: "deuterium", need: cost, have: p.fuel.deuterium }] : [],
        missing: [], risks, blockers: [], mannyId: null, mannyName: null, containerIds: [],
        target: best.target, durationSeconds: 0, endpoint: `POST /api/probe/${p.id}/move`,
      });
      say("needs_you", `${label} needs your OK: ${inRange ? "the scan flags danger" : "it would leave command range"}.`);
    }
  }
  return res;
}

function isMoving(p: Schemas["Probe"]): boolean {
  return !!p.movement && !["arrived", "failed", "destroyed"].includes(p.movement.status);
}

/** Scores a neighbour from its scan. Returns null when there is no scan to judge by. */
export function scoreTarget(target: Vec, scan: Schemas["SectorObservation"] | undefined) {
  if (!scan) return null;
  const est = (scan.estimatedObjects ?? {}) as Obj;
  const notes: string[] = [];
  const dangers: string[] = [];
  let score = 1;
  if (est.star === true) { score += 3; notes.push("Scan shows a star."); }
  const pMin = Number(est.planetCountMin ?? 0), pMax = Number(est.planetCountMax ?? 0);
  if (pMax > 0) { score += (pMin + pMax) / 4; notes.push(`${pMin}–${pMax} planets estimated.`); }
  const possible = (scan.possibleObjects ?? []) as string[];
  if (possible.length) notes.push(`Possible: ${possible.map((x) => x.replaceAll("_", " ")).join(", ")}.`);
  const bh = Number(est.blackHoleProbability ?? 0);
  if (bh > 0) notes.push(`Black hole chance ${Math.round(bh * 100)}%.`);
  if (bh >= 0.05) dangers.push(`black hole chance ${Math.round(bh * 100)}%`);
  const danger = String(est.dangerEstimate ?? (scan as Obj).dangerEstimate ?? "");
  if (danger && danger !== "low" && danger !== "none") dangers.push(`danger ${danger}`);
  const nav = scan.navigationalRisk;
  if (nav && nav !== "low") dangers.push(`navigational risk ${nav}`);
  if (scan.scutCoverageStatus === "covered") { score += 1; notes.push("Inside known SCUT coverage."); }
  score *= scan.confidence || 0.5;
  score -= dangers.length * 5 + bh * 50;
  if (scan.confidence < 0.3) dangers.push(`low scan confidence (${Math.round(scan.confidence * 100)}%)`);
  return { target, score: +score.toFixed(2), notes, dangers, safe: dangers.length === 0 };
}

export function exploringProbes(snapshot: Snapshot, settings: AutomationSettings): ProbeView[] {
  return snapshot.probes.filter((v) => settingsFor(settings, v.summary.id).explore && v.summary.isReachable && isFullProbe(v.detail));
}
