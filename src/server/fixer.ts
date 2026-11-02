/**
 * Runs fixes for detected problems.
 *
 * Safety rules:
 * - Only "auto" fixes run on their own; "confirm" fixes need a button press.
 * - A fix that succeeded is not retried for SETTLE_MS, giving the game time
 *   to show the new state (tasks are asynchronous).
 * - A failing fix backs off 5m, 10m, 20m ... up to 6h, so a fix the game keeps
 *   rejecting can't burn the rate limit.
 * - At most MAX_PER_CYCLE auto fixes per refresh.
 * - Every attempt (and every dry-run) goes to the fix log on disk.
 */
import { EventEmitter } from "node:events";
import type { Game } from "./gameClient.js";
import { GameError, unwrap } from "./gameClient.js";
import type { Snapshot } from "./poller.js";
import { detectProblems } from "./detect.js";
import { JsonStore } from "./store.js";
import { markOrdered, recentlyOrdered } from "./orders.js";
import type { AutoFixMode, FixAttemptState, FixLogEntry, FixOption, FixPlan, Problem } from "../shared/problems.js";

const SETTLE_MS = 5 * 60_000;
const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 6 * 3_600_000;
const MAX_PER_CYCLE = 5;
const LOG_SIZE = 1000;

interface FixerState {
  mode: AutoFixMode;
  attempts: Record<string, FixAttemptState>;
  log: FixLogEntry[];
}

export class Fixer extends EventEmitter {
  problems: Problem[] = [];
  private state: FixerState = { mode: "auto", attempts: {}, log: [] };
  private readonly store: JsonStore<FixerState>;

  constructor(
    private readonly game: Game,
    dataDir: string | undefined,
    private readonly onActed: () => void,
    private readonly now: () => number = Date.now,
    private readonly dropCargoBeforeDeadlineMs?: number,
    private readonly stationFuel?: () => { managed: Set<number>; advice: (probeId: number) => string },
  ) {
    super();
    this.store = new JsonStore<FixerState>(dataDir, "fixer.json", () => ({ mode: "auto", attempts: {}, log: [] }));
  }

  async load(): Promise<void> {
    this.state = await this.store.load();
  }

  get mode(): AutoFixMode {
    return this.state.mode;
  }
  get log(): FixLogEntry[] {
    return this.state.log;
  }
  get attempts(): Record<string, FixAttemptState> {
    return this.state.attempts;
  }

  async setMode(mode: AutoFixMode): Promise<void> {
    this.state.mode = mode;
    await this.store.save(this.state);
    this.emit("changed");
  }

  /** Called after every poll. Detects problems and runs eligible auto fixes. */
  async onSnapshot(snapshot: Snapshot): Promise<void> {
    const t = this.now();
    this.problems = detectProblems(snapshot, {
      now: t,
      recentlyOrderedMannies: recentlyOrdered(t),
      dropCargoBeforeDeadlineMs: this.dropCargoBeforeDeadlineMs,
      stationFuel: this.stationFuel?.(),
    });
    if (this.state.mode === "off") {
      this.emit("changed");
      return;
    }

    let ran = 0;
    let acted = false;
    for (const p of this.problems) {
      if (ran >= MAX_PER_CYCLE) break;
      // After any successful fix for this problem, give the game time to show the result.
      if (!this.eligible(`problem:${p.key}`, t)) continue;
      const f = p.fixes.find((f) => f.mode === "auto" && this.eligible(f.id, t));
      if (!f) continue;
      ran++;
      const ok = await this.execute(p, f, "auto", this.state.mode === "dry_run");
      if (ok && this.state.mode === "auto") acted = true;
    }
    await this.store.save(this.state);
    this.emit("changed");
    if (acted) this.onActed();
  }

  /** User-initiated fix from the Problems page. Runs whatever the mode is. */
  async runManually(problemKey: string, fixId: string): Promise<FixLogEntry> {
    const p = this.problems.find((x) => x.key === problemKey);
    const f = p?.fixes.find((x) => x.id === fixId);
    if (!p || !f) {
      const entry = this.logEntry(
        { key: problemKey, title: "(no longer present)" } as Problem,
        { id: fixId, label: fixId, endpoint: "", mode: "confirm" } as FixOption,
        "you", false, false, null, "stale", "That problem or fix is no longer current. The page will refresh.",
      );
      return entry;
    }
    await this.execute(p, f, "you", false);
    await this.store.save(this.state);
    this.emit("changed");
    this.onActed();
    return this.state.log[this.state.log.length - 1];
  }

  private eligible(fixId: string, t: number): boolean {
    const a = this.state.attempts[fixId];
    return !a || t >= new Date(a.nextEligibleAt).getTime();
  }

