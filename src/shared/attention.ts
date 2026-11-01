/**
 * Derives "needs attention" flags from fleet data. Every flag is based on a
 * field the API returns; the numeric thresholds (integrity, fuel, overdue) are
 * panel defaults, not game rules, and are labelled as such.
 */
import type { components } from "./api-schema.js";

type S = components["schemas"];
export type Severity = "critical" | "warning" | "info";

export interface Flag {
  severity: Severity;
  code: string;
  text: string;
  /** Spec reference backing this flag. */
  source: string;
}

const SEVEN_DAYS_MS = 7 * 86_400_000;

export const DEFAULT_THRESHOLDS = {
  integrityWarnPercent: 50,
  integrityCriticalPercent: 25,
  fuelWarnPercent: 20,
  overdueGraceMs: 10 * 60_000,
};

type ProbeLike = S["Probe"] | S["ProbeLimitedTelemetry"];

export function isFullProbe(p: ProbeLike | null | undefined): p is S["Probe"] {
  return !!p && p.status !== "out_of_scut_range";
}

export function probeFlags(
  summary: S["ProbeSummary"],
  detail: ProbeLike | null,
  damageWarnings: S["ProbeDamageWarning"][] | null,
  t = DEFAULT_THRESHOLDS,
): Flag[] {
  const flags: Flag[] = [];
  const status = detail?.status ?? summary.status;
  if (status === "dead") flags.push({ severity: "critical", code: "probe_dead", text: "Probe is dead", source: "Probe.status" });
  if (status === "disabled") flags.push({ severity: "critical", code: "probe_disabled", text: "Probe is disabled", source: "Probe.status" });
  if (status === "trapped_by_black_hole")
    flags.push({ severity: "critical", code: "probe_trapped", text: "Trapped by a black hole", source: "Probe.status" });
  if (!summary.isReachable)
    flags.push({
      severity: "warning",
      code: "probe_unreachable",
      text: "Out of SCUT range of the default probe: it can't be given orders",
      source: "ProbeSummary.isReachable",
    });
  if (isFullProbe(detail)) {
    if (detail.alert)
      flags.push({ severity: "critical", code: detail.alert.type, text: detail.alert.title, source: "Probe.alert" });
    const mv = detail.movement;
    if (mv && (mv.status === "failed" || mv.status === "destroyed"))
      flags.push({ severity: "critical", code: "movement_" + mv.status, text: `Movement ${mv.status}`, source: "ProbeMovement.status" });
    const integrity = detail.systems?.integrityPercent;
    if (integrity !== undefined) {
      if (integrity < t.integrityCriticalPercent)
        flags.push({ severity: "critical", code: "integrity_low", text: `Integrity ${Math.round(integrity)}%`, source: "Probe.systems.integrityPercent" });
      else if (integrity < t.integrityWarnPercent)
        flags.push({ severity: "warning", code: "integrity_low", text: `Integrity ${Math.round(integrity)}%`, source: "Probe.systems.integrityPercent" });
    }
    const { deuterium, maxDeuterium } = detail.fuel;
    if (maxDeuterium && (deuterium / maxDeuterium) * 100 < t.fuelWarnPercent)
      flags.push({ severity: "warning", code: "fuel_low", text: `Deuterium ${Math.round(deuterium)}/${maxDeuterium}`, source: "Probe.fuel" });
    if (detail.sensorMode === "blind")
      flags.push({ severity: "warning", code: "sensors_blind", text: "Sensors blind", source: "Probe.sensorMode" });
    if (detail.inventory && detail.inventory.freeCapacity <= detail.inventory.capacity * 0.05)
      flags.push({ severity: "warning", code: "storage_full", text: "Storage nearly full", source: "ProbeInventory.freeCapacity" });
  }
  const unread = (damageWarnings ?? []).filter((w) => (w as { status?: string }).status === "unread").length;
  if (unread)
    flags.push({ severity: "warning", code: "damage_warning", text: `${unread} unread damage warning(s)`, source: "GET damage-warnings" });
  return flags;
}

export function mannyFlags(m: S["Manny"], now = Date.now(), t = DEFAULT_THRESHOLDS): Flag[] {
  const flags: Flag[] = [];
  const task = (Array.isArray(m.task) ? {} : m.task) as Record<string, unknown>;
  const waitingSince = typeof task.waitingForSpaceSince === "string" ? task.waitingForSpaceSince : null;
  if (task.waitingFor === "storage_space" && waitingSince) {
    const left = new Date(waitingSince).getTime() + SEVEN_DAYS_MS - now;
    const days = (left / 86_400_000).toFixed(1);
    flags.push({
      severity: left < 86_400_000 ? "critical" : "warning",
      code: "waiting_for_space",
      text:
        m.currentTask === "mining"
          ? `Mining output waiting for storage, cancelled in ${days}d`
          : `Waiting for storage space, abandoned in ${days}d`,
      source: "MannyWaitingForSpaceTask / MannyMiningTask.waitingForSpaceSince",
    });
  }
  if (task.targetContainerFull === true)
    flags.push({ severity: "warning", code: "target_container_full", text: "Target container full", source: "MannyMiningTask.targetContainerFull" });
  if (m.currentTask === "unknown_too_far")
    flags.push({ severity: "info", code: "too_far", text: "Out of telemetry range", source: "Manny.currentTask" });
  if (m.currentTask === null)
    flags.push({ severity: "info", code: "idle", text: "Idle", source: "Manny.currentTask" });
  if (m.taskEstimatedEndTime && m.currentTask !== "waiting_for_space") {
    const over = now - new Date(m.taskEstimatedEndTime).getTime();
    if (over > t.overdueGraceMs)
      flags.push({ severity: "warning", code: "overdue", text: `Task overdue by ${Math.round(over / 60000)}m`, source: "Manny.taskEstimatedEndTime" });
  }
  return flags;
}

export const worst = (flags: Flag[]): Severity | null =>
  flags.some((f) => f.severity === "critical") ? "critical" : flags.some((f) => f.severity === "warning") ? "warning" : flags.length ? "info" : null;
