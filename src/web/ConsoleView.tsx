import { useMemo, useState } from "react";
import type { PanelState, ProbeView, Schemas } from "./types";
import type { JsonSchema, Operation } from "../shared/operations";
import { callOp, useOperations, type CallResult } from "./api";
import { isFullProbe } from "../shared/attention";

/**
 * Manual console: every operation in the game API spec, with forms built from
 * the spec's own parameter and request-body schemas. Risky ones ask first.
 */
export function ConsoleView({ state }: { state: PanelState }) {
  const ops = useOperations();
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("all");
  const [sel, setSel] = useState<string | null>(null);
  const tags = useMemo(() => [...new Set((ops ?? []).map((o) => o.tags[0] ?? "other"))].sort(), [ops]);
  if (!ops) return <p className="pad muted">Loading the API catalog…</p>;
  const list = ops.filter((o) =>
    (tag === "all" || (o.tags[0] ?? "other") === tag) &&
    (!q || `${o.summary} ${o.path} ${o.method}`.toLowerCase().includes(q.toLowerCase())),
  );
  const op = ops.find((o) => o.id === sel) ?? null;
  return (
    <div className="pad console">
      <p className="muted tiny">
        Every call in the game's API spec, with forms built from the spec itself. The panel checks your input against the spec before
        sending. Calls that can lose things ask for confirmation; logging in and creating API keys are switched off here.
      </p>
      <div className="console-grid">
        <div className="card oplist">
          <input className="search" placeholder="Search calls…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="all">All groups ({ops.length})</option>
            {tags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <ul className="plain">
            {list.map((o) => (
              <li key={o.id} className={sel === o.id ? "on" : ""} onClick={() => setSel(o.id)}>
                <span className={`meth m-${o.method}`}>{o.method}</span> {o.summary}
                {o.risk === "confirm" && <span className="tag warn-text">confirm</span>}
                {o.risk === "blocked" && <span className="tag">off</span>}
                {o.deprecated && <span className="tag">deprecated</span>}
              </li>
            ))}
          </ul>
        </div>
        <div>{op ? <OpForm key={op.id} op={op} state={state} /> : <p className="muted">Pick a call on the left.</p>}</div>
      </div>
    </div>
  );
}

type Opt = { value: string; label: string };

function optionsFor(name: string, state: PanelState, probeId: string): Opt[] | null {
  const probe = state.snapshot.probes.find((p) => String(p.summary.id) === probeId);
  const d = probe?.detail;
  switch (name) {
    case "probeId": case "targetProbeId": case "recipientProbeId":
      return state.snapshot.probes.map((p) => ({ value: String(p.summary.id), label: `${p.summary.name} (#${p.summary.id})${p.summary.isReachable ? "" : " · out of range"}` }));
    case "mannyId": case "actorMannyId":
      return (probe?.mannies ?? []).map((m) => ({ value: m.id, label: `${m.name} · ${m.currentTask ?? "idle"}` }));
    case "objectId": case "asteroidId": case "targetObjectId":
      return ((probe?.sector?.objects ?? []) as Array<Record<string, unknown>>).map((o) => ({ value: String(o.id), label: `${String(o.name ?? o.id)} (${String(o.type)})` }));
    case "containerId": case "fromContainerId": case "toContainerId":
      return isFullProbe(d) ? (d.inventory?.containers ?? []).map((c) => ({ value: c.id, label: c.label })) : null;
    case "itemId":
      return isFullProbe(d) ? (d.inventory?.items ?? []).map((i) => ({ value: i.id, label: `${i.name} (${i.type})` })) : null;
    default:
      return null;
  }
}

function OpForm({ op, state }: { op: Operation; state: PanelState }) {
  const firstReachable = state.snapshot.probes.find((p) => p.summary.isReachable)?.summary.id;
  const [params, setParams] = useState<Record<string, string>>(() =>
    Object.fromEntries(op.params.filter((p) => p.name === "probeId").map((p) => [p.name, String(firstReachable ?? "")])),
  );
  const [body, setBody] = useState<Record<string, unknown>>({});
  const [rawMode, setRawMode] = useState(false);
  const [raw, setRaw] = useState("{}");
  const [res, setRes] = useState<CallResult | null>(null);
  const [busy, setBusy] = useState(false);
  const probeId = params.probeId ?? String(firstReachable ?? "");

  const send = async () => {
    let b: unknown = body;
    if (op.body && rawMode) {
      try { b = JSON.parse(raw); } catch { setRes({ ok: false, status: null, data: null, error: "Body isn't valid JSON." }); return; }
    }
    const confirmed = op.risk === "confirm"
      ? window.confirm(`${op.summary}\n\n${op.riskNote}\n\n${op.description.slice(0, 600)}\n\nThis calls ${op.method} ${op.path}. Go ahead?`)
      : op.method === "GET" || window.confirm(`Send ${op.method} ${op.path}?`);
    if (!confirmed) return;
    setBusy(true);
    const path: Record<string, string> = {};
    const query: Record<string, string> = {};
    for (const p of op.params) if (params[p.name] !== undefined && params[p.name] !== "") (p.in === "path" ? path : query)[p.name] = params[p.name];
    try {
      setRes(await callOp(op.id, { path, query, body: op.body ? b : undefined, confirmed: op.risk === "confirm" }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-h">
        <span className={`meth m-${op.method}`}>{op.method}</span> <code className="tiny">{op.path}</code>
      </div>
      <strong>{op.summary}</strong>
      {op.riskNote && <p className="warn-text tiny">{op.riskNote}</p>}
      {op.description && <p className="muted tiny pre">{op.description}</p>}
      {op.params.map((p) => (
        <Field key={p.in + p.name} name={p.name} label={`${p.name}${p.required ? " *" : ""}`} schema={p.schema} hint={p.description}
          value={params[p.name] ?? ""} options={optionsFor(p.name, state, probeId)}
          onChange={(v) => setParams({ ...params, [p.name]: v === undefined ? "" : String(v) })} />
      ))}
      {op.body && (
        <>
          <div className="row mt"><b className="tiny">Request body</b>
            <label className="tiny"><input type="checkbox" checked={rawMode} onChange={(e) => {
              setRawMode(e.target.checked);
              if (e.target.checked) setRaw(JSON.stringify(body, null, 2));
            }} /> edit as JSON</label>
          </div>
          {rawMode ? (
            <>
              <textarea className="json" rows={8} value={raw} onChange={(e) => setRaw(e.target.value)} />
              {op.bodyExample != null && <button className="tiny" onClick={() => setRaw(JSON.stringify(op.bodyExample, null, 2))}>Use the spec's example</button>}
            </>
          ) : (
            <ObjectFields schema={op.body} value={body} onChange={setBody} state={state} probeId={probeId} />
          )}
        </>
      )}
      <div className="actions mt">
        <button className={op.risk === "confirm" ? "danger" : "primary"} disabled={busy || op.risk === "blocked"} onClick={send}>
          {op.risk === "blocked" ? "Switched off" : busy ? "Sending…" : op.method === "GET" ? "Fetch" : "Send"}
        </button>
      </div>
      {res && (
        <div className={`mt ${res.ok ? "" : "warn-text"}`}>
          <div className="tiny"><b>{res.ok ? `OK (${res.status})` : res.status ? `Failed (${res.status})` : "Not sent"}</b>{res.error ? `: ${res.error}` : ""}</div>
          {res.data != null && <pre className="json">{JSON.stringify(res.data, null, 2)}</pre>}
        </div>
      )}
    </div>
  );
}

function ObjectFields({ schema, value, onChange, state, probeId, prefix = "" }: {
  schema: JsonSchema; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; state: PanelState; probeId: string; prefix?: string;
}) {
  const props = Object.entries(schema.properties ?? {}).filter(([, s]) => !s.deprecated);
  if (!props.length) return <p className="muted tiny">No fields. Switch to JSON if needed.</p>;
  return (
    <div className={prefix ? "nested" : ""}>
      {schema.description && <p className="muted tiny">{schema.description}</p>}
      {props.map(([k, s]) => {
        const req = (schema.required ?? []).includes(k);
        if (s.type === "object" && s.properties) {
          return (
            <fieldset key={k} className="nested">
              <legend className="tiny">{k}{req ? " *" : ""}</legend>
              <ObjectFields schema={s} value={(value[k] as Record<string, unknown>) ?? {}} state={state} probeId={probeId} prefix={`${prefix}${k}.`}
                onChange={(v) => onChange({ ...value, [k]: v })} />
            </fieldset>
          );
        }
        return (
          <Field key={k} name={k} label={`${k}${req ? " *" : ""}`} schema={s} hint={s.description} value={value[k]}
            options={optionsFor(k, state, probeId)}
            onChange={(v) => {
              const next = { ...value };
              if (v === undefined || v === "") delete next[k];
              else next[k] = v;
              onChange(next);
            }} />
        );
      })}
    </div>
  );
}

function Field({ name, label, schema, hint, value, options, onChange }: {
  name: string; label: string; schema: JsonSchema; hint?: string; value: unknown; options: Opt[] | null; onChange: (v: unknown) => void;
}) {
  const t = schema.type;
  const coerce = (s: string): unknown => {
    if (s === "") return undefined;
    if (t === "integer" || t === "number") return Number(s);
    if (!t && (schema.oneOf || schema.anyOf) && /^\d+$/.test(s)) return Number(s);
    return s;
  };
  let input: React.ReactNode;
  if (options && options.length) {
    input = (
      <select value={value === undefined ? "" : String(value)} onChange={(e) => onChange(coerce(e.target.value))}>
        <option value="">—</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  } else if (schema.enum) {
    input = (
      <select value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : schema.enum!.find((x) => String(x) === e.target.value))}>
        <option value="">—</option>
        {schema.enum.map((x) => <option key={String(x)} value={String(x)}>{String(x)}</option>)}
      </select>
    );
  } else if (t === "boolean") {
    input = (
      <select value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "true")}>
        <option value="">—</option><option value="true">true</option><option value="false">false</option>
      </select>
    );
  } else if (t === "array" && schema.items?.enum) {
    const cur = (Array.isArray(value) ? value : []) as unknown[];
    input = (
      <div className="checks">
        {schema.items.enum.map((x) => (
          <label key={String(x)} className="tiny">
            <input type="checkbox" checked={cur.includes(x)} onChange={(e) => onChange(e.target.checked ? [...cur, x] : cur.filter((c) => c !== x))} /> {String(x)}
          </label>
        ))}
      </div>
    );
  } else if (t === "array") {
    input = (
      <input placeholder="comma-separated" value={Array.isArray(value) ? value.join(", ") : ""}
        onChange={(e) => {
          const parts = e.target.value.split(",").map((x) => x.trim()).filter(Boolean);
          const it = schema.items?.type;
          onChange(parts.length ? parts.map((x) => (it === "integer" || it === "number" ? Number(x) : x)) : undefined);
        }} />
    );
  } else if (t === "string" && (schema.maxLength ?? 0) > 200) {
    input = <textarea rows={4} value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value || undefined)} />;
  } else {
    input = (
      <input type={t === "integer" || t === "number" ? "number" : "text"} min={schema.minimum} max={schema.maximum}
        value={value === undefined ? "" : String(value)} onChange={(e) => onChange(coerce(e.target.value))} />
    );
  }
  return (
    <label className="field">
      <span className="tiny">{label}</span>
      {input}
      {hint && <span className="muted tiny">{hint}</span>}
      {name && null}
    </label>
  );
}

export type { ProbeView, Schemas };
