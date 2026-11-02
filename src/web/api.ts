import { useEffect, useState } from "react";
import type { Operation } from "../shared/operations";

export interface CallResult {
  ok: boolean;
  status: number | null;
  data: unknown;
  error: string | null;
}

/** Calls one game operation through the panel server (checked against the spec there). */
export async function callOp(
  opId: string,
  opts: { path?: Record<string, string | number>; query?: Record<string, string | number | boolean>; body?: unknown; confirmed?: boolean } = {},
): Promise<CallResult> {
  const r = await fetch("panel-api/call", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ opId, ...opts }),
  });
  return r.json();
}

let cache: Promise<Operation[]> | null = null;
export function useOperations(): Operation[] | null {
  const [ops, setOps] = useState<Operation[] | null>(null);
  useEffect(() => {
    cache ??= fetch("panel-api/operations").then((r) => r.json()).then((d) => d.operations as Operation[]);
    cache.then(setOps).catch(() => { cache = null; });
  }, []);
  return ops;
}
