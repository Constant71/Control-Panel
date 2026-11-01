function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

export interface Config {
  /** Game host. The OpenAPI spec uses server url "/", so every path is appended to this host. */
  gameBaseUrl: string;
  /** Bearer token: an API key from POST /api/me/api-key. */
  gameApiKey: string;
  port: number;
  /** Upper bound between full refreshes when nothing is due sooner. */
  maxPollIntervalMs: number;
  /** Lower bound between full refreshes, to avoid hammering the API. */
  minPollIntervalMs: number;
  /** Share of the rate-limit window kept free for actions and fixes (0..1). */
  rateReserveFraction: number;
  dataDir: string;
  /** Optional HTTP Basic password for the panel itself. */
  panelPassword: string;
}

export function loadConfig(): Config {
  return {
    gameBaseUrl: (process.env.GAME_BASE_URL ?? "https://neumann-probe.net").replace(/\/+$/, ""),
    gameApiKey: process.env.GAME_API_KEY ?? "",
    port: num("PORT", 8080),
    maxPollIntervalMs: num("MAX_POLL_INTERVAL_SECONDS", 60) * 1000,
    minPollIntervalMs: num("MIN_POLL_INTERVAL_SECONDS", 10) * 1000,
    rateReserveFraction: Math.min(0.9, Math.max(0, num("RATE_RESERVE_FRACTION", 0.3))),
    dataDir: process.env.DATA_DIR ?? "./data",
    panelPassword: process.env.PANEL_PASSWORD ?? "",
  };
}
