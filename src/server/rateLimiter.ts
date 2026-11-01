/**
 * Client-side pacing for the game's per-token sliding-window rate limit.
 *
 * Grounded in the spec's info.description and the TooManyRequests response:
 * - X-RateLimit-Limit: maximum requests per window
 * - X-RateLimit-Remaining: requests left in the window
 * - X-RateLimit-Reset: Unix timestamp when the oldest counted request expires
 * - HTTP 429 carries Retry-After (seconds)
 * Headers can be absent (auth/version endpoints, limiter disabled), so we
 * degrade to a small fixed spacing when we know nothing.
 *
 * "action" requests (orders, fixes) may use the whole budget; "poll" requests
 * stop once Remaining drops to the reserve, so a big fleet refresh can never
 * starve a fix that needs to go out.
 */

export type Priority = "action" | "poll";

export interface RateState {
  limit: number | null;
  remaining: number | null;
  resetAt: number | null; // epoch ms
  blockedUntil: number; // epoch ms, from Retry-After
  total429: number;
  queued: { action: number; poll: number };
  updatedAt: number | null;
}

interface Waiter {
  priority: Priority;
  resolve: () => void;
}

const UNKNOWN_SPACING_MS = 250;

export class RateLimiter {
  private state: RateState = {
    limit: null,
    remaining: null,
    resetAt: null,
    blockedUntil: 0,
    total429: 0,
    queued: { action: 0, poll: 0 },
    updatedAt: null,
  };
  private queue: Waiter[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastGrant = 0;
  /** Requests granted whose response has not come back yet (not in Remaining yet). */
  private inFlight = 0;

  constructor(
    private readonly reserveFraction: number,
    private readonly now: () => number = Date.now,
  ) {}

  snapshot(): RateState {
    return {
      ...this.state,
      queued: {
        action: this.queue.filter((w) => w.priority === "action").length,
        poll: this.queue.filter((w) => w.priority === "poll").length,
      },
    };
  }

  /** Stops the internal timer; queued waiters are left pending. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Resolves when a request of this priority may be sent. */
  acquire(priority: Priority): Promise<void> {
    return new Promise((resolve) => {
      const waiter = { priority, resolve };
      // actions jump ahead of every queued poll
      if (priority === "action") {
        const firstPoll = this.queue.findIndex((w) => w.priority === "poll");
        if (firstPoll === -1) this.queue.push(waiter);
        else this.queue.splice(firstPoll, 0, waiter);
      } else {
        this.queue.push(waiter);
      }
      this.pump();
    });
  }

  /** Feed response headers back in after every request. */
  observe(status: number, headers: Headers): void {
    const t = this.now();
    const limit = intHeader(headers, "x-ratelimit-limit");
    const remaining = intHeader(headers, "x-ratelimit-remaining");
    const reset = intHeader(headers, "x-ratelimit-reset");
    if (limit !== null) this.state.limit = limit;
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (remaining !== null) this.state.remaining = remaining;
    if (reset !== null) this.state.resetAt = reset * 1000;
    if (limit !== null || remaining !== null) this.state.updatedAt = t;
    if (status === 429) {
      this.state.total429 += 1;
      const retryAfter = intHeader(headers, "retry-after") ?? 5;
      this.state.blockedUntil = Math.max(this.state.blockedUntil, t + retryAfter * 1000);
      this.state.remaining = 0;
    }
    this.pump();
  }

  /** How long until a request of this priority could be granted (0 = now). */
  private waitFor(priority: Priority): number {
    const t = this.now();
    if (t < this.state.blockedUntil) return this.state.blockedUntil - t;
    const { limit, remaining, resetAt } = this.state;
    if (limit === null || remaining === null) {
      return Math.max(0, this.lastGrant + UNKNOWN_SPACING_MS - t);
    }
    // A sliding window frees the oldest request at resetAt; once it has passed
    // our remaining figure is stale-low, so allow one probe request through.
    const windowRolled = resetAt !== null && t >= resetAt;
    const effectiveRemaining = remaining - this.inFlight;
    const floor = priority === "action" ? 0 : Math.ceil(limit * this.reserveFraction);
    if (effectiveRemaining > floor) return 0;
    if (windowRolled) return this.inFlight === 0 ? 0 : 200;
    return resetAt !== null ? Math.max(50, resetAt - t) : 1000;
  }

  private pump(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.queue.length > 0) {
      const head = this.queue[0];
      const wait = this.waitFor(head.priority);
      if (wait > 0) {
        // a poll at the head must not block an action behind it
        const actionIdx = this.queue.findIndex((w) => w.priority === "action");
        if (actionIdx > 0 && this.waitFor("action") === 0) {
          this.grant(this.queue.splice(actionIdx, 1)[0]);
          continue;
        }
        this.timer = setTimeout(() => this.pump(), wait);
        return;
      }
      this.grant(this.queue.shift()!);
    }
  }

  private grant(w: Waiter): void {
    this.lastGrant = this.now();
    this.inFlight += 1;
    w.resolve();
  }
}

function intHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
