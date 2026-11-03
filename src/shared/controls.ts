/** Which spec calls the probe page's manual controls offer (src/web/ControlsPanel.tsx). */
import type { Operation } from "./operations.js";

export const MANNY_PREFIX = "/api/probe/{probeId}/mannies/{mannyId}";
export const PROBE_PREFIX = "/api/probe/{probeId}/";

/** Calls on one Manny, most useful first. */
const MANNY_ORDER = [
  "drop-manny-cargo", "recall", "transfer-to-probe", "mine", "repair", "salvage", "recover-storage-container", "detach-storage-container",
  "craft", "transfer-deuterium-to-probe", "refill-deuterium-tank", "transfer-deuterium-from-external-storage", "storage-transfers",
  "inspect-sector-object", "install-bookmark",
];
/** Probe calls that change things, most useful first (reads live on the Console). */
const PROBE_ORDER = ["move", "storage-moves", "inventory/{itemId}/jettison", "atomic-printer/craft", "storage-containers/{containerId}/rules"];

const rank = (order: string[], op: Operation, prefix: string) => {
  const rest = op.path.slice(prefix.length).replace(/^\//, "");
  const i = order.findIndex((x) => rest === x || rest.startsWith(x));
  return i < 0 ? order.length : i;
};

export function mannyOps(ops: Operation[]): Operation[] {
  return ops
    .filter((o) => o.method !== "GET" && o.path.startsWith(MANNY_PREFIX) && o.risk !== "blocked")
    .sort((a, b) => rank(MANNY_ORDER, a, MANNY_PREFIX) - rank(MANNY_ORDER, b, MANNY_PREFIX) || a.summary.localeCompare(b.summary));
}

export function probeOps(ops: Operation[]): Operation[] {
  return ops
    .filter((o) => o.method !== "GET" && o.path.startsWith(PROBE_PREFIX) && !o.path.includes("{mannyId}") && o.risk !== "blocked")
    .sort((a, b) => rank(PROBE_ORDER, a, PROBE_PREFIX) - rank(PROBE_ORDER, b, PROBE_PREFIX) || a.summary.localeCompare(b.summary));
}

