import { useEffect, useState } from "react";
import type {
  AutoFixMode, AutomationAction, AutomationLogEntry, AutomationSettings, PanelState, PlannedRename, ProbeAutomationSettings, ProbeRole,
} from "./types";
import { ago } from "./format";

interface AutomationResponse {
  settings: AutomationSettings;
  plan: AutomationAction[];
  renames: PlannedRename[];
  renamedCount: number;
  log: AutomationLogEntry[];
}

const ROLES: ProbeRole[] = ["Probe", "Station", "Hauler", "Tanker", "Scout", "Miner"];
const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

export function AutomationView({ state, now }: { state: PanelState; now: number }) {
  const [data, setData] = useState<AutomationResponse | null>(null);
  const [tab, setTab] = useState<"rules" | "naming" | "log">("rules");
  const load = () => fetch("panel-api/automation").then((r) => r.json()).then(setData).catch(() => {});
  useEffect(() => {
    load();
  }, [state.snapshot.lastPollFinishedAt, state.automationMode]);

  if (!data) return <p className="pad muted">Loading…</p>;
  const s = data.settings;
  const save = async (patch: Partial<AutomationSettings>) => {
    await post("panel-api/automation/settings", patch);
    load();
  };
  const probeCfg = (id: number): ProbeAutomationSettings => {
    const p = s.probes[String(id)] ?? {};
    return { ...s.defaults, ...p, targets: { ...s.defaults.targets, ...(p.targets ?? {}) } };
  };
  const saveProbe = (id: number, patch: Partial<ProbeAutomationSettings>) => save({ probes: { [String(id)]: patch } } as Partial<AutomationSettings>);

  return (
    <div className="pad">
      <div className="card-h">
        <div className="tabs small">
          {(["rules", "naming", "log"] as const).map((t) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>
        <div className="mode">
          <span className="muted tiny">Automation</span>
          {(["auto", "dry_run", "off"] as AutoFixMode[]).map((m) => (
            <button key={m} className={s.mode === m ? "on" : ""} onClick={() => save({ mode: m })}>{m.replace("_", " ")}</button>
          ))}
        </div>
      </div>

      {tab === "rules" && (
        <>
          <div className="card">
            <strong>Next refresh will do ({data.plan.length})</strong>
            {data.plan.length === 0 && <p className="muted tiny">Nothing to do right now: targets met, no idle Mannies to spare, or no room for them to come back.</p>}
            <ul className="plain">
              {data.plan.map((a) => (
                <li key={a.id}>{a.label}<div className="muted tiny">{a.why} · <code>{a.endpoint}</code></div></li>
              ))}
            </ul>
          </div>
          <div className="card">
            <label className="row"><span>Inspect dormant constructs (unlocks blueprints)</span>
              <input type="checkbox" checked={s.inspectConstructs} onChange={(e) => save({ inspectConstructs: e.target.checked })} /></label>
          </div>
          <div className="cards">
            {state.snapshot.probes.map((p) => {
              const c = probeCfg(p.summary.id);
              return (
                <div key={p.summary.id} className="card">
                  <div className="card-h"><strong>{p.summary.name}</strong>{!p.summary.isReachable && <span className="tag">out of range</span>}</div>
                  <label className="row"><span>Keep Mannies mining</span>
                    <input type="checkbox" checked={c.mining} onChange={(e) => saveProbe(p.summary.id, { mining: e.target.checked })} /></label>
                  <NumRow label="Max Mannies mining" value={c.maxMiners} step={1} onSave={(v) => saveProbe(p.summary.id, { maxMiners: v })} />
                  <NumRow label="Keep idle for fixes" value={c.keepIdle} step={1} onSave={(v) => saveProbe(p.summary.id, { keepIdle: v })} />
                  <NumRow label="ECE per order" value={c.orderAmount} step={0.05} onSave={(v) => saveProbe(p.summary.id, { orderAmount: v })} />
                  <div className="muted tiny mt">Stock targets</div>
                  <NumRow label="Metals (ECE)" value={c.targets.metals} step={0.05} onSave={(v) => saveProbe(p.summary.id, { targets: { ...c.targets, metals: v } })} />
                  <NumRow label="Ice (ECE)" value={c.targets.ice} step={0.05} onSave={(v) => saveProbe(p.summary.id, { targets: { ...c.targets, ice: v } })} />
                  <NumRow label="Carbon (ECE)" value={c.targets.carbon_compounds} step={0.05} onSave={(v) => saveProbe(p.summary.id, { targets: { ...c.targets, carbon_compounds: v } })} />
                  <NumRow label="Deuterium (% tank)" value={c.targets.deuteriumPercent} step={5} onSave={(v) => saveProbe(p.summary.id, { targets: { ...c.targets, deuteriumPercent: v } })} />
                </div>
              );
            })}
          </div>
        </>
      )}

      {tab === "naming" && <Naming data={data} save={save} reload={load} probes={state.snapshot.probes.map((p) => p.summary)} />}

      {tab === "log" && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Action</th><th>Result</th></tr></thead>
            <tbody>
              {data.log.map((e, i) => (
                <tr key={i} className={e.ok ? "" : "warning"}>
                  <td className="tiny">{ago(e.at, now)}</td>
                  <td>{e.label}<div className="muted tiny"><code>{e.endpoint}</code></div></td>
                  <td className="tiny">{e.dryRun ? "dry run" : e.ok ? `ok (${e.status})` : `${e.status ?? "net"} ${e.code}: ${e.message}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.log.length && <p className="muted pad">Nothing done yet.</p>}
        </div>
      )}
    </div>
  );
}

function NumRow({ label, value, step, onSave }: { label: string; value: number; step: number; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <label className="row">
      <span className="muted">{label}</span>
      <input className="num" type="number" step={step} min={0} value={v} onChange={(e) => setV(e.target.value)}
        onBlur={() => Number(v) !== value && Number.isFinite(Number(v)) && onSave(Number(v))} />
    </label>
  );
}

function Naming({ data, save, reload, probes }: {
  data: AutomationResponse; save: (p: Partial<AutomationSettings>) => Promise<void>; reload: () => void;
  probes: Array<{ id: number; name: string }>;
}) {
  const s = data.settings;
  const locked = new Set(s.lockedNames);
  const toggleLock = (entity: string) => {
    const next = new Set(locked);
    if (next.has(entity)) next.delete(entity);
    else next.add(entity);
    save({ lockedNames: [...next] });
  };
  return (
    <>
      <div className="card">
        <label className="row"><strong>Automatic naming</strong>
          <input type="checkbox" checked={s.naming} onChange={(e) => save({ naming: e.target.checked })} /></label>
        <p className="muted tiny">
          Probes are named Role-NN (Station-Alpha for stations). Mannies get their probe's code plus a number (H03-M07). Containers are named
          from their routing rules: Core, Home · Mannies, Hand-off · Metals, Cargo · Ice. Up to 5 renames per refresh. Originals are kept so
          you can revert; locked names are never touched.
        </p>
        <div className="row">
          <span className="muted tiny">{data.renamedCount} renamed so far</span>
          <button disabled={!data.renamedCount} onClick={async () => {
            if (!window.confirm("Rename everything back to its original name and switch naming off?")) return;
            await post("panel-api/automation/revert-names", {});
            reload();
          }}>Revert all names</button>
        </div>
      </div>
      <div className="card">
        <strong>Probe roles</strong>
        <p className="muted tiny">The role sets the probe name and its Mannies' code.</p>
        {probes.map(({ id: pid, name }) => { const id = String(pid); return (
          <label key={id} className="row">
            <span>{name}</span>
            <select value={(s.probes[id]?.role ?? s.defaults.role) as string}
              onChange={(e) => save({ probes: { [id]: { role: e.target.value as ProbeRole } } } as Partial<AutomationSettings>)}>
              {ROLES.map((r) => <option key={r}>{r}</option>)}
            </select>
          </label>
        ); })}
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>What</th><th>Now</th><th>Will be</th><th>Lock</th></tr></thead>
          <tbody>
            {data.renames.map((r) => (
              <tr key={r.entity} className={r.locked ? "" : ""}>
                <td className="tiny">{r.kind}{!r.reachable && <div className="muted">waits: out of range</div>}</td>
                <td>{r.current}</td>
                <td>{r.locked ? <span className="muted">(locked)</span> : r.planned}</td>
                <td><input type="checkbox" checked={r.locked} onChange={() => toggleLock(r.entity)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.renames.length && <p className="muted pad">Every name already matches the scheme.</p>}
      </div>
    </>
  );
}
