import { useEffect, useMemo, useState } from "react";
import { useLiveState } from "./useLiveState";
import type { PanelState, ProbeView, Schemas } from "./types";
import { probeFlags, mannyFlags, worst, isFullProbe, type Flag } from "../shared/attention";
import { ago, until, pct, ece, label } from "./format";
import { SectorMap } from "./SectorMap";
import { SystemView } from "./SystemView";
import { ProblemsView } from "./ProblemsView";
import { DiscoveriesView } from "./DiscoveriesView";
import { AutomationView } from "./AutomationView";

type Route =
  | { view: "fleet" } | { view: "probe"; id: number } | { view: "map" } | { view: "missions" } | { view: "system" }
  | { view: "problems" } | { view: "discoveries" } | { view: "automation" };

function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  const [v, id] = h.split("/");
  if (v === "probe" && id) return { view: "probe", id: Number(id) };
  if (v === "map" || v === "missions" || v === "system" || v === "problems" || v === "discoveries" || v === "automation") return { view: v };
  return { view: "fleet" };
}

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function App() {
  const { state, connected } = useLiveState();
  const [route, setRoute] = useState<Route>(parseHash);
  const now = useNow();
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#/">Probe Control</a>
        <nav>
          <a className={route.view === "fleet" || route.view === "probe" ? "on" : ""} href="#/">Fleet</a>
          <a className={route.view === "problems" ? "on" : ""} href="#/problems">
            Problems{state && <Badge n={state.problems.filter((p) => p.severity !== "info").length} sev={state.problems.some((p) => p.severity === "critical") ? "critical" : "warning"} />}
          </a>
          <a className={route.view === "discoveries" ? "on" : ""} href="#/discoveries">
            Discoveries{state && <Badge n={state.unreadDiscoveries} sev="info" />}
          </a>
          <a className={route.view === "automation" ? "on" : ""} href="#/automation">
            Automation{state && state.automationMode !== "auto" && <span className="badge warning">{state.automationMode === "off" ? "off" : "dry"}</span>}
          </a>
          <a className={route.view === "map" ? "on" : ""} href="#/map">Map</a>
          <a className={route.view === "missions" ? "on" : ""} href="#/missions">Missions</a>
          <a className={route.view === "system" ? "on" : ""} href="#/system">System</a>
        </nav>
        <StatusPill state={state} connected={connected} now={now} />
      </header>
      <main>
        {!state ? (
          <p className="muted pad">Connecting to the panel server…</p>
        ) : route.view === "fleet" ? (
          <Fleet state={state} now={now} />
        ) : route.view === "probe" ? (
          <ProbeDetail state={state} id={route.id} now={now} />
        ) : route.view === "map" ? (
          <SectorMap state={state} />
        ) : route.view === "problems" ? (
          <ProblemsView state={state} now={now} />
        ) : route.view === "discoveries" ? (
          <DiscoveriesView state={state} now={now} />
        ) : route.view === "automation" ? (
          <AutomationView state={state} now={now} />
        ) : route.view === "missions" ? (
          <Missions missions={state.snapshot.missions} />
        ) : (
          <SystemView state={state} now={now} />
        )}
      </main>
    </div>
  );
}

function Badge({ n, sev }: { n: number; sev: string }) {
  return n > 0 ? <span className={`badge ${sev}`}>{n}</span> : null;
}

function StatusPill({ state, connected, now }: { state: PanelState | null; connected: boolean; now: number }) {
  const s = state?.snapshot;
  const errs = s?.globalErrors.length ?? 0;
  const cls = !connected ? "critical" : errs ? "warning" : "ok";
  return (
    <a className={`pill ${cls}`} href="#/system" title="Panel status">
      {!connected ? "offline" : errs ? `${errs} API error${errs > 1 ? "s" : ""}` : "live"}
      <span className="muted"> · polled {ago(s?.lastPollFinishedAt, now)}</span>
    </a>
  );
}

function FlagList({ flags }: { flags: Flag[] }) {
  if (!flags.length) return null;
  return (
    <ul className="flags">
      {flags.map((f, i) => (
        <li key={i} className={f.severity} title={`From ${f.source}`}>
          {f.text}
        </li>
      ))}
    </ul>
  );
}

