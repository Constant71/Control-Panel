/**
 * Minimal local stand-in for the game API, for development and tests only.
 * Serves the read-only endpoints the panel polls, with rate-limit headers that
 * follow the spec's sliding-window description.
 */
import http from "node:http";
import { buildWorld } from "./fixtures.js";

export function startMock(port = 0, opts: { limit?: number; windowMs?: number; apiKey?: string } = {}) {
  const limit = opts.limit ?? 120;
  const windowMs = opts.windowMs ?? 60_000;
  const apiKey = opts.apiKey ?? "vng_mock";
  const hits: number[] = [];
  const world = buildWorld();
  let requestCount = 0;

  const server = http.createServer((req, res) => {
    requestCount++;
    const url = new URL(req.url ?? "/", "http://mock");
    const p = url.pathname;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (p === "/api/version") return json(200, { apiVersion: 150 });
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      return json(401, { error: { code: "unauthorized", message: "Missing or invalid token." } });
    }

    const now = Date.now();
    while (hits.length && hits[0] <= now - windowMs) hits.shift();
    const rl = (remaining: number) => ({
      "X-RateLimit-Limit": String(limit),
      "X-RateLimit-Remaining": String(Math.max(0, remaining)),
      "X-RateLimit-Reset": String(Math.ceil(((hits[0] ?? now) + windowMs) / 1000)),
    });
    if (hits.length >= limit) {
      const retry = Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000));
      return json(429, { error: { code: "rate_limit_exceeded", message: "Too many API requests for this bearer token." } },
        { ...rl(0), "Retry-After": String(retry) });
    }
    hits.push(now);
    const h = rl(limit - hits.length);

    if (p === "/api/me") return json(200, { player: { id: 1, username: "mock", displayName: "Mock", forumAdmin: false, forumModerator: false } }, h);
    if (p === "/api/probes") return json(200, { defaultProbeId: 1, probes: world.summaries }, h);
    if (p === "/api/probe/missions") return json(200, { missions: world.missions }, h);
    if (p === "/api/visited-sectors") return json(200, { visitedSectors: world.visited }, h);

    const m = p.match(/^\/api\/probe\/(\d+)(\/.*)?$/);
    if (m) {
      const id = Number(m[1]);
      const rest = m[2] ?? "";
      const probe = world.probes.find((x) => x.id === id);
      if (id === world.farProbe.id) {
        if (rest === "") return json(200, { probe: world.farProbe }, h);
        return json(422, { error: { code: "probes_not_in_same_scut_network", message: "Probe is outside SCUT reach." } }, h);
      }
      if (!probe) return json(404, { error: { code: "not_found", message: "Probe not found." } }, h);
      if (rest === "") return json(200, { probe }, h);
      if (rest === "/mannies") return json(200, { mannies: world.mannies[id] ?? [], nextUsefulRefreshDelayMs: 30_000 }, h);
      if (rest === "/alerts") return json(200, { alerts: [], rules: { storageContainerBreak: {} } }, h);
      if (rest === "/damage-warnings") return json(200, { damageWarnings: world.alerts[id] ?? [] }, h);
      if (rest === "/sector") {
        if (probe.status === "cruising") return json(409, { error: { code: "sensors_unavailable", message: "Sector scan unavailable while moving." } }, h);
        return json(200, { sector: world.sector, inventory: probe.inventory }, h);
      }
    }
    return json(404, { error: { code: "not_found", message: `No mock for ${p}` } }, h);
  });

  return new Promise<{ url: string; close: () => Promise<void>; requests: () => number }>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }),
        requests: () => requestCount,
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MOCK_PORT ?? 9090);
  startMock(port).then(({ url }) => console.log(`Mock game API on ${url} (token: vng_mock)`));
}
