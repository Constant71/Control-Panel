/**
 * Keeps every visited sector scanned and raises on-page discoveries.
 *
 * - GET /api/sector?x&y&z: detailed cartography for visited sectors. Rescanned
 *   in rotation (oldest first, a few per refresh) so the rate limit is respected.
 * - Current-sector observations from the poller are folded in for free.
 * - Potential blueprints: dormant_construct objects (spec: inspecting one with a
 *   Manny "unlocks one probe improvement"), new entries in
 *   GET /api/probe/{id}/probe-improvements-available, and blueprint_shared alerts.
 */
import { EventEmitter } from "node:events";
import type { Game, Schemas } from "./gameClient.js";
import { unwrap, GameError } from "./gameClient.js";
import type { Snapshot } from "./poller.js";
import { JsonStore } from "./store.js";
import type { Discovery, DiscoveryKind, SectorScanInfo } from "../shared/problems.js";
import { mineableTargets } from "./automation.js";

/** What the panel knows about a sector for hauler trips (Stations 5c). */
export interface SectorKnowledge {
  sector: Vec;
  scannedAt: string | null;
  /** ECE per mineable resource, summed over mineable targets (0 when the scan gives no amounts). */
  resources: Record<string, number>;
  scutNetworkIds: number[];
  coverage: string | null;
  hazards: string[];
}

type Vec = { x: number; y: number; z: number };
const keyOf = (v: Vec) => `${v.x},${v.y},${v.z}`;

interface SectorRecord {
  sector: Vec;
  scannedAt: string | null;
  knowledgeLevel: string | null;
  objects: Array<{ id: string; type: string; name: string | null; summary: string | null }>;
  error: string | null;
  resources?: Record<string, number>;
  scutNetworkIds?: number[];
  coverage?: string | null;
}

interface DiscoveryState {
  sectors: Record<string, SectorRecord>;
  discoveries: Record<string, Discovery>;
  knownBlueprints: string[] | null;
  lastBlueprintCheck: string | null;
}

export interface DiscoveryOptions {
  scansPerCycle: number;
  rescanMs: number;
  blueprintCheckMs: number;
}

const OBJECT_KINDS: Partial<Record<string, { kind: DiscoveryKind; title: (name: string) => string; detail: string }>> = {
  dormant_construct: {
    kind: "dormant_construct",
    title: (n) => `Potential blueprint: ${/dormant construct/i.test(n) ? n : `dormant construct ${n}`}`,
    detail: "Inspecting it with a Manny unlocks one probe improvement (POST inspect-sector-object).",
  },
  manny: { kind: "abandoned_manny", title: (n) => `Abandoned Manny ${n}`, detail: "Salvageable with a Manny when a probe is in this sector." },
  detached_container: { kind: "detached_container", title: (n) => `Detached storage container ${n}`, detail: "Recoverable; may hold resources or Mannies." },
  drifting_item: { kind: "drifting_item", title: (n) => `Drifting items ${n}`, detail: "Recoverable item stack." },
  deuterium_refuel_station: { kind: "deuterium_refuel_station", title: (n) => `Deuterium refuel station ${n}`, detail: "A Manny can fill the probe tank here (refill-deuterium-tank)." },
  scut_relay: { kind: "scut_relay", title: (n) => `SCUT relay ${n}`, detail: "Relays extend command range across sectors (turn-on-relay)." },
};

export class DiscoveryTracker extends EventEmitter {
  private state: DiscoveryState = { sectors: {}, discoveries: {}, knownBlueprints: null, lastBlueprintCheck: null };
  private readonly store: JsonStore<DiscoveryState>;

  constructor(
    private readonly game: Game,
    dataDir: string | undefined,
    private readonly opts: DiscoveryOptions,
    private readonly now: () => number = Date.now,
  ) {
    super();
    this.store = new JsonStore<DiscoveryState>(dataDir, "discovery.json", () => ({
      sectors: {}, discoveries: {}, knownBlueprints: null, lastBlueprintCheck: null,
    }));
  }

  async load(): Promise<void> {
    this.state = await this.store.load();
  }

