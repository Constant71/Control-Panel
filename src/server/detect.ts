/**
 * Turns the latest fleet snapshot into a list of problems, each with the
 * real API calls that can fix it. Pure function: no I/O, easy to test.
 *
 * Every rule below cites the spec field or endpoint it relies on.
 */
import type { Snapshot, ProbeView } from "./poller.js";
import type { Schemas } from "./gameClient.js";
import type { FixOption, FixPlan, Problem } from "../shared/problems.js";
import { DEFAULT_THRESHOLDS, isFullProbe } from "../shared/attention.js";

const DAY = 86_400_000;
const SEVEN_DAYS = 7 * DAY;

export interface DetectOptions {
  now?: number;
  thresholds?: typeof DEFAULT_THRESHOLDS;
  /** Drop cargo automatically when the 7-day deadline is closer than this. */
  dropCargoBeforeDeadlineMs?: number;
  /** Mannies that recently received an order and may not show it yet. */
  recentlyOrderedMannies?: Set<string>;
  /**
   * Fuel the Stations feature manages (stations and their group probes): the fixer never moves
   * deuterium to or from these, or the two would undo each other's transfers.
   */
  stationFuel?: { managed: Set<number>; advice: (probeId: number) => string };
}

type Vec = { x: number; y: number; z: number };
const same = (a?: Vec | null, b?: Vec | null) => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
const r3 = (n: number) => Math.floor(n * 1000) / 1000;

function isMoving(p: Schemas["Probe"]): boolean {
  const s = p.movement?.status;
  return !!s && s !== "arrived" && s !== "failed" && s !== "destroyed";
}

function taskObj(m: Schemas["Manny"]): Record<string, unknown> {
  return Array.isArray(m.task) || !m.task ? {} : (m.task as Record<string, unknown>);
}

function stock(p: Schemas["Probe"], type: "metals" | "ice" | "carbon_compounds"): number {
  return p.inventory?.resourceStocks.find((s) => s.type === type)?.amount ?? 0;
}

function cargoTotal(c: Schemas["MannyCargo"]): number {
  return c.deuterium + c.metals + c.ice + c.organicCompounds;
}

interface Ctx {
  views: ProbeView[];
  full: Map<number, Schemas["Probe"]>;
  reserved: Set<string>;
  now: number;
}

/** Picks an idle onboard Manny of this probe that is free to take an order. */
function pickIdleOnboard(ctx: Ctx, probeId: number): Schemas["Manny"] | null {
  const v = ctx.views.find((x) => x.summary.id === probeId);
  const m = (v?.mannies ?? []).find(
    (m) => m.location.type === "probe" && m.currentTask === null && m.canReceiveOrders && !ctx.reserved.has(m.id),
  );
  if (m) ctx.reserved.add(m.id);
  return m ?? null;
}

const endpointFor = (plan: FixPlan): string => {
  switch (plan.kind) {
    case "transfer_manny": return `POST /api/probe/${plan.probeId}/mannies/${plan.mannyId}/transfer-to-probe`;
    case "storage_move": return `POST /api/probe/${plan.probeId}/storage-moves`;
    case "drop_cargo": return `POST /api/probe/${plan.probeId}/mannies/${plan.mannyId}/drop-manny-cargo`;
    case "repair": return `POST /api/probe/${plan.probeId}/mannies/${plan.mannyId}/repair`;
    case "refill_tank": return `POST /api/probe/${plan.probeId}/mannies/${plan.mannyId}/refill-deuterium-tank`;
    case "transfer_deuterium": return `POST /api/probe/${plan.probeId}/mannies/${plan.mannyId}/transfer-deuterium-to-probe`;
    case "salvage": return `POST /api/probe/${plan.probeId}/mannies/${plan.mannyId}/salvage`;
    case "recall": return `POST /api/probe/${plan.probeId}/mannies/${plan.mannyId}/recall`;
    case "cancel_move": return `DELETE /api/probe/${plan.probeId}/move`;
    case "mind_snapshot_reassign": return "POST /api/probe/mind-snapshot/reassign";
  }
};

/**
 * Fix ids identify *what* is being fixed, not which helper Manny does it, so
 * backoff and settling still apply when a different idle Manny is picked.
 */
