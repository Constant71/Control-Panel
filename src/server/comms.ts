/**
 * Unread probe messages for the nav badge and Fleet view:
 * GET /api/probe/{id}/messages?status=unread for each reachable probe, every 5 minutes.
 */
import { EventEmitter } from "node:events";
import { unwrap, type Game, type Schemas } from "./gameClient.js";
import type { Snapshot } from "./poller.js";

const REFRESH_MS = 5 * 60_000;

export class CommsTracker extends EventEmitter {
  unread: Record<string, Schemas["ProbeMessage"][]> = {};
  private at: Record<string, number> = {};

  constructor(private readonly game: Game, private readonly now = Date.now) {
    super();
  }

  get unreadCount(): number {
    return Object.values(this.unread).reduce((n, l) => n + l.length, 0);
  }

  /** Forces the next refresh for a probe (after reading or sending from the panel). */
  invalidate(probeId?: number): void {
    if (probeId === undefined) this.at = {};
    else delete this.at[String(probeId)];
  }

  async onSnapshot(snapshot: Snapshot): Promise<void> {
    const t = this.now();
    let changed = false;
    for (const v of snapshot.probes) {
      const k = String(v.summary.id);
      if (!v.summary.isReachable || t - (this.at[k] ?? 0) < REFRESH_MS) continue;
      this.at[k] = t;
      try {
        const res = unwrap(await this.game.poll.GET("/api/probe/{probeId}/messages", {
          params: { path: { probeId: v.summary.id }, query: { status: "unread", limit: 50 } },
        }));
        this.unread[k] = res.messages;
        changed = true;
      } catch {
        this.at[k] = t - REFRESH_MS + 60_000; // retry in a minute
      }
    }
    if (changed) this.emit("changed");
  }
}
