import { useState } from "react";
import type { PanelState, ProbeView, Schemas } from "./types";
import type { Operation } from "../shared/operations";
import { callOp, useOperations } from "./api";
import { OpForm } from "./ConsoleView";
import { isFullProbe } from "../shared/attention";
import { mannyOps, probeOps } from "../shared/controls";

/**
 * Manual controls on the probe page: every call in the spec that acts on this probe or one of its
 * Mannies, with the probe and Manny already filled in. Same checks and confirmations as the Console
 * (the server validates against the spec before sending). Nothing here is panel-made.
 */

const waiting = (m: Schemas["Manny"]) => {
  const t = Array.isArray(m.task) || !m.task ? {} : (m.task as Record<string, unknown>);
  return m.currentTask === "waiting_for_space" || t.waitingFor === "storage_space";
};

function OpPicker({ ops, state, initial, highlight = [] }: {
  ops: Operation[]; state: PanelState; initial: { params?: Record<string, string>; body?: Record<string, unknown> }; highlight?: string[];
}) {
  const [sel, setSel] = useState<string | null>(null);
  const op = ops.find((o) => o.id === sel) ?? null;
  return (
    <div className="controls">
      <div className="row wrap">
        {ops.map((o) => (
          <button key={o.id} className={`tiny ${sel === o.id ? "on" : ""} ${highlight.some((h) => o.path.endsWith(h)) ? "primary" : ""}`}
            onClick={() => setSel(sel === o.id ? null : o.id)} title={o.path}>
            {o.summary}{o.risk === "confirm" ? " ⚠" : ""}
          </button>
        ))}
      </div>
      {op && <div className="mt"><OpForm key={op.id + JSON.stringify(initial)} op={op} state={state} initial={initial} /></div>}
    </div>
  );
}

/** Every Manny call, for one Manny. */
export function MannyControls({ state, p, m }: { state: PanelState; p: ProbeView; m: Schemas["Manny"] }) {
  const ops = useOperations();
  if (!ops) return <p className="muted tiny">Loading the API catalog…</p>;
  return (
    <OpPicker ops={mannyOps(ops)} state={state} initial={{ params: { probeId: String(p.summary.id), mannyId: m.id } }}
      highlight={waiting(m) ? ["/drop-manny-cargo", "/transfer-to-probe", "/recall"] : []} />
  );
}

/** Every call that changes this probe (move, storage, jettison, printer, container rules…). */
export function ProbeControls({ state, p }: { state: PanelState; p: ProbeView }) {
  const ops = useOperations();
  if (!ops) return <p className="muted tiny">Loading the API catalog…</p>;
  const idle = (p.mannies ?? []).find((m) => m.currentTask === null && m.location.type === "probe");
  return (
    <>
      <p className="muted tiny">
        Every call in the game's API that acts on {p.summary.name}, with the probe filled in. For one Manny's calls, open it in the Mannies tab
        (the "Controls" button). Calls marked ⚠ can lose things and ask first. All of them are also on the Console page.
      </p>
      <OpPicker ops={probeOps(ops)} state={state} initial={{ params: { probeId: String(p.summary.id) }, body: idle ? { actorMannyId: idle.id } : {} }} />
    </>
  );
}

/**
 * A Manny can't dock or deliver because storage is full: the spec's ways out, as buttons.
 * drop-manny-cargo: "Immediately discards the cargo of a Manny currently waiting outside for storage space, then retries docking."
 * transfer-to-probe: dock on another owned probe in the Manny's sector instead.
 * Making room: storage-moves into a container with room, or jettison stock (both on the Controls tab).
 */
export function StuckMannies({ state, p }: { state: PanelState; p: ProbeView }) {
  const stuck = (p.mannies ?? []).filter(waiting);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  if (!stuck.length) return null;
  const d = p.detail;
  const free = isFullProbe(d) ? d.inventory?.freeCapacity : undefined;
  const drop = async (m: Schemas["Manny"]) => {
    const cargo = m.cargo ? `${m.cargo.metals} metals, ${m.cargo.ice} ice, ${m.cargo.organicCompounds} carbon` : "its cargo";
    if (!window.confirm(`Drop ${m.name}'s cargo (${cargo}) and let it dock?\n\nResource cargo is lost. This calls POST /api/probe/${p.summary.id}/mannies/${m.id}/drop-manny-cargo.`)) return;
    const r = await callOp("POST /api/probe/{probeId}/mannies/{mannyId}/drop-manny-cargo", { path: { probeId: String(p.summary.id), mannyId: m.id }, confirmed: true });
    setMsg(r.ok ? `${m.name} dropped its cargo and is docking.` : `Refused: ${r.error ?? r.status}`);
  };
  return (
    <div className="card warn">
      <strong className="warn-text">{stuck.length} Manny{stuck.length > 1 ? "s" : ""} waiting outside for storage space</strong>
      <p className="tiny muted">
        {p.summary.name} has {free === undefined ? "?" : free.toFixed(3)} ECE free. Ways out: drop the cargo and dock, dock on another probe in the
        Manny's sector, or make room (Controls tab: move stock between containers, jettison stock, or hand a container over).
      </p>
      {stuck.map((m) => (
        <div key={m.id} className="member">
          <div className="row wrap">
            <b>{m.name}</b>
            <span className="tiny muted">{m.location.type === "sector" ? `outside at (${m.location.sector?.relative?.x}, ${m.location.sector?.relative?.y}, ${m.location.sector?.relative?.z})` : "aboard"}</span>
            <span className="spacer" />
            <button className="tiny danger" onClick={() => drop(m)}>Drop cargo and dock</button>
            <button className="tiny" onClick={() => setOpen(open === m.id ? null : m.id)}>More controls</button>
          </div>
          {open === m.id && <MannyControls state={state} p={p} m={m} />}
        </div>
      ))}
      {msg && <p className="tiny">{msg}</p>}
    </div>
  );
}
