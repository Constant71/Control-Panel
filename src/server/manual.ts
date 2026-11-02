/**
 * Manual console (step 4): call any game operation from the spec, with the
 * parameters and body checked against the generated catalog first.
 * Risky operations need `confirmed: true`; credential operations are refused.
 */
import type { Game } from "./gameClient.js";
import { JsonStore } from "./store.js";
import { markOrdered } from "./orders.js";
import { OPERATIONS } from "../shared/operations.gen.js";
import type { JsonSchema, Operation } from "../shared/operations.js";

export interface ManualRequest {
  opId: string;
  path?: Record<string, string | number>;
  query?: Record<string, string | number | boolean>;
  body?: unknown;
  confirmed?: boolean;
}

export interface ManualLogEntry {
  at: string;
  opId: string;
  url: string;
  body: unknown;
  status: number | null;
  ok: boolean;
  code: string | null;
  message: string | null;
}

export interface ManualResult {
  ok: boolean;
  status: number | null;
  data: unknown;
  error: string | null;
  entry: ManualLogEntry | null;
}

const LOG_SIZE = 500;

export function findOperation(opId: string): Operation | undefined {
  return OPERATIONS.find((o) => o.id === opId);
}

/** Light schema check: required fields, enums, primitive types. Returns problems found. */
export function validate(schema: JsonSchema | null | undefined, value: unknown, at = "body"): string[] {
  if (!schema) return [];
  if (value === undefined || value === null) return schema.nullable || value === undefined ? [] : [`${at} can't be null`];
  const errs: string[] = [];
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${at} must be one of ${schema.enum.join(", ")}`);
  const t = schema.type;
  if (t === "integer" && !Number.isInteger(value)) errs.push(`${at} must be a whole number`);
  else if (t === "number" && typeof value !== "number") errs.push(`${at} must be a number`);
  else if (t === "string" && typeof value !== "string") errs.push(`${at} must be text`);
  else if (t === "boolean" && typeof value !== "boolean") errs.push(`${at} must be true or false`);
  else if (t === "array") {
    if (!Array.isArray(value)) errs.push(`${at} must be a list`);
    else value.forEach((v, i) => errs.push(...validate(schema.items, v, `${at}[${i}]`)));
  } else if ((t === "object" || schema.properties) && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (obj[r] === undefined) errs.push(`${at}.${r} is required`);
    for (const [k, v] of Object.entries(obj)) if (schema.properties?.[k]) errs.push(...validate(schema.properties[k], v, `${at}.${k}`));
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${at} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${at} must be at most ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${at} needs at least ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${at} allows at most ${schema.maxLength} characters`);
  }
  return errs;
}

export class Manual {
  private readonly store: JsonStore<{ log: ManualLogEntry[] }>;
  log: ManualLogEntry[] = [];

  constructor(private readonly game: Game, dataDir: string | undefined, private readonly onActed: () => void, private readonly now = Date.now) {
    this.store = new JsonStore(dataDir, "manual.json", () => ({ log: [] }));
  }

  async load(): Promise<void> {
    this.log = (await this.store.load()).log ?? [];
  }

  async call(req: ManualRequest): Promise<ManualResult> {
    const op = findOperation(req.opId);
    const fail = (error: string): ManualResult => ({ ok: false, status: null, data: null, error, entry: null });
    if (!op) return fail("That operation isn't in the API spec.");
    if (op.risk === "blocked") return fail(op.riskNote);
    if (op.risk === "confirm" && !req.confirmed) return fail(`Needs confirmation: ${op.riskNote}`);

    let path = op.path;
    const query: Record<string, string> = {};
    const errs: string[] = [];
    for (const p of op.params) {
      const v = p.in === "path" ? req.path?.[p.name] : req.query?.[p.name];
      if (v === undefined || v === "") {
        if (p.required) errs.push(`${p.name} is required`);
        continue;
      }
      const typed = p.schema.type === "integer" || p.schema.type === "number" ? Number(v) : p.schema.type === "boolean" ? v === true || v === "true" : v;
      errs.push(...validate(p.schema, typed, p.name));
      if (p.in === "path") path = path.replace(`{${p.name}}`, encodeURIComponent(String(v)));
      else query[p.name] = String(v);
    }
    if (op.body) errs.push(...validate(op.body, req.body ?? {}, "body"));
    if (errs.length) return fail(errs.join("; "));

    const entry: ManualLogEntry = {
      at: new Date(this.now()).toISOString(), opId: op.id, url: path + (Object.keys(query).length ? `?${new URLSearchParams(query)}` : ""),
      body: op.body ? req.body ?? {} : null, status: null, ok: false, code: null, message: null,
    };
    let data: unknown = null;
    try {
      const res = await this.game.raw(op.method, path, query, op.body ? req.body ?? {} : undefined);
      entry.status = res.status;
      const text = await res.text();
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      entry.ok = res.ok;
      if (!res.ok) {
        const e = (data as { error?: { code?: string; message?: string } } | null)?.error;
        entry.code = e?.code ?? `http_${res.status}`;
        entry.message = e?.message ?? res.statusText;
      }
    } catch (err) {
      entry.code = "network_error";
      entry.message = err instanceof Error ? err.message : String(err);
    }
    if (op.method !== "GET") {
      // Keep the automation's hands off a Manny you just gave an order to.
      const manny = req.path?.mannyId ?? (req.body as { mannyId?: string } | undefined)?.mannyId;
      if (entry.ok && manny) markOrdered(String(manny), this.now());
      this.log.push(entry);
      if (this.log.length > LOG_SIZE) this.log.splice(0, this.log.length - LOG_SIZE);
      await this.store.save({ log: this.log });
      if (entry.ok) this.onActed();
    }
    return { ok: entry.ok, status: entry.status, data, error: entry.ok ? null : `${entry.code}: ${entry.message}`, entry };
  }
}
