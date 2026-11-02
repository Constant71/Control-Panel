import { useEffect, useState } from "react";
import type { PanelState, AutomationLogEntry, AutoFixMode } from "./types";
import type { Suggestion } from "../shared/crafting";
import type { ExploreStatus } from "../shared/exploration";
import { SuggestionCard } from "./BuildsView";

interface ExplorationResponse {
  mode: AutoFixMode;
  status: ExploreStatus[];
  suggestions: Suggestion[];
}

const STATE_TEXT: Record<ExploreStatus["state"], string> = {
  dwelling: "working sector", recalling: "calling Mannies home", moving: "moving", needs_you: "needs you", blocked: "waiting", waiting: "waiting",
};

/** Exploration status and move cards, shown under the sector map. */
export function ExplorationPanel({ state }: { state: PanelState }) {
  const [data, setData] = useState<ExplorationResponse | null>(null);
  const [toast, setToast] = useState<AutomationLogEntry | null>(null);
  const load = () => fetch("panel-api/exploration").then((r) => r.json()).then(setData).catch(() => {});
  useEffect(() => {
    load();
  }, [state.snapshot.lastPollFinishedAt]);
  if (!data) return null;

  const confirm = async (s: Suggestion) => {
    const msg = [s.title, "", ...s.why.map((w) => `• ${w}`), "", "Risks:", ...s.risks.map((r) => `• ${r}`), "", `This calls ${s.endpoint}. Go ahead?`].join("\n");
    if (!window.confirm(msg)) return;
    const res = await fetch("panel-api/suggestions/confirm", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: s.id }),
    }).then((r) => r.json());
    setToast(res.entry);
    load();
  };

  return (
    <div className="card mt">
      <strong>Exploration</strong>
      <p className="muted tiny">
        Turn exploring on per probe on the Automation page. An explorer works each sector for a while, inspects dormant constructs,
        calls its Mannies home, then hops to the best unvisited neighbour. Moves that keep it in command range run on their own.
        Moves that would leave range, or into a sector the scan flags as dangerous, wait for you here.
      </p>
      {data.mode !== "auto" && <p className="warn-text tiny">Automation is in {data.mode.replace("_", " ")} mode, so automatic moves are not sent.</p>}
      {toast && (
        <div className={`card ${toast.ok ? "" : "warning"}`} onClick={() => setToast(null)}>
          <strong>{toast.ok ? "Sent" : "Not done"}:</strong> {toast.label}
          {!toast.ok && <div className="tiny">{toast.message}</div>}
        </div>
      )}
      {data.status.length === 0 && <p className="muted">No probe is set to explore.</p>}
      <ul className="plain">
        {data.status.map((s) => (
          <li key={s.probeId}>
            <a href={`#/probe/${s.probeId}`}><b>{s.probeName}</b></a> <span className={`tag ex-${s.state}`}>{STATE_TEXT[s.state]}</span> <span className="tiny">{s.text}</span>
            {s.candidates.length > 0 && (
              <details className="tiny">
                <summary>Neighbours considered ({s.candidates.length})</summary>
                <ul className="plain">
                  {s.candidates.map((c) => (
                    <li key={`${c.target.x},${c.target.y},${c.target.z}`}>
                      ({c.target.x}, {c.target.y}, {c.target.z}) score {c.score}{c.safe ? "" : " · flagged"} <span className="muted">{c.notes.join(" ")}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ul>
      {data.suggestions.map((s) => <SuggestionCard key={s.id} s={s} onConfirm={confirm} onQueue={() => {}} />)}
    </div>
  );
}
