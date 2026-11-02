import { useEffect, useMemo, useState } from "react";
import { useLiveState } from "./useLiveState";
import type { Discovery, PanelState, ProbeView, SectorScanInfo } from "./types";
import type { GoalStatus, Suggestion } from "../shared/crafting";
import type { StationStatus } from "../shared/stations";
import { probeFlags, mannyFlags, worst, isFullProbe, type Severity } from "../shared/attention";
import { describeManny, describeProbe } from "../shared/activity";
import { ago, until, pct, label } from "./format";
import "./tv.css";

/**
 * View-only wall/TV dashboard (layout "grid of tiles", designed for 1920×1080).
 * Open /tv (or #/tv) in a kiosk browser. Everything here comes from the same
 * panel endpoints the main pages use; nothing on this page sends orders.
 */

const PAGE_SECONDS = 15;
const VERSION_CHECK_MS = 5 * 60_000;

interface CraftingData {
  statuses: GoalStatus[];
  suggestions: Suggestion[];
  holds: Array<{ probeId: number; mannyId: string; until: string | null }>;
}

const STEP_TEXT: Record<string, string> = {
  starting: "ordering", in_progress: "crafting", needs_ingredients: "needs parts", needs_resources: "needs resources",
  needs_manny: "waiting for a Manny", printer_busy: "printer busy", no_printer: "no printer", no_room: "no room", no_recipe: "no recipe",
};
const RES_SHORT: Record<string, string> = { metals: "Metals", ice: "Ice", carbon_compounds: "Carbon" };
const sevRank = (s: Severity | null | undefined) => (s === "critical" ? 3 : s === "warning" ? 2 : s === "info" ? 1 : 0);
const num = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n >= 100 ? Math.round(n).toString() : (+n.toFixed(1)).toString());
const vec = (v: { x: number; y: number; z: number } | null | undefined) => (v ? `${v.x}, ${v.y}, ${v.z}` : "—");
const hours = (s: number) => (s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : `${+(s / 3600).toFixed(1)} h`);

/** Refetches a panel endpoint each time a new poll lands (same pattern as the Builds page). */
function usePanelData<T>(url: string, key: unknown): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    fetch(url).then((r) => (r.ok ? r.json() : null)).then((d) => d && setData(d)).catch(() => {});
  }, [url, key]);
  return data;
}

function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Reloads the page when the server comes back as a new version (auto-deploy), so the TV never runs stale code. */
function useReloadOnNewVersion() {
  useEffect(() => {
    let first: string | null = null;
    const check = () =>
      fetch("panel-api/health").then((r) => r.json()).then((h: { version?: string; startedAt?: string }) => {
        const v = `${h.version}|${h.startedAt}`;
        if (first === null) first = v;
        else if (v !== first) location.reload();
      }).catch(() => {});
    check();
    const t = setInterval(check, VERSION_CHECK_MS);
    return () => clearInterval(t);
  }, []);
}

export function TvView() {
  const { state, connected } = useLiveState();
  const now = useNow(1000);
  useReloadOnNewVersion();
  if (!state) return <div className="tv tv-wait">Connecting to the panel…</div>;
  return <TvBoard state={state} connected={connected} now={now} />;
}

function TvBoard({ state, connected, now }: { state: PanelState; connected: boolean; now: number }) {
  const key = state.snapshot.lastPollFinishedAt;
  const crafting = usePanelData<CraftingData>("panel-api/crafting", key);
  const stations = usePanelData<{ stations: StationStatus[] }>("panel-api/stations", key);
  const discoveries = usePanelData<{ discoveries: Discovery[]; scans: SectorScanInfo[] }>("panel-api/discoveries", `${key}|${state.unreadDiscoveries}`);

  return (
    <div className="tv">
      <TvHeader state={state} connected={connected} now={now} />
      <div className="tv-body">
        <ProbeGrid state={state} now={now} />
        <aside className="tv-side">
          <AlertsPanel state={state} now={now} />
          <StockPanel state={state} stations={stations?.stations ?? null} />
          <BuildsPanel state={state} data={crafting} now={now} />
          <DiscoveriesPanel data={discoveries?.discoveries ?? null} now={now} />
        </aside>
      </div>
    </div>
  );
}