  private async execute(p: Problem, f: FixOption, initiator: "auto" | "you", dryRun: boolean): Promise<boolean> {
    const t = this.now();
    if (dryRun) {
      this.logEntry(p, f, initiator, true, true, null, null, "Dry run: not sent.");
      this.state.attempts[f.id] = { lastAttemptAt: new Date(t).toISOString(), lastOk: true, failures: 0, nextEligibleAt: new Date(t + SETTLE_MS).toISOString() };
      this.state.attempts[`problem:${p.key}`] = { ...this.state.attempts[f.id] };
      return true;
    }
    try {
      const status = await this.call(f.plan);
      for (const id of mannyIdsOf(f.plan)) markOrdered(id, t);
      this.state.attempts[f.id] = { lastAttemptAt: new Date(t).toISOString(), lastOk: true, failures: 0, nextEligibleAt: new Date(t + SETTLE_MS).toISOString() };
      this.state.attempts[`problem:${p.key}`] = { ...this.state.attempts[f.id] };
      this.logEntry(p, f, initiator, false, true, status, null, null);
      return true;
    } catch (err) {
      const prev = this.state.attempts[f.id];
      const failures = (prev && !prev.lastOk ? prev.failures : 0) + 1;
      const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
      this.state.attempts[f.id] = { lastAttemptAt: new Date(t).toISOString(), lastOk: false, failures, nextEligibleAt: new Date(t + wait).toISOString() };
      if (err instanceof GameError) this.logEntry(p, f, initiator, false, false, err.status, err.code, err.message);
      else this.logEntry(p, f, initiator, false, false, null, "network_error", err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  /** Maps a plan to its typed API call. Returns the HTTP status. */
  private async call(plan: FixPlan): Promise<number> {
    const c = this.game.action;
    const mp = (probeId: number, mannyId: string) => ({ params: { path: { probeId, mannyId } } });
    let r: { data?: unknown; error?: unknown; response: Response };
    switch (plan.kind) {
      case "transfer_manny":
        r = await c.POST("/api/probe/{probeId}/mannies/{mannyId}/transfer-to-probe", { ...mp(plan.probeId, plan.mannyId), body: { targetProbeId: plan.targetProbeId } });
        break;
      case "storage_move":
        r = await c.POST("/api/probe/{probeId}/storage-moves", {
          params: { path: { probeId: plan.probeId } },
          body: {
            actorMannyId: plan.actorMannyId, kind: "resource", resourceType: plan.resourceType, amount: plan.amount,
            fromContainerId: plan.fromContainerId, toContainerId: plan.toContainerId,
          },
        });
        break;
      case "drop_cargo":
        r = await c.POST("/api/probe/{probeId}/mannies/{mannyId}/drop-manny-cargo", mp(plan.probeId, plan.mannyId));
        break;
      case "repair":
        r = await c.POST("/api/probe/{probeId}/mannies/{mannyId}/repair", { ...mp(plan.probeId, plan.mannyId), body: { integrityPercent: plan.integrityPercent } });
        break;
      case "refill_tank":
        r = await c.POST("/api/probe/{probeId}/mannies/{mannyId}/refill-deuterium-tank", mp(plan.probeId, plan.mannyId));
        break;
      case "transfer_deuterium":
        r = await c.POST("/api/probe/{probeId}/mannies/{mannyId}/transfer-deuterium-to-probe", {
          ...mp(plan.probeId, plan.mannyId), body: { targetProbeId: plan.targetProbeId, amount: plan.amount },
        });
        break;
      case "salvage":
        r = await c.POST("/api/probe/{probeId}/mannies/{mannyId}/salvage", { ...mp(plan.probeId, plan.mannyId), body: { objectId: plan.objectId } });
        break;
      case "recall":
        r = await c.POST("/api/probe/{probeId}/mannies/{mannyId}/recall", mp(plan.probeId, plan.mannyId));
        break;
      case "cancel_move":
        r = await c.DELETE("/api/probe/{probeId}/move", { params: { path: { probeId: plan.probeId } } });
        break;
      case "mind_snapshot_reassign":
        r = await c.POST("/api/probe/mind-snapshot/reassign", { body: {} });
        break;
    }
    unwrap(r as { data?: unknown; error?: unknown; response: Response });
    return r.response.status;
  }

  private logEntry(
    p: Problem, f: FixOption, initiator: "auto" | "you", dryRun: boolean, ok: boolean,
    status: number | null, code: string | null, message: string | null,
  ): FixLogEntry {
    const entry: FixLogEntry = {
      at: new Date(this.now()).toISOString(), problemKey: p.key, problemTitle: p.title, fixId: f.id, label: f.label,
      endpoint: f.endpoint, initiator, dryRun, ok, status, code, message, why: f.why,
      mannyId: f.plan && "mannyId" in f.plan ? f.plan.mannyId : f.plan && "actorMannyId" in f.plan ? f.plan.actorMannyId : null,
    };
    this.state.log.push(entry);
    if (this.state.log.length > LOG_SIZE) this.state.log.splice(0, this.state.log.length - LOG_SIZE);
    return entry;
  }
}

function mannyIdsOf(plan: FixPlan): string[] {
  if (plan.kind === "storage_move") return [plan.actorMannyId];
  if ("mannyId" in plan) return [plan.mannyId];
  return [];
}
