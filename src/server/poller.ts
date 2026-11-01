import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { Game, GameError, unwrap, type Schemas } from "./gameClient.js";

export interface FetchError {
  endpoint: string;
  status: number;
  code: string;
  message: string;
  at: string;
}

export interface ProbeView {
  summary: Schemas["ProbeSummary"];
  /** Full Probe when reachable, limited telemetry (status out_of_scut_range) otherwise. */
  detail: Schemas["Probe"] | Schemas["ProbeLimitedTelemetry"] | null;
  mannies: Schemas["Manny"][] | null;
  alerts: Schemas["ProbeDamageWarning"][] | null;
  damageWarnings: Schemas["ProbeDamageWarning"][] | null;
  sector: Schemas["SectorObservation"] | null;
  errors: FetchError[];
  fetchedAt: string;
}

export interface Snapshot {
  player: Schemas["Player"] | null;
  apiVersion: number | null;
  defaultProbeId: number | null;
  probes: ProbeView[];
  missions: Schemas["Mission"][];
  visitedSectors: Schemas["VisitedSector"][];
  globalErrors: FetchError[];
  lastPollStartedAt: string | null;
  lastPollFinishedAt: string | null;
  lastPollDurationMs: number | null;
  nextPollAt: string | null;
  pollCount: number;
}

export function emptySnapshot(): Snapshot {
  return {
    player: null,
    apiVersion: null,
    defaultProbeId: null,
    probes: [],
    missions: [],
    visitedSectors: [],
    globalErrors: [],
    lastPollStartedAt: null,
    lastPollFinishedAt: null,
    lastPollDurationMs: null,
    nextPollAt: null,
    pollCount: 0,
  };
}

export interface PollerOptions {
  minIntervalMs: number;
  maxIntervalMs: number;
  dataDir?: string;
}

/**
 * Keeps an up-to-date picture of the whole fleet using read-only endpoints.
 *
 * Reachability rule from the spec (components.parameters.ProbeId and
 * ProbeSummary.isReachable): probe-scoped routes only work for the default
 * probe and probes in its sector or shared active SCUT coverage. Unreachable
 * probes only get GET /api/probe/{id}, which returns limited telemetry.
 */
