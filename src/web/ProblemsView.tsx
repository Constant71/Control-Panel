import { useEffect, useState } from "react";
import type { AutoFixMode, FixAttemptState, FixLogEntry, FixOption, PanelState, Problem } from "./types";
import { ago, until } from "./format";

interface ProblemsResponse {
  mode: AutoFixMode;
  problems: Problem[];
  attempts: Record<string, FixAttemptState>;
  log: FixLogEntry[];
}

const MODE_TEXT: Record<AutoFixMode, string> = {
  auto: "Auto: safe fixes run on their own",
  dry_run: "Dry run: shows what it would do, sends nothing",
  off: "Off: nothing runs unless you press it",
};

export function ProblemsView({ state, now }: { state: PanelState; now: number }) {
  const [data, setData] = useState<ProblemsResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<FixLogEntry | null>(null);
  const [tab, setTab] = useState<"open" | "log">("open");

  const load = () => fetch("panel-api/problems").then((r) => r.json()).then(setData).catch(() => {});
  // Reload whenever the live state changes (new poll or fix run).
  useEffect(() => {
    load();
  }, [state.problems, state.fixMode]);

  const setMode = async (mode: AutoFixMode) => {
    await fetch("panel-api/fix-mode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) });
    load();
  };

  const run = async (p: Problem, f: FixOption) => {
    const message =
      f.mode === "confirm"
        ? `${f.label}\n\n${f.why}\n\nThis calls ${f.endpoint}. Go ahead?`
        : `Run now: ${f.label}?\n\nThis calls ${f.endpoint}.`;
    if (!window.confirm(message)) return;
    setBusy(f.id);
    try {
      const res = await fetch("panel-api/fix", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ problemKey: p.key, fixId: f.id }),
      }).then((r) => r.json());
      setToast(res.entry);
    } finally {
      setBusy(null);
      load();
    }
  };

  const problems = data?.problems ?? state.problems;
  const mode = data?.mode ?? state.fixMode;
  const counts = { critical: 0, warning: 0, info: 0 };
  problems.forEach((p) => counts[p.severity]++);

  return (
    <div className="pad">
      <div className="card-h">
        <div className="tabs small">
          <button className={tab === "open" ? "on" : ""} onClick={() => setTab("open")}>Open ({problems.length})</button>
          <button className={tab === "log" ? "on" : ""} onClick={() => setTab("log")}>Fix log</button>
        </div>
        <div className="mode">
          <span className="muted tiny">Auto-fix</span>
          {(["auto", "dry_run", "off"] as const).map((m) => (
            <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)} title={MODE_TEXT[m]}>{m.replace("_", " ")}</button>
          ))}
        </div>
      </div>
      <p className="muted tiny">{MODE_TEXT[mode]}. Confirm-only fixes always wait for you.</p>

      {toast && (
        <div className={`card ${toast.ok ? "" : "warning"}`} onClick={() => setToast(null)}>
          <strong>{toast.ok ? "Sent" : "Not done"}:</strong> {toast.label}
          {!toast.ok && <div className="tiny">{toast.code}: {toast.message}</div>}
        </div>
      )}

      {tab === "open" ? (
        <>
          <div className="kpis">
            <div className="kpi"><div className="kpi-v crit">{counts.critical}</div><div className="kpi-l">Critical</div></div>
            <div className="kpi"><div className="kpi-v warn">{counts.warning}</div><div className="kpi-l">Warnings</div></div>
            <div className="kpi"><div className="kpi-v">{counts.info}</div><div className="kpi-l">Info</div></div>
          </div>
          {problems.length === 0 && <p className="muted">Nothing is stuck. 🎉</p>}
          {problems.map((p) => (
            <ProblemCard key={p.key} p={p} attempts={data?.attempts ?? {}} log={data?.log ?? []} now={now} busy={busy} onRun={run} />
          ))}
        </>
      ) : (
        <FixLog log={data?.log ?? []} now={now} />
      )}
    </div>
  );
}

function ProblemCard({ p, attempts, log, now, busy, onRun }: {
  p: Problem; attempts: Record<string, FixAttemptState>; log: FixLogEntry[]; now: number; busy: string | null;
  onRun: (p: Problem, f: FixOption) => void;
}) {
  const last = log.find((e) => e.problemKey === p.key);
  const settle = attempts[`problem:${p.key}`];
  const settling = settle?.lastOk && new Date(settle.nextEligibleAt).getTime() > now;
  return (
    <div className={`card ${p.severity}`}>
      <div className="card-h">
        <span className={`sev ${p.severity}`}>{p.severity}</span>
        <strong>{p.title}</strong>
        {p.probeId !== null && <a className="tag" href={`#/probe/${p.probeId}`}>{p.probeName}</a>}
        {p.deadline && <span className={`countdown ${new Date(p.deadline).getTime() - now < 86_400_000 ? "crit" : ""}`}>game acts {until(p.deadline, now)}</span>}
      </div>
      {p.detail && <p className="tiny">{p.detail}</p>}
      {p.since && <div className="muted tiny">Since {ago(p.since, now)}</div>}
      {p.fixes.length > 0 && (
        <ul className="fixes">
          {p.fixes.map((f) => {
            const a = attempts[f.id];
            const waiting = a && new Date(a.nextEligibleAt).getTime() > now;
            return (
              <li key={f.id}>
                <div>
                  <span className={`tag ${f.mode}`}>{f.mode === "auto" ? "auto" : "needs you"}</span> {f.label}
                  <div className="muted tiny">{f.why}</div>
                  <div className="muted tiny"><code>{f.endpoint}</code></div>
                  {a && (
                    <div className={`tiny ${a.lastOk ? "ok-text" : "warn-text"}`}>
                      {a.lastOk ? "Sent" : `Failed ${a.failures}×`} {ago(a.lastAttemptAt, now)}
                      {waiting && f.mode === "auto" ? ` · next try ${until(a.nextEligibleAt, now)}` : ""}
                    </div>
                  )}
                </div>
                <button disabled={busy === f.id} onClick={() => onRun(p, f)}>{f.mode === "confirm" ? "Do it" : "Run now"}</button>
              </li>
            );
          })}
        </ul>
      )}
      {settling && last?.ok ? (
        <p className="advice tiny ok-text">
          {last.dryRun ? "Dry run" : "Sent"} {ago(last.at, now)}: {last.label}. Waiting for the game to update; checking again {until(settle.nextEligibleAt, now)}.
        </p>
      ) : (
        p.advice && <p className="advice tiny">{p.advice}</p>
      )}
      {last && !last.ok && <div className="warn-text tiny">Last attempt: {last.code}: {last.message}</div>}
      <div className="muted tiny">Detected from {p.source}</div>
    </div>
  );
}

function FixLog({ log, now }: { log: FixLogEntry[]; now: number }) {
  if (!log.length) return <p className="muted">No fixes attempted yet.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>When</th><th>Problem</th><th>Fix</th><th>By</th><th>Result</th></tr></thead>
        <tbody>
          {log.map((e, i) => (
            <tr key={i} className={e.ok ? "" : "warning"}>
              <td className="tiny">{ago(e.at, now)}</td>
              <td>{e.problemTitle}</td>
              <td>{e.label}<div className="muted tiny"><code>{e.endpoint}</code></div></td>
              <td>{e.initiator === "you" ? "you" : "auto"}</td>
              <td className="tiny">{e.dryRun ? "dry run" : e.ok ? `ok (${e.status})` : `${e.status ?? "net"} ${e.code ?? ""}: ${e.message ?? ""}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
