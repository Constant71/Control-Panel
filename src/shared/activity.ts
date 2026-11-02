/**
 * Plain-words descriptions of what a Manny or probe is doing, built only from
 * fields the API returns (Manny.task payloads, Probe.movement, Probe.systems),
 * plus the panel's own reason when the panel gave the order.
 */
import type { components } from "./api-schema.js";

type S = components["schemas"];
type Obj = Record<string, unknown>;

export interface PanelOrder {
  at: string;
  by: "automation" | "auto-fix" | "you";
  label: string;
  why: string;
}

export interface Activity {
  /** One line: what it is doing. */
  summary: string;
  /** Extra facts from the task payload, most useful first. */
  details: string[];
  /** Every scalar field of the raw task payload, for the curious. */
  raw: Array<[string, string]>;
}

const DAY = 86_400_000;
const nice = (s: string) => s.replaceAll("_", " ");
const n3 = (x: unknown) => (typeof x === "number" ? +x.toFixed(3) : x);
const vec = (v: unknown) => {
  const r = v as { x?: number; y?: number; z?: number } | undefined;
  return r && typeof r.x === "number" ? `(${r.x}, ${r.y}, ${r.z})` : "?";
};
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
const amounts = (m: unknown): string => {
  if (!m || Array.isArray(m) || typeof m !== "object") return "";
  return Object.entries(m as Obj).filter(([, v]) => typeof v === "number" && v > 0).map(([k, v]) => `${n3(v)} ${nice(k)}`).join(", ");
};

export function flatten(payload: unknown, prefix = "", out: Array<[string, string]> = [], depth = 0): Array<[string, string]> {
  if (!payload || typeof payload !== "object" || depth > 3) return out;
  for (const [k, v] of Object.entries(payload as Obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.every((x) => typeof x !== "object")) out.push([key, v.join(", ")]);
      else v.slice(0, 10).forEach((x, i) => flatten(x, `${key}[${i}]`, out, depth + 1));
    } else if (typeof v === "object") flatten(v, key, out, depth + 1);
    else out.push([key, String(n3(v))]);
  }
  return out;
}