function Fleet({ state, now }: { state: PanelState; now: number }) {
  const { snapshot } = state;
  const totals = useMemo(() => {
    let mannies = 0, idle = 0, problems = 0;
    for (const p of snapshot.probes) {
      for (const m of p.mannies ?? []) {
        mannies++;
        if (m.currentTask === null) idle++;
        if (worst(mannyFlags(m, now)) === "critical" || worst(mannyFlags(m, now)) === "warning") problems++;
      }
      const w = worst(probeFlags(p.summary, p.detail, p.damageWarnings));
      if (w === "critical" || w === "warning") problems++;
    }
    return { mannies, idle, problems };
  }, [snapshot, now]);

  return (
    <div className="pad">
      <div className="kpis">
        <Kpi label="Probes" value={snapshot.probes.length} />
        <Kpi label="Mannies (reachable)" value={totals.mannies} />
        <Kpi label="Idle Mannies" value={totals.idle} tone={totals.idle ? "info" : undefined} />
        <Kpi label="Need attention" value={totals.problems} tone={totals.problems ? "warning" : undefined} />
        <Kpi label="Sectors visited" value={snapshot.visitedSectors.length} />
        <Kpi label="Active missions" value={snapshot.missions.filter((m) => m.status === "active").length} />
      </div>
      <div className="cards">
        {snapshot.probes.map((p) => (
          <ProbeCard key={p.summary.id} p={p} isDefault={p.summary.id === snapshot.defaultProbeId} now={now} />
        ))}
        {!snapshot.probes.length && <p className="muted">No probes loaded yet.</p>}
      </div>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className={`kpi ${tone ?? ""}`}>
      <div className="kpi-v">{value}</div>
      <div className="kpi-l">{label}</div>
    </div>
  );
}

function Bar({ value, max, tone }: { value: number; max: number; tone?: string }) {
  const w = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="bar">
      <div className={`bar-fill ${tone ?? ""}`} style={{ width: `${w}%` }} />
    </div>
  );
}

function ProbeCard({ p, isDefault, now }: { p: ProbeView; isDefault: boolean; now: number }) {
  const d = p.detail;
  const flags = probeFlags(p.summary, d, p.damageWarnings);
  const sev = worst(flags);
  const busy = (p.mannies ?? []).filter((m) => m.currentTask !== null).length;
  return (
    <a className={`card probe ${sev ?? ""}`} href={`#/probe/${p.summary.id}`}>
      <div className="card-h">
        <strong>{p.summary.name}</strong>
        {isDefault && <span className="tag">default</span>}
        <span className="tag">{label(p.summary.model)}</span>
        <span className={`status s-${d?.status ?? p.summary.status}`}>{label(d?.status ?? p.summary.status)}</span>
      </div>
      {isFullProbe(d) ? (
        <>
          <Row k="Sector" v={vec(d.sector?.relative)} />
          <Row k="Integrity" v={pct(d.systems?.integrityPercent)} />
          <Bar value={d.systems?.integrityPercent ?? 0} max={100} tone={(d.systems?.integrityPercent ?? 100) < 50 ? "warn" : "good"} />
          <Row k="Deuterium" v={`${round(d.fuel.deuterium)} / ${d.fuel.maxDeuterium ?? "?"}`} />
          <Bar value={d.fuel.deuterium} max={d.fuel.maxDeuterium ?? 100} tone="fuel" />
          {d.inventory && (
            <>
              <Row k="Storage" v={`${ece(d.inventory.usedCapacity)} / ${ece(d.inventory.capacity)}`} />
              <Bar value={d.inventory.usedCapacity} max={d.inventory.capacity} />
            </>
          )}
          {d.movement && d.movement.status !== "arrived" && (
            <Row k="Moving" v={`${label(d.movement.status)} → ${vec(d.movement.target)}, arrives ${until(d.movement.arrivalAt, now)}`} />
          )}
          <Row k="Mannies" v={p.mannies ? `${p.mannies.length} (${busy} busy)` : "—"} />
        </>
      ) : (
        <Row k="Sector" v={vec(d?.sector?.relative)} />
      )}
      <FlagList flags={flags} />
      {p.errors.length > 0 && <div className="err-note">{p.errors.length} read error(s) this poll</div>}
    </a>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="row">
      <span className="muted">{k}</span>
      <span>{v}</span>
    </div>
  );
}