function fixId(plan: FixPlan): string {
  switch (plan.kind) {
    case "transfer_manny": return `transfer_manny:${plan.mannyId}:${plan.targetProbeId}`;
    case "storage_move": return `storage_move:${plan.probeId}:${plan.resourceType}:${plan.fromContainerId}>${plan.toContainerId}`;
    case "drop_cargo": return `drop_cargo:${plan.mannyId}`;
    case "repair": return `repair:${plan.probeId}`;
    case "refill_tank": return `refill_tank:${plan.probeId}`;
    case "transfer_deuterium": return `transfer_deuterium:${plan.probeId}>${plan.targetProbeId}`;
    case "salvage": return `salvage:${plan.objectId}`;
    case "recall": return `recall:${plan.mannyId}`;
    case "cancel_move": return `cancel_move:${plan.probeId}`;
    case "mind_snapshot_reassign": return "mind_snapshot_reassign";
  }
}

function fix(plan: FixPlan, label: string, why: string, mode: "auto" | "confirm"): FixOption {
  return { id: fixId(plan), label, why, mode, endpoint: endpointFor(plan), plan };
}

/**
 * Free up core storage by moving the largest resource stock in probe-core into
 * an additional container that has room (POST storage-moves, kind=resource).
 */
function storageMoveFix(ctx: Ctx, p: Schemas["Probe"], why: string): FixOption | null {
  const inv = p.inventory;
  if (!inv) return null;
  const core = inv.containers.find((c) => c.kind === "probe");
  const dest = inv.containers
    .filter((c) => c.kind === "container" && c.freeCapacity > 0.005)
    .sort((a, b) => b.freeCapacity - a.freeCapacity)[0];
  if (!core || !dest) return null;
  const candidates = inv.resourceStocks
    .map((s) => ({ type: s.type, inCore: s.containers.find((c) => c.container.id === core.id)?.amount ?? 0 }))
    .filter((s) => s.inCore > 0.001)
    .sort((a, b) => b.inCore - a.inCore);
  const pick = candidates[0];
  if (!pick) return null;
  const actor = pickIdleOnboard(ctx, p.id);
  if (!actor) return null;
  const amount = r3(Math.min(pick.inCore, dest.freeCapacity - 0.001));
  if (amount <= 0) return null;
  return fix(
    {
      kind: "storage_move", probeId: p.id, actorMannyId: actor.id, resourceType: pick.type,
      amount, fromContainerId: core.id, toContainerId: dest.id,
    },
    `Move ${amount} ECE ${pick.type.replace("_", " ")} from ${core.label} to ${dest.label} (by ${actor.name})`,
    why,
    "auto",
  );
}

