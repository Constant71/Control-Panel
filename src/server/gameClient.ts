import createClient from "openapi-fetch";
import type { paths, components } from "../shared/api-schema.js";
import { RateLimiter, type Priority } from "./rateLimiter.js";

export type Schemas = components["schemas"];
export type GameClient = ReturnType<typeof createClient<paths>>;

export interface ApiLogEntry {
  at: string;
  method: string;
  path: string;
  status: number | null;
  ms: number;
  priority: Priority;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Two typed clients over the same rate limiter. Because they are typed from
 * spec/openapi.yaml, only endpoints, parameters and bodies that exist in the
 * spec compile.
 */
export class Game {
  readonly poll: GameClient;
  readonly action: GameClient;
  readonly log: ApiLogEntry[] = [];
  private static readonly LOG_SIZE = 300;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    readonly limiter: RateLimiter,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.poll = createClient<paths>({ baseUrl, fetch: this.paced("poll") });
    this.action = createClient<paths>({ baseUrl, fetch: this.paced("action") });
  }

  /**
   * Untyped call used only by the manual console, which checks the operation,
   * its parameters and its body against the spec catalog before calling this.
   */
  async raw(method: string, path: string, query: Record<string, string>, body: unknown): Promise<Response> {
    const url = new URL(this.baseUrl.replace(/\/+$/, "") + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const init: RequestInit = { method };
    if (body !== undefined && body !== null) {
      init.body = JSON.stringify(body);
      init.headers = { "Content-Type": "application/json" };
    }
    return this.paced(method === "GET" ? "poll" : "action")(new Request(url, init));
  }

  private paced(priority: Priority) {
    return async (input: Request): Promise<Response> => {
      await this.limiter.acquire(priority);
      const req = new Request(input, {
        headers: new Headers(input.headers),
      });
      req.headers.set("Authorization", `Bearer ${this.apiKey}`);
      req.headers.set("Accept", "application/json");
      const started = Date.now();
      const url = new URL(req.url);
      const entry: ApiLogEntry = {
        at: new Date(started).toISOString(),
        method: req.method,
        path: url.pathname + url.search,
        status: null,
        ms: 0,
        priority,
      };
      try {
        const res = await this.fetchImpl(req);
        entry.status = res.status;
        this.limiter.observe(res.status, res.headers);
        if (!res.ok) {
          try {
            const body = (await res.clone().json()) as Partial<Schemas["ErrorResponse"]>;
            entry.errorCode = body.error?.code;
            entry.errorMessage = body.error?.message;
          } catch {
            /* non-JSON error body */
          }
        }
        return res;
      } catch (err) {
        entry.errorMessage = err instanceof Error ? err.message : String(err);
        this.limiter.observe(0, new Headers());
        throw err;
      } finally {
        entry.ms = Date.now() - started;
        this.log.push(entry);
        if (this.log.length > Game.LOG_SIZE) this.log.splice(0, this.log.length - Game.LOG_SIZE);
      }
    };
  }
}

/** Uniform error shape for anything that went wrong talking to the game. */
export class GameError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Unwraps an openapi-fetch result, throwing GameError on non-2xx. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.data !== undefined && result.response.ok) return result.data;
  const err = result.error as Partial<Schemas["ErrorResponse"]> | undefined;
  throw new GameError(
    result.response.status,
    err?.error?.code ?? `http_${result.response.status}`,
    err?.error?.message ?? result.response.statusText ?? "Request failed",
  );
}
