import { useEffect, useState } from "react";
import type { ApiLogEntry, PanelState } from "./types";
import { ago, until } from "./format";

export function SystemView({ state, now }: { state: PanelState; now: number }) {
  const { snapshot: s, rate } = state;
  const [log, setLog] = useState<ApiLogEntry[]>([]);
  const [onlyErrors, setOnlyErrors] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("panel-api/api-log").then((r) => r.json()).then((j) => alive && setLog(j.entries)).catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const shown = onlyErrors ? log.filter((e) => e.status === null || e.status >= 400) : log;
  return (
    <div className="pad">
      <div className="grid2">
        <div className="card">
          <strong>Game connection</strong>
          <Row k="Player" v={s.player ? `${s.player.displayName} (${s.player.username})` : "—"} />
          <Row k="API version" v={s.apiVersion ?? "—"} />
          <Row k="Last poll" v={`${ago(s.lastPollFinishedAt, now)} (${s.lastPollDurationMs ?? "—"} ms)`} />
          <Row k="Next poll" v={until(s.nextPollAt, now)} />
          <Row k="Polls since start" v={s.pollCount} />
          <button onClick={() => fetch("panel-api/refresh", { method: "POST" })}>Refresh now</button>{" "}
          <a className="button" href="panel-api/diagnostics" download>Download debug export</a>
          <p className="muted tiny">One JSON file with what the panel saw from the game and what it did (API calls, problems, automation, stations). The API key and panel password are removed. Send it when something looks wrong.</p>
        </div>
        <div className="card">
          <strong>Rate limit</strong>
          <Row k="Limit / window" v={rate.limit ?? "unknown yet"} />
          <Row k="Remaining" v={rate.remaining ?? "—"} />
          <Row k="Oldest request expires" v={rate.resetAt ? until(new Date(rate.resetAt).toISOString(), now) : "—"} />
          <Row k="Blocked (429)" v={rate.blockedUntil > now ? until(new Date(rate.blockedUntil).toISOString(), now) : "no"} />
          <Row k="429s since start" v={rate.total429} />
          <Row k="Queued" v={`${rate.queued.action} action · ${rate.queued.poll} poll`} />
        </div>
      </div>
      {s.globalErrors.length > 0 && (
        <div className="card warning">
          <strong>Errors on last poll</strong>
          <ul className="errs">
            {s.globalErrors.map((e, i) => (
              <li key={i}><code>{e.endpoint}</code> → {e.status} <code>{e.code}</code>: {e.message}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="card-h mt">
        <strong>API calls</strong>
        <label className="muted tiny"><input type="checkbox" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} /> errors only</label>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Call</th><th>Status</th><th>ms</th><th>Kind</th><th>Error</th></tr></thead>
          <tbody>
            {shown.map((e, i) => (
              <tr key={i} className={e.status === null || e.status >= 400 ? "warning" : ""}>
                <td className="tiny">{ago(e.at, now)}</td>
                <td><code>{e.method} {e.path}</code></td>
                <td>{e.status ?? "net"}</td>
                <td>{e.ms}</td>
                <td>{e.priority}</td>
                <td className="tiny">{e.errorCode ? `${e.errorCode}: ${e.errorMessage ?? ""}` : (e.errorMessage ?? "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="row"><span className="muted">{k}</span><span>{v}</span></div>;
}