export function detectProblems(snapshot: Snapshot, opts: DetectOptions = {}): Problem[] {
  const now = opts.now ?? Date.now();
  const t = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const dropBefore = opts.dropCargoBeforeDeadlineMs ?? DAY;
  const full = new Map<number, Schemas["Probe"]>();
  for (const v of snapshot.probes) if (isFullProbe(v.detail)) full.set(v.summary.id, v.detail);
  const ctx: Ctx = { views: snapshot.probes, full, reserved: new Set(opts.recentlyOrderedMannies ?? []), now };
  const out: Problem[] = [];
  const iso = (ms: number) => new Date(ms).toISOString();

  const base = (v: ProbeView, m?: Schemas["Manny"]) => ({
    probeId: v.summary.id,
    probeName: v.summary.name,
    mannyId: m?.id ?? null,
    mannyName: m?.name ?? null,
  });

  // ---- Global: API connectivity -------------------------------------------
  for (const e of snapshot.globalErrors) {
    if (e.code === "unauthorized")
      out.push({
        key: "api:unauthorized", severity: "critical", code: "api_unauthorized",
        title: "The game rejected the API key", detail: e.message, probeId: null, probeName: null, mannyId: null, mannyName: null,
        since: e.at, deadline: null, source: "401 Unauthorized", fixes: [],
        advice: "Create a new key with POST /api/me/api-key, put it in .env as GAME_API_KEY, and restart the container.",
      });
    else if (e.code === "network_error")
      out.push({
        key: "api:network", severity: "critical", code: "api_network",
        title: "Can't reach the game", detail: e.message, probeId: null, probeName: null, mannyId: null, mannyName: null,
        since: e.at, deadline: null, source: e.endpoint, fixes: [],
        advice: "Check the Docker host's internet access and GAME_BASE_URL.",
      });
  }

  const aliveCount = snapshot.probes.filter((v) => !["dead", "trapped_by_black_hole"].includes(v.detail?.status ?? v.summary.status)).length;

  for (const v of snapshot.probes) {
    const d = v.detail;
    const status = d?.status ?? v.summary.status;

    // ---- Probe-level conditions ---------------------------------------------
    if (status === "dead" || status === "trapped_by_black_hole") {
      const fixes: FixOption[] = [];
      // Spec: reassign is "available only when the player's only probe is dead or trapped".
      if (aliveCount === 0)
        fixes.push(fix({ kind: "mind_snapshot_reassign" }, "Restart on a fresh probe from your last mind snapshot",
          "Your only probe is lost. This deletes it, gives you a fresh chassis and resets your reference frame to 0,0,0. It cannot be undone.", "confirm"));
      out.push({
        key: `probe:${v.summary.id}:${status}`, severity: "critical", code: `probe_${status}`,
        title: status === "dead" ? "Probe is dead" : "Probe trapped by a black hole", detail: (isFullProbe(d) && d.message) || "",
        ...base(v), since: null, deadline: null, source: "Probe.status", fixes,
        advice: aliveCount > 0 ? "Other probes survive, so the game handles this itself: the lost probe is deleted and a surviving one becomes default if needed." : null,
      });
      continue;
    }
    if (status === "disabled")
      out.push({
        key: `probe:${v.summary.id}:disabled`, severity: "critical", code: "probe_disabled", title: "Probe is disabled",
        detail: (isFullProbe(d) && d.message) || "", ...base(v), since: null, deadline: null, source: "Probe.status", fixes: [],
        advice: "The API has no call to re-enable a probe. Check the probe's message and alerts in the game.",
      });
    if (!v.summary.isReachable) {
      out.push({
        key: `probe:${v.summary.id}:unreachable`, severity: "warning", code: "probe_unreachable",
        title: "Out of command range", detail: "Not in the default probe's sector or a shared SCUT network, so it can't be given orders or fixed.",
        ...base(v), since: null, deadline: null, source: "ProbeSummary.isReachable", fixes: [],
        advice: "Bring it back into a sector your default probe can reach, or extend SCUT coverage (turn on relays) so both sectors share a network.",
      });
      continue;
    }
    if (!isFullProbe(d)) continue;

    if (d.alert?.type === "mind_snapshot_reassignment_available" && !out.some((p) => p.code === "mind_snapshot")) {
      out.push({
        key: "probe:mind_snapshot", severity: "critical", code: "mind_snapshot", title: d.alert.title, detail: d.alert.message,
        ...base(v), since: null, deadline: null, source: "Probe.alert",
        fixes: [fix({ kind: "mind_snapshot_reassign" }, d.alert.action.label, "Offered by the game itself in Probe.alert.action. It cannot be undone.", "confirm")],
        advice: null,
      });
    }

    if (d.movement && (d.movement.status === "failed" || d.movement.status === "destroyed"))
      out.push({
        key: `probe:${d.id}:movement_${d.movement.status}`, severity: "critical", code: `movement_${d.movement.status}`,
        title: `Last move ${d.movement.status}`, detail: `Target ${JSON.stringify(d.movement.target)}`, ...base(v),
        since: d.movement.startedAt, deadline: null, source: "ProbeMovement.status", fixes: [],
        advice: "Check alerts and damage warnings for the cause before moving again.",
      });

    const objects = (v.sector?.objects ?? []) as Array<Schemas["SectorObject"] & Record<string, unknown>>;
    for (const o of objects)
      if (o.type === "missile" && o.targetsCurrentProbe === true)
        out.push({
          key: `probe:${d.id}:missile:${o.id}`, severity: "critical", code: "incoming_missile",
          title: "Missile targeting this probe", detail: String(o.name ?? o.id ?? ""), ...base(v),
          since: null, deadline: null, source: "SectorObservation.objects[].targetsCurrentProbe", fixes: [],
          advice: "The API has no defensive call. Leaving the sector (POST move) is the only option, so decide quickly.",
        });

    const moving = isMoving(d);

    // Stuck Mannies first, so they get first pick of idle helpers.
    for (const m of v.mannies ?? []) {
      const task = taskObj(m);
      const since = typeof task.waitingForSpaceSince === "string" ? task.waitingForSpaceSince : null;
      if (task.waitingFor === "storage_space" && since) {
        const deadline = new Date(since).getTime() + SEVEN_DAYS;
        const left = deadline - now;
        const mining = m.currentTask === "mining";
        const fixes: FixOption[] = [];
        // 1. Docking wait: send the Manny to another probe in its sector with room.
        if (!mining && m.location.type === "sector") {
          for (const [qid, q] of full) {
            if (qid === d.id || isMoving(q) || moving || !same(q.sector?.relative, m.location.sector?.relative)) continue;
            if ((q.inventory?.freeCapacity ?? 0) <= cargoTotal(m.cargo) + 0.01) continue;
            fixes.push(fix({ kind: "transfer_manny", probeId: d.id, mannyId: m.id, targetProbeId: qid },
              `Dock ${m.name} on ${q.name} instead`, `${q.name} is in the same sector and has free storage.`, "auto"));
            break;
          }
        }
        // 2. Make room on this probe.
        const move = storageMoveFix(ctx, d, "Frees space in the probe hull so the delivery or docking can complete.");
        if (move) fixes.push(move);
        // 3. Last resort before the game drops it anyway: drop cargo to save the Manny.
        if (!mining && cargoTotal(m.cargo) > 0 && same(m.location.sector?.relative, d.sector?.relative))
          fixes.push(fix({ kind: "drop_cargo", probeId: d.id, mannyId: m.id }, `Drop ${m.name}'s cargo and dock`,
            "Resource cargo is lost. The game would drop it at the 7-day mark anyway; doing it earlier keeps the Manny from being abandoned.",
            left < dropBefore ? "auto" : "confirm"));
        out.push({
          key: `manny:${m.id}:waiting_for_space`, severity: left < DAY ? "critical" : "warning", code: mining ? "mining_blocked" : "docking_blocked",
          title: mining ? `${m.name}: mining delivery blocked by full storage` : `${m.name}: can't dock, probe storage full`,
          detail: mining
            ? "After 7 days of waiting the mining is cancelled and nothing is delivered."
            : "After 7 days the cargo is dropped; if the Manny still doesn't fit it becomes an unowned, salvageable Manny.",
          ...base(v, m), since, deadline: iso(deadline), source: mining ? "MannyMiningTask.waitingFor" : "MannyWaitingForSpaceTask",
          fixes,
          advice: fixes.length ? null : "No automatic option right now: jettison or use stock to make room.",
        });
      }
    }

    // Integrity → repair with an idle onboard Manny (MannyRepairRequest: 0.01 ECE metals per %)
    const integrity = d.systems?.integrityPercent;
    if (integrity !== undefined && integrity < t.integrityWarnPercent) {
      const fixes: FixOption[] = [];
      const metals = stock(d, "metals");
      const affordable = Math.floor((metals + 1e-9) / 0.01);
      const wanted = Math.ceil(100 - integrity);
      const pct = Math.min(wanted, affordable);
      let advice: string | null = null;
      if (pct >= 1) {
        const m = pickIdleOnboard(ctx, d.id);
        if (m)
          fixes.push(fix({ kind: "repair", probeId: d.id, mannyId: m.id, integrityPercent: pct },
            `Repair +${pct}% with ${m.name}`, `Uses ${(pct * 0.01).toFixed(2)} ECE metals and takes about ${Math.round(pct * 10)} minutes.`, "auto"));
        else advice = "No idle Manny on board to repair. It will be assigned as soon as one is free.";
      } else advice = "Not enough metals to repair (0.01 ECE per 1%). Mine metals first.";
      out.push({
        key: `probe:${d.id}:integrity`, severity: integrity < t.integrityCriticalPercent ? "critical" : "warning", code: "integrity_low",
        title: `Integrity ${Math.round(integrity)}%`, detail: "", ...base(v), since: null, deadline: null,
        source: "Probe.systems.integrityPercent", fixes, advice,
      });
    }

    // A Manny assembling a probe outside while its probe moves away can be left behind (assemble-probe spec).
    if (moving)
      for (const m of v.mannies ?? []) {
        if (m.currentTask !== "assembling_probe") continue;
        const preparing = d.movement?.status === "preparing";
        out.push({
          key: `manny:${m.id}:assembly_left_behind`, severity: "critical", code: "assembly_probe_moving",
          title: `${m.name} is assembling a probe while ${d.name} moves`, detail: "If the probe leaves the sector before the 3-hour build ends, the Manny can be left behind as a forgotten Manny.",
          ...base(v), mannyId: m.id, mannyName: m.name, since: m.taskStartTime, deadline: m.taskEstimatedEndTime,
          source: "Manny.currentTask = assembling_probe, Probe.movement",
          fixes: preparing
            ? [fix({ kind: "cancel_move", probeId: d.id }, `Cancel ${d.name}'s move`, "The move is still preparing, so it can be cancelled and the reserved deuterium is refunded. The build then finishes normally.", "auto")]
            : [],
          advice: preparing ? null : "The move is past preparation, so the API can't cancel it. Once the build time is up, check Problems for a forgotten Manny.",
        });
      }

    // Deuterium → refuel station, or transfer from a probe in the same sector
    const max = d.fuel.maxDeuterium ?? 100;
    if ((d.fuel.deuterium / max) * 100 < t.fuelWarnPercent) {
      const fixes: FixOption[] = [];
      let advice: string | null = null;
      const station = objects.some((o) => o.type === "deuterium_refuel_station");
      if (station && !moving) {
        const m = pickIdleOnboard(ctx, d.id);
        if (m) fixes.push(fix({ kind: "refill_tank", probeId: d.id, mannyId: m.id }, `Refill tank at the station with ${m.name}`,
          "A deuterium refuel station is in this sector; this fills the tank to its maximum in about a minute.", "auto"));
      }
      const managed = opts.stationFuel?.managed.has(d.id) ?? false;
      if (!fixes.length && !moving && !managed) {
        for (const [donorId, donor] of full) {
          if (opts.stationFuel?.managed.has(donorId)) continue;
          if (donorId === d.id || isMoving(donor) || !same(donor.sector?.relative, d.sector?.relative)) continue;
          const dMax = donor.fuel.maxDeuterium ?? 100;
          const spare = donor.fuel.deuterium - dMax * 0.5;
          const deficit = max * 0.8 - d.fuel.deuterium;
          const amount = Math.floor(Math.min(spare, deficit));
          if (amount < 1 || amount >= donor.fuel.deuterium) continue;
          const m = pickIdleOnboard(ctx, donorId);
          if (!m) continue;
          fixes.push(fix({ kind: "transfer_deuterium", probeId: donorId, mannyId: m.id, targetProbeId: d.id, amount },
            `Transfer ${amount} deuterium from ${donor.name} (by ${m.name})`, `${donor.name} keeps at least half its tank. Takes five minutes.`, "auto"));
          break;
        }
      }
      if (!fixes.length && managed) advice = opts.stationFuel!.advice(d.id);
      else if (!fixes.length)
        advice = moving ? "The probe is moving, so no transfer or refill is possible until it arrives."
          : "No refuel station or donor probe here. Mine deuterium (an asteroid with deuterium) or move to a station.";
      out.push({
        key: `probe:${d.id}:fuel`, severity: d.fuel.deuterium / max < 0.1 ? "critical" : "warning", code: "fuel_low",
        title: `Deuterium ${Math.round(d.fuel.deuterium)}/${max}`, detail: "", ...base(v), since: null, deadline: null,
        source: "Probe.fuel", fixes, advice,
      });
    }

    // Unread damage warnings: container chain may break during the next move
    const unread = (v.damageWarnings ?? []).filter((w) => (w as { status?: string }).status === "unread");
    if (unread.length)
      out.push({
        key: `probe:${d.id}:damage_warnings`, severity: "warning", code: "damage_warning",
        title: `${unread.length} unread movement damage warning(s)`,
        detail: String((unread[0] as { message?: string }).message ?? ""), ...base(v), since: null, deadline: null,
        source: "GET damage-warnings", fixes: [],
        advice: "Before the next move, reduce additional containers or keep all onboard Mannies in one container (that container is protected).",
      });

    // Core storage nearly full → rebalance into additional containers before anything gets stuck
    const core = d.inventory?.containers.find((c) => c.kind === "probe");
    const waitingHere = (v.mannies ?? []).some((m) => taskObj(m).waitingFor === "storage_space");
    if (core && core.freeCapacity <= core.capacity * 0.05 && !waitingHere) {
      const f = storageMoveFix(ctx, d, "Keeps room in the probe hull so returning Mannies and deliveries don't get stuck.");
      out.push({
        key: `probe:${d.id}:core_full`, severity: "warning", code: "storage_full",
        title: `${core.label} storage ${Math.round((core.usedCapacity / core.capacity) * 100)}% full`, detail: "",
        ...base(v), since: null, deadline: null, source: "StorageContainer.freeCapacity", fixes: f ? [f] : [],
        advice: f ? null : "No additional container with room. Jettison or use resources, or craft an additional container.",
      });
    }

    // Abandoned Mannies in this sector → salvage (MannySalvageRequest)
    for (const o of objects) {
      if (o.type !== "manny" || !o.id || moving) continue;
      const alreadyOn = (v.mannies ?? []).some((m) => m.currentTask === "salvage" && taskObj(m).objectId === o.id);
      if (alreadyOn) continue;
      const m = pickIdleOnboard(ctx, d.id);
      out.push({
        key: `sector:${d.id}:salvage:${o.id}`, severity: "info", code: "abandoned_manny",
        title: `Abandoned Manny in sector: ${o.name ?? o.id}`, detail: "Salvageable. It joins your fleet once recovered.",
        ...base(v), since: null, deadline: null, source: "SectorObservation.objects[type=manny]",
        fixes: m ? [fix({ kind: "salvage", probeId: d.id, mannyId: m.id, objectId: o.id }, `Salvage with ${m.name}`, "Five-minute recovery task.", "auto")] : [],
        advice: m ? null : "Waiting for an idle Manny on board.",
      });
    }

    // ---- Manny-level conditions ---------------------------------------------
    for (const m of v.mannies ?? []) {
      const task = taskObj(m);
      if (task.waitingFor === "storage_space") continue; // handled above
      if (task.targetContainerFull === true)
        out.push({
          key: `manny:${m.id}:target_full`, severity: "info", code: "target_container_full", title: `${m.name}: target container full`,
          detail: "The mining task stopped because its detached container is full.", ...base(v, m), since: null, deadline: null,
          source: "MannyMiningTask.targetContainerFull", fixes: [], advice: "Recover the container or mine into another one.",
        });
      if (m.taskEstimatedEndTime && m.currentTask && m.currentTask !== "waiting_for_space") {
        const over = now - new Date(m.taskEstimatedEndTime).getTime();
        if (over > t.overdueGraceMs) {
          // Spec (recall): remote recall leaves the Manny "forgotten" in that sector, so only offer it locally.
          const local = m.location.type === "probe" || same(m.location.sector?.relative, d.sector?.relative);
          out.push({
            key: `manny:${m.id}:overdue`, severity: "warning", code: "task_overdue",
            title: `${m.name}: ${m.currentTask.replace(/_/g, " ")} overdue by ${Math.round(over / 60000)} min`,
            detail: "Only the game's scheduler completes tasks; a long delay can mean the task is blocked.",
            ...base(v, m), since: m.taskEstimatedEndTime, deadline: null, source: "Manny.taskEstimatedEndTime",
            fixes: local && m.location.type === "sector"
              ? [fix({ kind: "recall", probeId: d.id, mannyId: m.id }, `Recall ${m.name}`, "Cancels the task and brings the Manny back.", "confirm")]
              : [],
            advice: local ? null : "Recalling a Manny in another sector would leave it forgotten there, so the panel doesn't offer it.",
          });
        }
      }
    }
  }

  const rank = { critical: 0, warning: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.deadline ?? "9").localeCompare(b.deadline ?? "9"));
}
