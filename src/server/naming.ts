/**
 * Naming scheme (agreed with the player):
 * - Probes: <Role>-NN (Station-Alpha for stations). Renamed when the role changes.
 * - Mannies: <probe code>-MNN, e.g. H03-M07. Renamed when the home probe changes.
 * - Containers: from their routing rules (StorageContainerRules), so the name
 *   always matches the use: Core, Home · Mannies, Hand-off · Metals, Cargo · Ice.
 * Calls: PATCH /api/probe/{id} {name}; PATCH .../mannies/{id} {name} (1-40);
 *        PATCH .../storage-containers/{id} {label} (1-80).
 */
import type { Snapshot } from "./poller.js";
import type { Schemas } from "./gameClient.js";
import { isFullProbe } from "../shared/attention.js";
import type { PlannedRename, ProbeRole } from "../shared/automation.js";

const NATO = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima", "Mike",
  "November", "Oscar", "Papa", "Quebec", "Romeo", "Sierra", "Tango", "Uniform", "Victor", "Whiskey", "Xray", "Yankee", "Zulu"];

const RES_LABEL: Record<string, string> = { metals: "Metals", ice: "Ice", carbon_compounds: "Carbon", deuterium: "Deuterium" };
const pad = (n: number) => String(n).padStart(2, "0");

export function probeNames(probes: Array<{ id: number }>, roleOf: (id: number) => ProbeRole): Map<number, { name: string; code: string }> {
  const out = new Map<number, { name: string; code: string }>();
  const counters = new Map<ProbeRole, number>();
  for (const p of [...probes].sort((a, b) => a.id - b.id)) {
    const role = roleOf(p.id);
    const n = (counters.get(role) ?? 0) + 1;
    counters.set(role, n);
    if (role === "Station") {
      const word = NATO[(n - 1) % NATO.length] + (n > NATO.length ? String(Math.ceil(n / NATO.length)) : "");
      out.set(p.id, { name: `Station-${word}`, code: `S${word[0]}${n > NATO.length ? Math.ceil(n / NATO.length) : ""}` });
    } else {
      // "ST" keeps Station Tanker Manny codes apart from Scouts ("S").
      out.set(p.id, { name: `${role}-${pad(n)}`, code: `${role === "StationTanker" ? "ST" : role[0]}${pad(n)}` });
    }
  }
  return out;
}

export function containerLabel(c: Schemas["StorageContainer"]): string {
  if (c.kind === "probe") return "Core";
  const r = c.rules ?? {};
  const pri = (r.priority ?? []).map(String);
  const strict = (r.strictExclusion ?? []).map(String);
  const resource = pri.find((x) => RES_LABEL[x]);
  if (pri.includes("manny")) return "Home · Mannies";
  if (strict.includes("manny") && resource) return `Hand-off · ${RES_LABEL[resource]}`;
  if (strict.includes("manny")) return "Hand-off";
  if (resource) return `Cargo · ${RES_LABEL[resource]}`;
  if (pri.length) return `Cargo · ${pri[0].replace(/_/g, " ")}`;
  return "Cargo";
}

export function planRenames(snapshot: Snapshot, roleOf: (id: number) => ProbeRole, locked: Set<string>): PlannedRename[] {
  const out: PlannedRename[] = [];
  const names = probeNames(snapshot.probes.map((p) => p.summary), roleOf);
  for (const v of snapshot.probes) {
    const pid = v.summary.id;
    const target = names.get(pid)!;
    const reachable = v.summary.isReachable;
    const push = (entity: string, kind: PlannedRename["kind"], current: string, planned: string) => {
      if (current !== planned) out.push({ entity, kind, probeId: pid, current, planned, locked: locked.has(entity), reachable });
    };
    push(`probe:${pid}`, "probe", v.summary.name, target.name);

    // Mannies: keep a Manny's number if it already has this probe's code.
    const mannies = [...(v.mannies ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    const re = new RegExp(`^${target.code}-M(\\d+)$`);
    const used = new Set<number>();
    for (const m of mannies) {
      const n = Number(m.name.match(re)?.[1]);
      if (n && !used.has(n) && m.name === `${target.code}-M${pad(n)}`) used.add(n);
    }
    let next = 1;
    const claimed = new Set<number>();
    for (const m of mannies) {
      const n = Number(m.name.match(re)?.[1]);
      if (n && m.name === `${target.code}-M${pad(n)}` && !claimed.has(n)) {
        claimed.add(n);
        continue;
      }
      while (used.has(next)) next++;
      used.add(next);
      push(`manny:${m.id}`, "manny", m.name, `${target.code}-M${pad(next)}`);
    }

    // Containers: label from rules, numbered when two share a use.
    if (isFullProbe(v.detail) && v.detail.inventory) {
      const seen = new Map<string, number>();
      const containers = [...v.detail.inventory.containers].sort((a, b) => a.sortOrder - b.sortOrder);
      for (const c of containers) {
        const base = containerLabel(c);
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);
        push(`container:${pid}:${c.id}`, "container", c.label, n > 1 ? `${base} ${n}` : base);
      }
    }
  }
  return out;
}