  discoveries(): Discovery[] {
    return Object.values(this.state.discoveries).sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt));
  }

  scans(): SectorScanInfo[] {
    return Object.entries(this.state.sectors).map(([key, s]) => ({
      key, sector: s.sector, scannedAt: s.scannedAt, objectCount: s.objects.length, knowledgeLevel: s.knowledgeLevel, error: s.error,
    }));
  }

  sectorKnowledge(): SectorKnowledge[] {
    return Object.values(this.state.sectors).map((s) => ({
      sector: s.sector, scannedAt: s.scannedAt, resources: s.resources ?? {}, scutNetworkIds: s.scutNetworkIds ?? [], coverage: s.coverage ?? null,
      hazards: s.objects.filter((o) => o.type === "black_hole" || o.type === "missile").map((o) => o.type),
    }));
  }

  async markRead(keys: string[] | "all"): Promise<void> {
    for (const d of Object.values(this.state.discoveries)) if (keys === "all" || keys.includes(d.key)) d.read = true;
    await this.store.save(this.state);
    this.emit("changed");
  }

  async onSnapshot(snapshot: Snapshot): Promise<void> {
    const t = this.now();
    const nowIso = new Date(t).toISOString();

    // Track every visited sector.
    for (const v of snapshot.visitedSectors) {
      const k = keyOf(v.relativeCoordinates);
      this.state.sectors[k] ??= { sector: v.relativeCoordinates, scannedAt: null, knowledgeLevel: null, objects: [], error: null };
    }

    // Free data: current-sector observations already fetched by the poller.
    for (const p of snapshot.probes) if (p.sector) this.ingest(p.sector, nowIso);

    // Rotate through visited sectors that are due.
    const due = Object.entries(this.state.sectors)
      .filter(([, s]) => !s.scannedAt || t - new Date(s.scannedAt).getTime() >= this.opts.rescanMs)
      .sort(([, a], [, b]) => (a.scannedAt ?? "").localeCompare(b.scannedAt ?? ""))
      .slice(0, this.opts.scansPerCycle);
    for (const [k, s] of due) {
      try {
        const res = unwrap(await this.game.poll.GET("/api/sector", { params: { query: s.sector } }));
        this.ingest(res.sector, nowIso);
      } catch (err) {
        this.state.sectors[k].scannedAt = nowIso; // don't retry every cycle
        this.state.sectors[k].error = err instanceof GameError ? `${err.code}: ${err.message}` : String(err);
      }
    }

    // Blueprints the player knows.
    const last = this.state.lastBlueprintCheck ? new Date(this.state.lastBlueprintCheck).getTime() : 0;
    if (snapshot.defaultProbeId && t - last >= this.opts.blueprintCheckMs) {
      try {
        const res = unwrap(await this.game.poll.GET("/api/probe/{probeId}/probe-improvements-available", {
          params: { path: { probeId: snapshot.defaultProbeId } },
        }));
        const list = res.improvements as Schemas["ProbeImprovement"][];
        const baseline = this.state.knownBlueprints === null;
        const known = new Set(this.state.knownBlueprints ?? []);
        for (const imp of list) {
          if (known.has(imp.id)) continue;
          this.upsert(`new_blueprint:${imp.id}`, {
            kind: "new_blueprint",
            title: baseline ? `Known blueprint: ${imp.name}` : `New blueprint learned: ${imp.name}`,
            detail: imp.description, sector: null, objectId: imp.id,
          }, nowIso, baseline);
          known.add(imp.id);
        }
        this.state.knownBlueprints = [...known];
        this.state.lastBlueprintCheck = nowIso;
      } catch {
        this.state.lastBlueprintCheck = nowIso;
      }
    }

    // Blueprints shared by other players (persistent alert type blueprint_shared).
    for (const p of snapshot.probes)
      for (const a of p.alerts ?? []) {
        const al = a as Schemas["ProbeDamageWarning"] & { id?: number; type?: string; message?: string; blueprintShare?: { blueprintId?: string } };
        if (al.type !== "blueprint_shared") continue;
        this.upsert(`blueprint_shared:${al.id}`, {
          kind: "blueprint_shared", title: `Blueprint shared with you${al.blueprintShare?.blueprintId ? `: ${al.blueprintShare.blueprintId}` : ""}`,
          detail: al.message ?? "", sector: null, objectId: al.blueprintShare?.blueprintId ?? null,
        }, nowIso, false);
      }

    await this.store.save(this.state);
    this.emit("changed");
  }

  private ingest(obs: Schemas["SectorObservation"], nowIso: string): void {
    const k = keyOf(obs.relativeCoordinates);
    const objects = ((obs.objects ?? []) as Array<Record<string, unknown>>).map((o) => ({
      id: String(o.id ?? ""), type: String(o.type ?? ""), name: o.name ? String(o.name) : null, summary: o.summary ? String(o.summary) : null,
    }));
    const prev = this.state.sectors[k];
    const resources: Record<string, number> = {};
    for (const t of mineableTargets(obs))
      for (const r of t.resourceTypes ?? []) resources[r] = (resources[r] ?? 0) + Number((t.resourceAmounts as Record<string, number> | undefined)?.[r] ?? 0);
    this.state.sectors[k] = {
      sector: obs.relativeCoordinates, scannedAt: nowIso, knowledgeLevel: obs.knowledgeLevel, objects, error: null,
      resources, scutNetworkIds: (obs.scutNetworks ?? []).map((n) => n.id), coverage: obs.scutCoverageStatus ?? null,
    };

    // Only detailed scans list objects reliably; don't mark things gone on a weak scan.
    const detailed = obs.knowledgeLevel === "detailed";
    const seen = new Set<string>();
    for (const o of objects) {
      const spec = OBJECT_KINDS[o.type];
      if (!spec || !o.id) continue;
      const key = `${spec.kind}:${o.id}`;
      seen.add(key);
      this.upsert(key, { kind: spec.kind, title: spec.title(o.name ?? o.id), detail: o.summary ?? spec.detail, sector: obs.relativeCoordinates, objectId: o.id }, nowIso, false);
    }
    if (detailed && prev)
      for (const d of Object.values(this.state.discoveries))
        if (d.sector && keyOf(d.sector) === k && d.objectId && !seen.has(d.key) && d.kind !== "new_blueprint" && d.kind !== "blueprint_shared")
          d.present = false;
  }

  private upsert(key: string, d: Omit<Discovery, "key" | "firstSeenAt" | "lastSeenAt" | "read" | "present">, nowIso: string, read: boolean): void {
    const existing = this.state.discoveries[key];
    if (existing) {
      existing.lastSeenAt = nowIso;
      existing.present = true;
      existing.title = d.title;
      return;
    }
    this.state.discoveries[key] = { ...d, key, firstSeenAt: nowIso, lastSeenAt: nowIso, read, present: true };
  }
}
