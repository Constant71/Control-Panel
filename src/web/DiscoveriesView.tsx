import { useEffect, useState } from "react";
import type { Discovery, PanelState, SectorScanInfo } from "./types";
import { ago } from "./format";

const ORDER: Record<string, number> = {
  dormant_construct: 0, new_blueprint: 1, blueprint_shared: 1, abandoned_manny: 2, detached_container: 3,
  drifting_item: 4, deuterium_refuel_station: 5, scut_relay: 6,
};

export function DiscoveriesView({ state, now }: { state: PanelState; now: number }) {
  const [data, setData] = useState<{ discoveries: Discovery[]; scans: SectorScanInfo[] } | null>(null);
  const [filter, setFilter] = useState<"blueprints" | "all" | "unread">("blueprints");
  const load = () => fetch("panel-api/discoveries").then((r) => r.json()).then(setData).catch(() => {});
  useEffect(() => {
    load();
  }, [state.snapshot.lastPollFinishedAt, state.unreadDiscoveries]);

  const markRead = async (keys: string[] | "all") => {
    await fetch("panel-api/discoveries/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys }) });
    load();
  };

  const all = data?.discoveries ?? [];
  const isBp = (d: Discovery) => d.kind === "dormant_construct" || d.kind === "new_blueprint" || d.kind === "blueprint_shared";
  const list = all
    .filter((d) => (filter === "blueprints" ? isBp(d) : filter === "unread" ? !d.read : true))
    .sort((a, b) => Number(a.read) - Number(b.read) || (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9) || b.firstSeenAt.localeCompare(a.firstSeenAt));
  const scans = data?.scans ?? [];
  const scanned = scans.filter((s) => s.scannedAt).length;

  return (
    <div className="pad">
      <div className="card-h">
        <div className="tabs small">
          {(["blueprints", "unread", "all"] as const).map((f) => (
            <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>
        <button className="tiny" onClick={() => markRead("all")}>Mark all read</button>
      </div>
      <p className="muted tiny">
        {scanned} of {scans.length} visited sectors scanned. Each one is rescanned in rotation. Dormant constructs are potential
        blueprints: inspecting one with a Manny unlocks a probe improvement.
      </p>
      {list.length === 0 && <p className="muted">Nothing here yet.</p>}
      {list.map((d) => (
        <div key={d.key} className={`card ${!d.read ? (isBp(d) ? "critical" : "info") : ""}`}>
          <div className="card-h">
            {!d.read && <span className="sev warning">new</span>}
            <strong>{d.title}</strong>
            {d.sector && <a className="tag" href="#/map">sector ({d.sector.x}, {d.sector.y}, {d.sector.z})</a>}
            {!d.present && <span className="tag">no longer seen</span>}
          </div>
          <p className="tiny">{d.detail}</p>
          <div className="row tiny">
            <span className="muted">First seen {ago(d.firstSeenAt, now)} · last seen {ago(d.lastSeenAt, now)}</span>
            {!d.read && <button className="tiny" onClick={() => markRead([d.key])}>Mark read</button>}
          </div>
        </div>
      ))}
      <details className="mt">
        <summary className="muted">Sector scan status</summary>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Sector</th><th>Scanned</th><th>Detail</th><th>Objects</th><th>Error</th></tr></thead>
            <tbody>
              {scans.map((s) => (
                <tr key={s.key}>
                  <td>({s.sector.x}, {s.sector.y}, {s.sector.z})</td>
                  <td>{ago(s.scannedAt, now)}</td>
                  <td>{s.knowledgeLevel?.replace(/_/g, " ") ?? "—"}</td>
                  <td>{s.objectCount}</td>
                  <td className="tiny">{s.error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