function ProbeDetail({ state, id, now }: { state: PanelState; id: number; now: number }) {
  const p = state.snapshot.probes.find((x) => x.summary.id === id);
  const [tab, setTab] = useState<"mannies" | "storage" | "alerts" | "sector">("mannies");
  if (!p) return <p className="pad muted">Probe {id} not found.</p>;
  const d = p.detail;
  return (
    <div className="pad">
      <p><a href="#/">← Fleet</a></p>
      <div className="detail-top">
        <ProbeCard p={p} isDefault={p.summary.id === state.snapshot.defaultProbeId} now={now} />
        {p.errors.length > 0 && (
          <div className="card">
            <strong>Read errors on last poll</strong>
            <ul className="errs">
              {p.errors.map((e, i) => (
                <li key={i}><code>{e.endpoint}</code> → {e.status} <code>{e.code}</code>: {e.message}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {!p.summary.isReachable ? (
        <p className="muted">
          This probe is outside the default probe's sector and shared SCUT coverage. The API only returns its name, status and sector
          until it is back in reach.
        </p>
      ) : (
        <>
          <div className="tabs">
            {(["mannies", "storage", "alerts", "sector"] as const).map((t) => (
              <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>
            ))}
          </div>
          {tab === "mannies" && <MannyTable mannies={p.mannies ?? []} now={now} />}
          {tab === "storage" && isFullProbe(d) && <Storage inv={d.inventory} />}
          {tab === "alerts" && <Alerts alerts={p.alerts ?? []} warnings={p.damageWarnings ?? []} />}
          {tab === "sector" && <SectorView sector={p.sector} />}
        </>
      )}
    </div>
  );
}

function MannyTable({ mannies, now }: { mannies: Schemas["Manny"][]; now: number }) {
  const [filter, setFilter] = useState<"all" | "attention" | "idle" | "busy">("all");
  const rows = mannies
    .map((m) => ({ m, flags: mannyFlags(m, now) }))
    .filter(({ m, flags }) =>
      filter === "all" ? true
        : filter === "idle" ? m.currentTask === null
        : filter === "busy" ? m.currentTask !== null
        : flags.some((f) => f.severity !== "info"),
    )
    .sort((a, b) => rank(worst(b.flags)) - rank(worst(a.flags)));
  return (
    <>
      <div className="tabs small">
        {(["all", "attention", "idle", "busy"] as const).map((f) => (
          <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f}</button>
        ))}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Name</th><th>Task</th><th>Progress</th><th>Ends</th><th>Where</th><th>Cargo</th><th>Orders</th><th>Flags</th></tr>
          </thead>
          <tbody>
            {rows.map(({ m, flags }) => (
              <tr key={m.id} className={worst(flags) ?? ""}>
                <td><strong>{m.name}</strong><div className="muted tiny">{m.id}</div></td>
                <td>{label(m.currentTask)}</td>
                <td>{m.currentTask ? <><Bar value={m.taskProgressPercent} max={100} /> {pct(m.taskProgressPercent)}</> : "—"}</td>
                <td>{until(m.taskEstimatedEndTime, now)}</td>
                <td>{m.location.type === "probe" ? "on probe" : `sector ${vec(m.location.sector?.relative)}`}</td>
                <td className="tiny">{cargo(m.cargo)}</td>
                <td>{m.canReceiveOrders ? "yes" : "no"}</td>
                <td><FlagList flags={flags.filter((f) => f.code !== "idle")} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && <p className="muted">No Mannies match.</p>}
    </>
  );
}

function Storage({ inv }: { inv: Schemas["ProbeInventory"] | undefined }) {
  if (!inv) return <p className="muted">No inventory data.</p>;
  return (
    <div className="grid2">
      <div className="card">
        <strong>Containers</strong>
        {inv.containers.map((c) => (
          <div key={c.id}>
            <Row k={c.label} v={`${ece(c.usedCapacity)} / ${ece(c.capacity)}`} />
            <Bar value={c.usedCapacity} max={c.capacity} tone={c.freeCapacity <= c.capacity * 0.05 ? "warn" : undefined} />
          </div>
        ))}
        {inv.externalTanks.map((t) => (
          <div key={t.id}>
            <Row k={t.name} v={pct(t.fillPercent)} />
            <Bar value={t.fillPercent} max={100} tone="fuel" />
          </div>
        ))}
      </div>
      <div className="card">
        <strong>Resources</strong>
        {inv.resourceStocks.map((r) => <Row key={r.id} k={r.name} v={ece(r.amount)} />)}
        <strong className="mt">Items</strong>
        {inv.items.length === 0 && <p className="muted">None</p>}
        {inv.items.map((it) => {
          const item = it as Schemas["ProbeInventoryItem"] & { name?: string; quantity?: number };
          return <Row key={item.id} k={item.name ?? item.id} v={item.quantity ?? ""} />;
        })}
      </div>
    </div>
  );
}

function Alerts({ alerts, warnings }: { alerts: Schemas["ProbeDamageWarning"][]; warnings: Schemas["ProbeDamageWarning"][] }) {
  const all = [...alerts.map((a) => ({ kind: "alert", a })), ...warnings.map((a) => ({ kind: "damage warning", a }))];
  if (!all.length) return <p className="muted">No alerts or damage warnings.</p>;
  return (
    <div className="list">
      {all.map(({ kind, a }) => {
        const x = a as Schemas["ProbeDamageWarning"] & { id?: number; status?: string; message?: string; type?: string };
        return (
          <div key={kind + x.id} className={`card ${x.status === "unread" ? "warning" : ""}`}>
            <div className="card-h"><span className="tag">{kind}</span><span className="tag">{label(x.type)}</span><span className="muted">{x.status}</span></div>
            <p>{x.message}</p>
          </div>
        );
      })}
    </div>
  );
}

function SectorView({ sector }: { sector: Schemas["SectorObservation"] | null }) {
  if (!sector) return <p className="muted">No sector observation (the probe may be moving).</p>;
  const objects = (sector.objects ?? []) as Array<Record<string, unknown>>;
  return (
    <div className="card">
      <Row k="Coordinates" v={vec(sector.relativeCoordinates)} />
      <Row k="Knowledge" v={`${label(sector.knowledgeLevel)} (${Math.round(sector.confidence * 100)}% confidence)`} />
      <Row k="SCUT coverage" v={label(sector.scutCoverageStatus)} />
      <strong className="mt">Objects ({objects.length})</strong>
      <ul className="objects">
        {objects.map((o, i) => (
          <li key={String(o.id ?? i)}>
            <span className="tag">{label(String(o.type ?? "object"))}</span> {String(o.name ?? o.id ?? "")}
            {o.summary ? <span className="muted"> — {String(o.summary)}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Missions({ missions }: { missions: Schemas["Mission"][] }) {
  if (!missions.length) return <p className="pad muted">No active missions.</p>;
  return (
    <div className="pad list">
      {missions.map((m) => (
        <div key={m.id} className="card">
          <div className="card-h"><strong>{m.title}</strong><span className="tag">{m.status}</span><span className="tag">{m.stepOrder}</span></div>
          {m.description && <p>{m.description}</p>}
          <ol>
            {m.steps.slice().sort((a, b) => a.sortOrder - b.sortOrder).map((s) => (
              <li key={s.id} className={`step ${s.status}`}>{s.title} <span className="muted">({s.status})</span></li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

const rank = (s: string | null) => (s === "critical" ? 3 : s === "warning" ? 2 : s === "info" ? 1 : 0);
const round = (n: number) => Math.round(n * 10) / 10;
export const vec = (v: { x: number; y: number; z: number } | undefined | null) => (v ? `(${v.x}, ${v.y}, ${v.z})` : "—");
const cargo = (c: Schemas["MannyCargo"]) => {
  const parts = [
    ["D", c.deuterium], ["M", c.metals], ["I", c.ice], ["O", c.organicCompounds],
  ].filter(([, v]) => (v as number) > 0).map(([k, v]) => `${k} ${(v as number).toFixed(3)}`);
  return parts.length ? parts.join(" · ") : "empty";
};