export function describeManny(m: S["Manny"], ctx: { objects?: Obj[]; probeName?: string; probes?: Array<{ id: number; name: string }>; now: number }): Activity {
  const t = (Array.isArray(m.task) || !m.task ? {} : m.task) as Obj;
  const details: string[] = [];
  const objName = (id: unknown) => {
    const o = ctx.objects?.find((x) => x.id === id);
    return o ? String(o.name ?? id) : String(id ?? "?");
  };
  const probeName = (id: unknown) => ctx.probes?.find((p) => p.id === Number(id))?.name ?? `probe ${String(id)}`;
  const where = m.location.type === "probe" ? `aboard ${ctx.probeName ?? "the probe"}` : `outside, in sector ${vec(m.location.sector?.relative)}`;
  let summary: string;

  switch (m.currentTask) {
    case null:
      summary = `Idle ${where}`;
      break;
    case "mining": {
      const target = (t.target ?? {}) as Obj;
      const res = ((t.resourceTypes as string[] | undefined) ?? [String(t.resourceType ?? "")]).map(nice).join(" + ");
      summary = `Mining ${n3(t.targetAmount)} ECE of ${res} from ${String(target.name ?? objName(t.objectId))}`;
      if (t.waitingFor === "storage_space") {
        const since = new Date(String(t.waitingForSpaceSince)).getTime();
        details.push(`Done mining, waiting for storage room since ${span(ctx.now - since)} ago; the game cancels it in ${span(since + 7 * DAY - ctx.now)}.`);
      }
      const profile = amounts(t.resourceProfile);
      if (profile && (t.resourceTypes as unknown[] | undefined)?.length !== 1) details.push(`Split: ${profile}`);
      if (typeof t.miningTravelSeconds === "number") details.push(`Travel ${span(t.miningTravelSeconds * 1000)} each way`);
      const left = amounts(target.resourceAmounts);
      if (left) details.push(`Left on target: ${left}`);
      if (t.requestedTargetAmount) details.push(`Capped from ${n3(t.requestedTargetAmount)} ECE by the container's free space`);
      const tc = t.targetContainer as Obj | undefined;
      if (tc) details.push(`Delivering to a ${nice(String(tc.mode))} container${tc.name ? ` "${String(tc.name)}"` : ""}, not the probe`);
      if (t.targetContainerFull) details.push("Stopped: the target container is full");
      if (t.artificialObjectDetected) details.push("Detected an artificial object while mining");
      break;
    }
    case "waiting_for_space": {
      const since = new Date(String(t.waitingForSpaceSince)).getTime();
      summary = `Waiting for room to dock on ${ctx.probeName ?? "its probe"}`;
      if (Number.isFinite(since)) details.push(`Waiting ${span(ctx.now - since)}; after 7 days it drops its cargo, and is abandoned if there's still no room (in ${span(since + 7 * DAY - ctx.now)}).`);
      if (t.reason) details.push(`Reason: ${nice(String(t.reason))}`);
      break;
    }
    case "crafting":
    case "assisting_atomic_printer": {
      const consumed = Array.isArray(t.consumedItems) ? (t.consumedItems as Obj[]) : [];
      const what = t.recipe ?? t.recipeId ?? t.output;
      summary = m.currentTask === "crafting" ? `Crafting${what ? ` ${nice(String(what))}` : ""}` : `Running the atomic printer${what ? ` (${nice(String(what))})` : ""}`;
      if (consumed.length) details.push(`Used: ${consumed.map((c) => nice(String(c.type ?? c.name ?? c.id))).join(", ")}`);
      break;
    }
    case "repair": summary = `Repairing ${ctx.probeName ?? "the probe"}${t.integrityPercent ? ` (+${String(t.integrityPercent)}%)` : ""}`; break;
    case "salvage": summary = `Recovering ${objName(t.objectId)}`; break;
    case "inspecting_sector_object": summary = `Inspecting ${objName(t.objectId)}`; break;
    case "inspecting_asteroid": summary = `Inspecting asteroid ${objName(t.objectId)}`; break;
    case "refilling_deuterium_tank": summary = "Refilling the tank at a refuel station"; break;
    case "transferring_deuterium_to_probe": summary = `Moving ${String(t.amount ?? "")} deuterium to ${probeName(t.targetProbeId)}`; break;
    case "transferring_to_probe": summary = `Transferring to ${probeName(t.targetProbeId)}`; break;
    case "moving_stockage": summary = `Moving stock between containers${t.resourceType ? ` (${n3(t.amount)} ECE ${nice(String(t.resourceType))})` : ""}`; break;
    case "assembling_probe": summary = `Assembling a ${nice(String(t.model ?? "new"))} probe outside`; details.push(`${ctx.probeName ?? "The probe"} must stay in this sector until it's done.`); break;
    case "improving_probe": summary = `Installing ${nice(String(t.improvement ?? "an improvement"))}`; break;
    case "returning": summary = "Returning to its probe"; break;
    case "unknown_too_far": summary = "Out of telemetry range: the API doesn't say what it's doing"; break;
    default: summary = `${nice(m.currentTask)} ${where}`;
  }
  if (m.currentTask && m.taskEstimatedEndTime) {
    const end = new Date(m.taskEstimatedEndTime).getTime();
    details.unshift(`${Math.round(m.taskProgressPercent)}% · ${end > ctx.now ? `done in ${span(end - ctx.now)}` : "finishing"}`);
  }
  const c = m.cargo;
  const carried = amounts({ metals: c.metals, ice: c.ice, carbon_compounds: c.organicCompounds, deuterium: c.deuterium });
  if (carried) details.push(`Carrying ${carried} (of ${n3(c.capacity)} ECE)`);
  return { summary, details, raw: flatten(t) };
}

export function describeProbe(p: S["Probe"], now: number): Activity {
  const details: string[] = [];
  let summary = nice(p.status);
  const mv = p.movement;
  if (mv && !["arrived"].includes(mv.status)) {
    const arrive = new Date(mv.arrivalAt).getTime();
    summary = mv.status === "failed" || mv.status === "destroyed"
      ? `Move to ${vec(mv.target)} ${mv.status}`
      : `${nice(mv.phase ?? mv.status)} from ${vec(mv.origin)} to ${vec(mv.target)}`;
    details.push(`${mv.distance} sector(s), ${mv.fuelCostDeuterium} deuterium reserved for the trip`);
    if (arrive > now) details.push(`Arrives in ${span(arrive - now)} (started ${span(now - new Date(mv.startedAt).getTime())} ago)`);
    if (mv.estimatedVelocityC) details.push(`About ${n3(mv.estimatedVelocityC)} c`);
    if (mv.sensorMode && mv.sensorMode !== "normal") details.push(`Sensors ${mv.sensorMode} while moving`);
    if (mv.status === "preparing") details.push("Still preparing: this move can be cancelled with a deuterium refund.");
  } else if (p.sector) summary = `${nice(p.status)} in sector ${vec(p.sector.relative)}`;
  const sys = p.systems as Obj | undefined;
  if (sys?.currentTask) details.push(`Probe systems: ${nice(String(sys.currentTask))}`);
  if (p.sensorMode && p.sensorMode !== "normal" && !mv) details.push(`Sensors ${p.sensorMode}`);
  return { summary, details, raw: flatten(mv ?? {}) };
}