export class Poller extends EventEmitter {
  snapshot: Snapshot = emptySnapshot();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly game: Game,
    private readonly opts: PollerOptions,
  ) {
    super();
  }

  async loadPersisted(): Promise<void> {
    if (!this.opts.dataDir) return;
    try {
      const raw = await readFile(path.join(this.opts.dataDir, "snapshot.json"), "utf8");
      this.snapshot = { ...emptySnapshot(), ...(JSON.parse(raw) as Snapshot), nextPollAt: null };
    } catch {
      /* first run */
    }
  }

  start(): void {
    this.stopped = false;
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Ask for a refresh as soon as possible (e.g. after an action). */
  refreshSoon(delayMs = 500): void {
    if (this.stopped) return;
    if (this.running) return; // the running cycle's result will be fresh enough
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    let suggestedDelay = this.opts.maxIntervalMs;
    try {
      suggestedDelay = await this.pollOnce();
    } catch (err) {
      // pollOnce records its own errors; this is a last-resort guard
      this.snapshot.globalErrors = [toFetchError("poll", err)];
    } finally {
      this.running = false;
    }
    if (this.stopped) return;
    const delay = clamp(suggestedDelay, this.opts.minIntervalMs, this.opts.maxIntervalMs);
    this.snapshot.nextPollAt = new Date(Date.now() + delay).toISOString();
    this.emit("snapshot", this.snapshot);
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  /** One full refresh. Returns the suggested delay until the next one. */
  async pollOnce(): Promise<number> {
    const started = Date.now();
    const c = this.game.poll;
    const globalErrors: FetchError[] = [];
    const next: Snapshot = {
      ...this.snapshot,
      lastPollStartedAt: new Date(started).toISOString(),
      globalErrors,
    };
    let suggested = this.opts.maxIntervalMs;

    const attempt = async <T>(endpoint: string, errors: FetchError[], fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (err) {
        errors.push(toFetchError(endpoint, err));
        return null;
      }
    };

    const [version, me, list, missions, visited] = await Promise.all([
      attempt("GET /api/version", globalErrors, async () => unwrap(await c.GET("/api/version"))),
      attempt("GET /api/me", globalErrors, async () => unwrap(await c.GET("/api/me"))),
      attempt("GET /api/probes", globalErrors, async () => unwrap(await c.GET("/api/probes"))),
      attempt("GET /api/probe/missions", globalErrors, async () => unwrap(await c.GET("/api/probe/missions"))),
      attempt("GET /api/visited-sectors", globalErrors, async () => unwrap(await c.GET("/api/visited-sectors"))),
    ]);

    if (version) next.apiVersion = version.apiVersion;
    if (me) next.player = me.player;
    if (missions) next.missions = missions.missions;
    if (visited) next.visitedSectors = visited.visitedSectors;

    if (list) {
      next.defaultProbeId = list.defaultProbeId;
      const previous = new Map(this.snapshot.probes.map((p) => [p.summary.id, p]));
      const views = await Promise.all(
        list.probes.map(async (summary): Promise<{ view: ProbeView; delay: number | null }> => {
          const errors: FetchError[] = [];
          const probeId = summary.id;
          const params = { params: { path: { probeId } } } as const;
          const old = previous.get(probeId);
          const view: ProbeView = {
            summary,
            detail: old?.detail ?? null,
            mannies: summary.isReachable ? (old?.mannies ?? null) : null,
            alerts: summary.isReachable ? (old?.alerts ?? null) : null,
            damageWarnings: summary.isReachable ? (old?.damageWarnings ?? null) : null,
            sector: summary.isReachable ? (old?.sector ?? null) : null,
            errors,
            fetchedAt: new Date().toISOString(),
          };
          let delay: number | null = null;

          const detail = await attempt(`GET /api/probe/${probeId}`, errors, async () =>
            unwrap(await c.GET("/api/probe/{probeId}", params)),
          );
          if (detail) view.detail = detail.probe;
          if (!summary.isReachable) return { view, delay };

          const [mannies, alerts, warnings, sector] = await Promise.all([
            attempt(`GET /api/probe/${probeId}/mannies`, errors, async () =>
              unwrap(await c.GET("/api/probe/{probeId}/mannies", params)),
            ),
            attempt(`GET /api/probe/${probeId}/alerts`, errors, async () =>
              unwrap(await c.GET("/api/probe/{probeId}/alerts", params)),
            ),
            attempt(`GET /api/probe/${probeId}/damage-warnings`, errors, async () =>
              unwrap(await c.GET("/api/probe/{probeId}/damage-warnings", params)),
            ),
            attempt(`GET /api/probe/${probeId}/sector`, errors, async () =>
              unwrap(await c.GET("/api/probe/{probeId}/sector", params)),
            ),
          ]);
          if (mannies) {
            view.mannies = mannies.mannies;
            delay = mannies.nextUsefulRefreshDelayMs;
          }
          if (alerts) view.alerts = alerts.alerts;
          if (warnings) view.damageWarnings = warnings.damageWarnings;
          if (sector) view.sector = sector.sector;

          // A probe in transit reports secondsRemaining; refresh around arrival.
          const d = view.detail;
          if (d && "movement" in d && d.movement?.secondsRemaining !== undefined) {
            const arrival = d.movement.secondsRemaining * 1000 + 1000;
            delay = delay === null ? arrival : Math.min(delay, arrival);
          }
          return { view, delay };
        }),
      );
      next.probes = views.map((v) => v.view);
      for (const v of views) if (v.delay !== null) suggested = Math.min(suggested, v.delay);
    }

    next.lastPollFinishedAt = new Date().toISOString();
    next.lastPollDurationMs = Date.now() - started;
    next.pollCount = this.snapshot.pollCount + 1;
    this.snapshot = next;
    await this.persist();
    return suggested;
  }

  private async persist(): Promise<void> {
    if (!this.opts.dataDir) return;
    try {
      await mkdir(this.opts.dataDir, { recursive: true });
      const file = path.join(this.opts.dataDir, "snapshot.json");
      await writeFile(file + ".tmp", JSON.stringify(this.snapshot));
      await rename(file + ".tmp", file);
    } catch (err) {
      console.error("Could not persist snapshot:", err);
    }
  }
}

function toFetchError(endpoint: string, err: unknown): FetchError {
  const at = new Date().toISOString();
  if (err instanceof GameError) return { endpoint, status: err.status, code: err.code, message: err.message, at };
  return { endpoint, status: 0, code: "network_error", message: err instanceof Error ? err.message : String(err), at };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