function TvHeader({ state, connected, now }: { state: PanelState; connected: boolean; now: number }) {
  const s = state.snapshot;
  let mannies = 0, busy = 0;
  for (const p of s.probes) for (const m of p.mannies ?? []) { mannies++; if (m.currentTask !== null) busy++; }
  const crit = state.problems.filter((p) => p.severity === "critical").length;
  const warn = state.problems.filter((p) => p.severity === "warning").length;
  const errs = s.globalErrors.length;
  const clock = new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <header className="tv-head">
      <div className="tv-brand">Probe Control</div>
      <Stat v={s.probes.length} l="probes" />
      <Stat v={`${busy}/${mannies}`} l="Mannies busy" />
      <Stat v={crit} l="critical" tone={crit ? "critical" : undefined} />
      <Stat v={warn} l="warnings" tone={warn ? "warning" : undefined} />
      <Stat v={state.readySuggestions ?? 0} l="builds ready" tone={state.readySuggestions ? "info" : undefined} />
      <Stat v={state.unreadDiscoveries} l="new discoveries" tone={state.unreadDiscoveries ? "info" : undefined} />
      {state.automationMode !== "auto" && <Stat v={state.automationMode.replace("_", " ")} l="automation" tone="warning" />}
      <div className="tv-spacer" />
      <div className={`tv-live ${!connected ? "critical" : errs ? "warning" : "ok"}`}>
        {!connected ? "offline" : errs ? `${errs} API error${errs > 1 ? "s" : ""}` : "live"}
        <span> · polled {ago(s.lastPollFinishedAt, now)}</span>
      </div>
      <div className="tv-clock">{clock}</div>
    </header>
  );
}

function Stat({ v, l, tone }: { v: number | string; l: string; tone?: string }) {
  return (
    <div className={`tv-stat ${tone ?? ""}`}>
      <b>{v}</b>
      <span>{l}</span>
    </div>
  );
}

/* ───────────── Probe tiles ───────────── */

