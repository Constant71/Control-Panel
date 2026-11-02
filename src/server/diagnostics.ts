/**
 * One-file debug export for the System page: what the panel saw from the game and what it did,
 * so a live problem can be diagnosed without access to the server. Secrets never leave:
 * the API key, the panel password and anything shaped like a key or token is replaced.
 */
const SECRET_KEYS = /^(api[-_]?key|token|accessToken|refreshToken|sessionToken|password|secret|authorization|cookie)$/i;
const SECRET_TEXT = /\b(vng_[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._~+/=-]+)/g;

export function redact(value: unknown, secrets: string[] = []): unknown {
  const known = secrets.filter((s) => s && s.length >= 4);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      let out = v.replace(SECRET_TEXT, "[redacted]");
      for (const s of known) out = out.split(s).join("[redacted]");
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEYS.test(k) && x != null ? "[redacted]" : walk(x);
      return o;
    }
    return v;
  };
  return walk(value);
}

export function diagnosticsFilename(now = new Date()): string {
  return `panel-diagnostics-${now.toISOString().replace(/[:.]/g, "-")}.json`;
}