function ProbeGrid({ state, now }: { state: PanelState; now: number }) {
  const probes = useMemo(() => {
    return state.snapshot.probes
      .map((p) => {
        const flags = [...probeFlags(p.summary, p.detail, p.damageWarnings), ...(p.mannies ?? []).flatMap((m) => mannyFlags(m, now))];
        return { p, sev: worst(flags.filter((f) => f.code !== "idle")) };
      })
      // Probes that need attention come first, so they are always on the first page.
      .sort((a, b) => sevRank(b.sev) - sevRank(a.sev) || a.p.summary.name.localeCompare(b.p.summary.name));
    // Recompute once per poll, not every second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.snapshot]);

  const n = probes.length;
  // 1–3 probes side by side (tall tiles show each Manny); more probes go into a square-ish grid, at most 4×4 per page.
  const cols = n <= 3 ? Math.max(1, n) : Math.min(4, Math.ceil(Math.sqrt(n)));
  const rows = Math.min(4, Math.max(1, Math.ceil(n / cols)));
  const perPage = cols * rows;
  const pages = Math.max(1, Math.ceil(n / perPage));
  const page = Math.floor(now / 1000 / PAGE_SECONDS) % pages;
  const shown = probes.slice(page * perPage, page * perPage + perPage);

  return (
    <section className="tv-grid-wrap">
      <div className="tv-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)` }}>
        {shown.map(({ p, sev }) => <ProbeTile key={p.summary.id} p={p} sev={sev} state={state} now={now} />)}
        {!n && <div className="tv-empty">No probes loaded yet.</div>}
      </div>
      {pages > 1 && (
        <div className="tv-pages">
          {Array.from({ length: pages }, (_, i) => <span key={i} className={i === page ? "on" : ""} />)}
          <span className="tv-pages-l">probes {page * perPage + 1}–{Math.min(n, (page + 1) * perPage)} of {n}</span>
        </div>
      )}
    </section>
  );
}

function roleOf(state: PanelState, id: number): string | null {
  if ((state.stationIds ?? []).includes(id)) return "Station";
  const m = state.stationMembers?.[String(id)];
  return m?.role === "StationTanker" ? "Station Tanker" : m?.role ?? null;
}

function ProbeTile({ p, sev, state, now }: { p: ProbeView; sev: Severity | null; state: PanelState; now: number }) {
  const d = p.detail;
  const status = d?.status ?? p.summary.status;
  const role = roleOf(state, p.summary.id);
  const isDefault = p.summary.id === state.snapshot.defaultProbeId;
  const flags = [...probeFlags(p.summary, d, p.damageWarnings), ...(p.mannies ?? []).flatMap((m) => mannyFlags(m, now))]
    .filter((f) => f.severity !== "info")
    .sort((a, b) => sevRank(b.severity) - sevRank(a.severity));
  const mannies = p.mannies ?? [];
  const busy = mannies.filter((m) => m.currentTask !== null).length;
  const unreadAlerts = (p.alerts ?? []).filter((a) => a.status === "unread").length;

  return (
    <div className={`tv-tile ${sev ?? ""}`}>
      <div className="tv-tile-h">
        <strong>{p.summary.name}</strong>
        {role && <span className="tv-tag">{role}</span>}
        {isDefault && <span className="tv-tag">default</span>}
        <span className={`tv-status s-${status}`}>{label(status)}</span>
      </div>
      {isFullProbe(d) ? (
        <>
          <div className="tv-meters">
            <Meter l="Integrity" v={d.systems?.integrityPercent ?? null} max={100} text={pct(d.systems?.integrityPercent)}
              tone={(d.systems?.integrityPercent ?? 100) < 50 ? "warn" : "good"} />
            <Meter l="Deuterium" v={d.fuel.deuterium} max={d.fuel.maxDeuterium ?? 0} text={`${num(d.fuel.deuterium)}/${d.fuel.maxDeuterium ?? "?"}`} tone="fuel" />
            {d.inventory && (
              <Meter l="Storage" v={d.inventory.usedCapacity} max={d.inventory.capacity}
                text={`${num(d.inventory.usedCapacity)}/${num(d.inventory.capacity)}`}
                tone={d.inventory.freeCapacity <= d.inventory.capacity * 0.05 ? "warn" : undefined} />
            )}
          </div>
          {d.inventory && d.inventory.resourceStocks.length > 0 && (
            <div className="tv-res">
              {d.inventory.resourceStocks.map((r) => <span key={r.id}>{RES_SHORT[r.type] ?? r.name} <b>{num(r.amount)}</b></span>)}
            </div>
          )}
          <div className="tv-doing">{describeProbe(d, now).summary}</div>
          <div className="tv-line">
            <span>Sector {vec(d.sector?.relative)}</span>
            {d.movement && d.movement.status !== "arrived" && <span>arrives {until(d.movement.arrivalAt, now)}</span>}
            <span>Mannies {mannies.length ? `${busy}/${mannies.length} busy` : "—"}</span>
            {unreadAlerts > 0 && <span className="tv-warn-t">{unreadAlerts} unread alert{unreadAlerts > 1 ? "s" : ""}</span>}
          </div>
          <MannyList p={p} state={state} now={now} />
        </>
      ) : (
        <div className="tv-line">
          <span>Sector {vec(d?.sector?.relative)}</span>
          <span className="tv-dim">Out of SCUT range: only name, status and sector are available.</span>
        </div>
      )}
      {flags.length > 0 && (
        <ul className="tv-flags">
          {flags.slice(0, 2).map((f, i) => <li key={i} className={f.severity}>{f.text}</li>)}
          {flags.length > 2 && <li className="tv-dim">+{flags.length - 2} more</li>}
        </ul>
      )}
    </div>
  );
}

/** Each Manny's task, worst first. Shown as far as the tile has room; the rest fades out. */
function MannyList({ p, state, now }: { p: ProbeView; state: PanelState; now: number }) {
  const mannies = p.mannies ?? [];
  if (!mannies.length) return null;
  const ctx = {
    objects: (p.sector?.objects ?? []) as Array<Record<string, unknown>>, probeName: p.summary.name, now,
    probes: state.snapshot.probes.map((x) => ({ id: x.summary.id, name: x.summary.name })),
  };
  const rows = mannies
    .map((m) => ({ m, sev: worst(mannyFlags(m, now).filter((f) => f.code !== "idle")) }))
    .sort((a, b) => sevRank(b.sev) - sevRank(a.sev) || Number(b.m.currentTask !== null) - Number(a.m.currentTask !== null) || a.m.name.localeCompare(b.m.name));
  return (
    <div className="tv-mannies">
      {rows.map(({ m, sev }) => (
        <div key={m.id} className={`tv-manny ${sev ?? ""} ${m.currentTask === null ? "idle" : ""}`}>
          <span className="tv-manny-n">{m.name}</span>
          <span className="tv-manny-t">{describeManny(m, ctx).summary}</span>
          {m.currentTask !== null && <span className="tv-manny-p">{pct(m.taskProgressPercent)}</span>}
        </div>
      ))}
    </div>
  );
}

function Meter({ l, v, max, text, tone }: { l: string; v: number | null; max: number; text: string; tone?: string }) {
  const w = v !== null && max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0;
  return (
    <div className="tv-meter">
      <div className="tv-meter-h"><span>{l}</span><b>{text}</b></div>
      <div className="tv-bar"><div className={`tv-bar-fill ${tone ?? ""}`} style={{ width: `${w}%` }} /></div>
    </div>
  );
}

/* ───────────── Side panels ───────────── */

function Panel({ title, count, tone, grow, children }: { title: string; count?: number; tone?: string; grow: number; children: React.ReactNode }) {
  return (
    <section className={`tv-panel ${grow ? "" : "fit"}`} style={grow ? { flexGrow: grow } : undefined}>
      <h2>
        {title}
        {count !== undefined && <span className={`tv-count ${count ? tone ?? "" : ""}`}>{count}</span>}
      </h2>
      <div className="tv-panel-body">{children}</div>
    </section>
  );
}

interface AlertRow { key: string; sev: Severity; title: string; who: string | null; at: string | null; tag: string }

function AlertsPanel({ state, now }: { state: PanelState; now: number }) {
  const rows: AlertRow[] = [
    ...state.problems.map((p) => ({
      key: p.key, sev: p.severity, title: p.title, tag: p.fixes.some((f) => f.mode === "auto") ? "auto-fixing" : "problem",
      who: [p.probeName, p.mannyName].filter(Boolean).join(" · ") || null, at: p.since,
    })),
    // Unread in-game alerts (GET /api/probe/{probeId}/alerts) are shown too: they aren't all problems.
    ...state.snapshot.probes.flatMap((v) =>
      (v.alerts ?? []).filter((a) => a.status === "unread").map((a) => ({
        key: `alert:${v.summary.id}:${a.id}`, sev: "info" as Severity, title: a.message, tag: label(a.type),
        who: v.summary.name, at: a.scheduledAt,
      })),
    ),
  ].sort((a, b) => sevRank(b.sev) - sevRank(a.sev) || (b.at ?? "").localeCompare(a.at ?? ""));
  const serious = rows.filter((r) => r.sev !== "info").length;
  return (
    <Panel title="Alerts" count={rows.length} tone={state.problems.some((p) => p.severity === "critical") ? "critical" : serious ? "warning" : "info"} grow={4}>
      {!rows.length && <div className="tv-ok">All clear. No problems or unread alerts.</div>}
      {rows.map((r) => (
        <div key={r.key} className={`tv-item ${r.sev}`}>
          <div className="tv-item-t">{r.title}</div>
          <div className="tv-item-s">
            <span className="tv-tag">{r.tag}</span>
            {r.who && <span>{r.who}</span>}
            {r.at && <span>{ago(r.at, now)}</span>}
          </div>
        </div>
      ))}
    </Panel>
  );
}

function StockPanel({ state, stations }: { state: PanelState; stations: StationStatus[] | null }) {
  const totals = new Map<string, number>();
  let deut = 0, deutMax = 0, seen = 0;
  for (const v of state.snapshot.probes) {
    const d = v.detail;
    if (!isFullProbe(d)) continue;
    seen++;
    for (const r of d.inventory?.resourceStocks ?? []) totals.set(r.type, (totals.get(r.type) ?? 0) + r.amount);
    deut += d.fuel.deuterium;
    deutMax += d.fuel.maxDeuterium ?? 0;
  }
  return (
    <Panel title="Stock" grow={0}>
      <div className="tv-sub">Fleet total ({seen} reachable probe{seen === 1 ? "" : "s"})</div>
      <div className="tv-res big">
        {(["metals", "ice", "carbon_compounds"] as const).map((k) => <span key={k}>{RES_SHORT[k]} <b>{num(totals.get(k) ?? 0)}</b></span>)}
        <span>Deuterium <b>{num(deut)}</b>{deutMax ? <i>/{num(deutMax)}</i> : null}</span>
      </div>
      {(stations ?? []).map((st) => (
        <div key={st.probeId} className="tv-station">
          <div className="tv-sub">{st.name} <span className="tv-dim">station targets</span></div>
          <div className="tv-targets">
            {st.targets.map((t) => (
              <span key={t.key} className={t.short > 0 ? "short" : "met"}>
                {t.label} <b>{num(t.have)}</b><i>/{num(t.min)}</i>
              </span>
            ))}
            {!st.targets.length && <span className="tv-dim">No stock targets set.</span>}
          </div>
        </div>
      ))}
    </Panel>
  );
}

function BuildsPanel({ state, data, now }: { state: PanelState; data: CraftingData | null; now: number }) {
  const name = (id: number) => state.snapshot.probes.find((v) => v.summary.id === id)?.summary.name ?? `Probe ${id}`;
  const ready = (data?.suggestions ?? []).filter((s) => s.ready && s.kind !== "move_probe");
  const goals = (data?.statuses ?? []).filter((g) => !g.done);
  const holds = data?.holds ?? [];
  const count = ready.length + goals.length + holds.length;
  return (
    <Panel title="Builds & crafting" count={count} tone={ready.length ? "info" : undefined} grow={2}>
      {!data && <div className="tv-dim">Loading…</div>}
      {data && !count && <div className="tv-dim">Nothing queued.</div>}
      {ready.map((s) => (
        <div key={s.id} className="tv-item info">
          <div className="tv-item-t">{s.title}</div>
          <div className="tv-item-s"><span className="tv-tag">waiting for your OK</span><span>{s.probeName}</span></div>
        </div>
      ))}
      {holds.map((h) => {
        const m = state.snapshot.probes.find((v) => v.summary.id === h.probeId)?.mannies?.find((x) => x.id === h.mannyId);
        return (
          <div key={h.mannyId} className="tv-item">
            <div className="tv-item-t">Assembling at {name(h.probeId)}</div>
            <div className="tv-item-s"><span>{m?.name ?? h.mannyId}</span><span>done {until(h.until, now)}</span></div>
          </div>
        );
      })}
      {goals.map((g) => {
        const step = g.steps.find((s) => s.status === "in_progress" || s.status === "starting") ?? g.steps[0];
        const stuck = step && step.status !== "in_progress" && step.status !== "starting" && step.status !== "needs_ingredients";
        return (
          <div key={`${g.probeId}:${g.goal.id}`} className={`tv-item ${stuck ? "warning" : ""}`}>
            <div className="tv-item-t">
              {label(g.goal.item)} <span className="tv-dim">{g.have}/{g.goal.quantity}{g.inProgress ? ` (+${g.inProgress} in progress)` : ""}</span>
            </div>
            <div className="tv-item-s">
              <span>{name(g.probeId)}</span>
              {step && <span>{step.name}: {STEP_TEXT[step.status] ?? label(step.status)}</span>}
              {g.workSeconds > 0 && <span>{hours(g.workSeconds)} of work left</span>}
            </div>
          </div>
        );
      })}
    </Panel>
  );
}

const BLUEPRINT_KINDS = new Set(["dormant_construct", "new_blueprint", "blueprint_shared"]);

function DiscoveriesPanel({ data, now }: { data: Discovery[] | null; now: number }) {
  const list = (data ?? [])
    .filter((d) => d.present)
    .sort((a, b) => Number(a.read) - Number(b.read) || Number(BLUEPRINT_KINDS.has(b.kind)) - Number(BLUEPRINT_KINDS.has(a.kind)) || b.firstSeenAt.localeCompare(a.firstSeenAt));
  const unread = list.filter((d) => !d.read).length;
  return (
    <Panel title="Discoveries" count={unread} tone="info" grow={2}>
      {!data && <div className="tv-dim">Loading…</div>}
      {data && !list.length && <div className="tv-dim">Nothing found yet.</div>}
      {list.map((d) => (
        <div key={d.key} className={`tv-item ${!d.read ? "info" : ""} ${BLUEPRINT_KINDS.has(d.kind) ? "bp" : ""}`}>
          <div className="tv-item-t">{d.title}</div>
          <div className="tv-item-s">
            <span className="tv-tag">{label(d.kind)}</span>
            {!d.read && <span className="tv-new">new</span>}
            {d.sector && <span>sector {vec(d.sector)}</span>}
            <span>{ago(d.firstSeenAt, now)}</span>
          </div>
        </div>
      ))}
    </Panel>
  );
}

