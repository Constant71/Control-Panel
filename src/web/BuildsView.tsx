import { useEffect, useState } from "react";
import type { PanelState, Schemas } from "./types";
import type { CraftGoal, GoalStatus, Suggestion } from "../shared/crafting";
import type { AutomationLogEntry, AutoFixMode } from "./types";
import { until } from "./format";

interface CraftingResponse {
  enabled: boolean;
  mode: AutoFixMode;
  recipes: Schemas["CraftingRecipe"][];
  queue: Record<string, CraftGoal[]>;
  statuses: GoalStatus[];
  suggestions: Suggestion[];
  holds: Array<{ probeId: number; mannyId: string; until: string | null }>;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const nice = (t: string) => t.replaceAll("_", " ");
const hours = (s: number) => (s < 3600 ? `${Math.round(s / 60)} min` : `${+(s / 3600).toFixed(1)} h`);

const STATUS_TEXT: Record<string, string> = {
  starting: "ordering", in_progress: "crafting", needs_ingredients: "needs parts", needs_resources: "needs resources",
  needs_manny: "waiting for Manny", printer_busy: "printer busy", no_printer: "no printer", no_room: "no room", no_recipe: "no recipe",
};

export function BuildsView({ state, now }: { state: PanelState; now: number }) {
  const [data, setData] = useState<CraftingResponse | null>(null);
  const [tab, setTab] = useState<"suggestions" | "queue" | "recipes">("suggestions");
  const [toast, setToast] = useState<AutomationLogEntry | { ok: true; label: string } | null>(null);
  const load = () => fetch("panel-api/crafting").then((r) => r.json()).then(setData).catch(() => {});
  useEffect(() => {
    load();
  }, [state.snapshot.lastPollFinishedAt]);
  if (!data) return <p className="pad muted">Loading…</p>;

  const ready = data.suggestions.filter((x) => x.ready);
  const later = data.suggestions.filter((x) => !x.ready);

  const confirm = async (s: Suggestion) => {
    const msg = [
      s.title, "",
      "Why:", ...s.why.map((w) => `• ${w}`), "",
      "Uses up:", ...s.consumes.map((l) => `• ${l.need} × ${nice(l.item)}`), "",
      "Risks:", ...s.risks.map((r) => `• ${r}`), "",
      `${s.mannyName} does it (${hours(s.durationSeconds)}). This calls ${s.endpoint}. Go ahead?`,
    ].join("\n");
    if (!window.confirm(msg)) return;
    const res = await post("panel-api/suggestions/confirm", { id: s.id });
    setToast(res.entry);
    load();
  };
  const queueMissing = async (s: Suggestion) => {
    await post("panel-api/crafting/queue-missing", { suggestionId: s.id });
    setToast({ ok: true, label: `Missing parts for "${s.title}" added to ${s.probeName}'s crafting queue.` });
    load();
  };

  return (
    <div className="pad">
      <div className="card-h">
        <div className="tabs small">
          <button className={tab === "suggestions" ? "on" : ""} onClick={() => setTab("suggestions")}>Suggestions ({ready.length} ready)</button>
          <button className={tab === "queue" ? "on" : ""} onClick={() => setTab("queue")}>Crafting queue</button>
          <button className={tab === "recipes" ? "on" : ""} onClick={() => setTab("recipes")}>Recipes ({data.recipes.length})</button>
        </div>
        <div className="mode">
          <span className="muted tiny">Crafting</span>
          <button className={data.enabled ? "on" : ""} onClick={() => post("panel-api/automation/settings", { crafting: true }).then(load)}>on</button>
          <button className={!data.enabled ? "on" : ""} onClick={() => post("panel-api/automation/settings", { crafting: false }).then(load)}>paused</button>
        </div>
      </div>
      {data.mode !== "auto" && <p className="warn-text tiny">Automation is in {data.mode.replace("_", " ")} mode, so queued crafts are not being sent. Change it on the Automation page.</p>}

      {toast && (
        <div className={`card ${toast.ok ? "" : "warning"}`} onClick={() => setToast(null)}>
          <strong>{toast.ok ? "Done" : "Not done"}:</strong> {toast.label}
          {"code" in toast && !toast.ok && <div className="tiny">{toast.message}</div>}
        </div>
      )}

      {data.holds.length > 0 && (
        <div className="card">
          <strong>Assembling now</strong>
          <ul className="plain">
            {data.holds.map((h) => {
              const v = state.snapshot.probes.find((p) => p.summary.id === h.probeId);
              const m = v?.mannies?.find((x) => x.id === h.mannyId);
              return <li key={h.mannyId}>{m?.name ?? h.mannyId} at {v?.summary.name}: done {until(h.until, now)}. The panel won't move {v?.summary.name} until then.</li>;
            })}
          </ul>
        </div>
      )}

      {tab === "suggestions" && (
        <>
          <p className="muted tiny">Builds never run on their own. Each card says why, what it uses up and what can go wrong, and waits for you to confirm.</p>
          {ready.length === 0 && <p className="muted">Nothing is ready to build yet. The cards below show what each build still needs.</p>}
          {ready.map((s) => <SuggestionCard key={s.id} s={s} onConfirm={confirm} onQueue={queueMissing} />)}
          {later.length > 0 && <h3 className="mt">Not ready yet</h3>}
          <div className="cards">
            {later.map((s) => <SuggestionCard key={s.id} s={s} onConfirm={confirm} onQueue={queueMissing} />)}
          </div>
        </>
      )}

      {tab === "queue" && <QueueTab data={data} state={state} reload={load} />}
      {tab === "recipes" && <RecipesTab recipes={data.recipes} />}
    </div>
  );
}

function SuggestionCard({ s, onConfirm, onQueue }: { s: Suggestion; onConfirm: (s: Suggestion) => void; onQueue: (s: Suggestion) => void }) {
  return (
    <div className={`card ${s.ready ? "ready" : ""}`}>
      <div className="card-h">
        {s.ready ? <span className="tag auto">ready</span> : <span className="tag">not ready</span>}
        <strong>{s.title}</strong>
      </div>
      <div className="tiny"><b>Why</b></div>
      <ul className="plain tiny">{s.why.map((w, i) => <li key={i}>{w}</li>)}</ul>
      <div className="tiny mt"><b>What it uses</b></div>
      <div className="kit">
        {s.consumes.length === 0 && <span className="muted tiny">No ingredients.</span>}
        {s.consumes.map((l) => (
          <span key={l.item} className={`kitline ${l.have + 1e-9 >= l.need ? "have" : "short"}`}>{+l.have.toFixed(3)}/{l.need} {nice(l.item)}</span>
        ))}
      </div>
      {s.blockers.length > 0 && <ul className="plain tiny warn-text mt">{s.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>}
      <details className="tiny mt">
        <summary>Risks and what the panel does about them</summary>
        <ul className="plain">{s.risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
        <div className="muted"><code>{s.endpoint}</code> · {hours(s.durationSeconds)}</div>
      </details>
      <div className="actions mt">
        {s.ready && <button className="primary" onClick={() => onConfirm(s)}>Confirm: {s.kind === "assemble_probe" ? "assemble" : "install"}</button>}
        {s.missing.some((l) => !["metals", "ice", "deuterium", "carbon_compounds"].includes(l.item)) && (
          <button onClick={() => onQueue(s)}>Queue the missing parts</button>
        )}
      </div>
    </div>
  );
}

function QueueTab({ data, state, reload }: { data: CraftingResponse; state: PanelState; reload: () => void }) {
  const probes = state.snapshot.probes.filter((p) => p.summary.isReachable);
  const [probeId, setProbeId] = useState<number>(probes[0]?.summary.id ?? 0);
  const [item, setItem] = useState<string>("");
  const [qty, setQty] = useState(1);
  const [once, setOnce] = useState(true);
  const goals = data.queue[String(probeId)] ?? [];
  const statuses = data.statuses.filter((s) => s.probeId === probeId);
  const save = (next: CraftGoal[]) => post("panel-api/crafting/queue", { probeId, goals: next }).then(reload);
  const move = (i: number, d: number) => {
    const next = [...goals];
    const [g] = next.splice(i, 1);
    next.splice(Math.max(0, Math.min(next.length, i + d)), 0, g);
    save(next);
  };
  const outputs = [...new Set(data.recipes.map((r) => r.output.type as string))].sort();

  return (
    <>
      <p className="muted tiny">
        Each line means "keep at least this many aboard". Lines higher up get parts and Mannies first. Missing parts are crafted
        first, missing metals, ice, carbon and deuterium are added to the mining targets, and one Manny is always kept free for fixes.
        A one-off line disappears once it's reached; the others keep the stock topped up.
      </p>
      <div className="tabs small">
        {probes.map((p) => (
          <button key={p.summary.id} className={probeId === p.summary.id ? "on" : ""} onClick={() => setProbeId(p.summary.id)}>
            {p.summary.name} ({(data.queue[String(p.summary.id)] ?? []).length})
          </button>
        ))}
      </div>
      {goals.length === 0 && <p className="muted">No crafting goals for this probe.</p>}
      {goals.map((g, i) => {
        const st = statuses.find((s) => s.goal.id === g.id);
        return (
          <div key={g.id} className="card">
            <div className="card-h">
              <strong>{g.quantity} × {nice(g.item)}</strong>
              {g.once && <span className="tag">one-off</span>}
              {st?.done ? <span className="tag auto">reached</span> : st && <span className="muted tiny">have {st.have}{st.inProgress ? `, ${st.inProgress} in progress` : ""} · ~{hours(st.workSeconds)} of Manny work left</span>}
              <span className="spacer" />
              <button onClick={() => move(i, -1)} disabled={i === 0} title="Higher priority">↑</button>
              <button onClick={() => move(i, 1)} disabled={i === goals.length - 1} title="Lower priority">↓</button>
              <button onClick={() => save(goals.filter((x) => x.id !== g.id))} title="Remove">✕</button>
            </div>
            {g.note && <div className="muted tiny">For: {g.note}</div>}
            {st && st.steps.length > 0 && (
              <ul className="steps tiny">
                {st.steps.map((step, j) => (
                  <li key={j} style={{ paddingLeft: step.depth * 14 }}>
                    <span className={`tag st-${step.status}`}>{STATUS_TEXT[step.status]}</span> {step.count} × {step.name}
                    {step.by === "atomic_3d_printer" && <span className="muted"> (printer)</span>}
                    {step.detail && <span className="muted"> · {step.detail}</span>}
                  </li>
                ))}
              </ul>
            )}
            {st && Object.keys(st.shortfalls).length > 0 && (
              <div className="tiny warn-text">
                Short: {Object.entries(st.shortfalls).map(([r, n]) => `${+Number(n).toFixed(3)} ECE ${nice(r)}`).join(", ")} (added to mining)
              </div>
            )}
          </div>
        );
      })}
      <div className="card">
        <strong>Add a goal</strong>
        <div className="addgoal">
          <select value={item} onChange={(e) => setItem(e.target.value)}>
            <option value="">Item…</option>
            {outputs.map((o) => <option key={o} value={o}>{nice(o)}</option>)}
          </select>
          <input type="number" min={1} max={1000} value={qty} onChange={(e) => setQty(Number(e.target.value))} />
          <label className="tiny"><input type="checkbox" checked={once} onChange={(e) => setOnce(e.target.checked)} /> one-off</label>
          <button disabled={!item || qty < 1} onClick={() => save([...goals, { id: "", item, quantity: qty, once, addedAt: "" }])}>Add</button>
        </div>
        {data.recipes.length === 0 && <p className="muted tiny">The recipe list hasn't loaded from the game yet.</p>}
      </div>
    </>
  );
}

function RecipesTab({ recipes }: { recipes: Schemas["CraftingRecipe"][] }) {
  if (!recipes.length) return <p className="muted">The recipe list hasn't loaded from the game yet (GET /api/crafting-recipes).</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Makes</th><th>By</th><th>Needs</th><th>Time</th><th>Space</th></tr></thead>
        <tbody>
          {recipes.map((r) => (
            <tr key={r.id} title={r.description}>
              <td>{r.output.name}</td>
              <td className="tiny">{r.craftableBy.map((b) => (b === "manny" ? "Manny" : "printer")).join(", ")}</td>
              <td className="tiny">{r.ingredients.map((i) => `${i.quantity}${i.unit === "earth_container_equivalent" ? " ECE" : "×"} ${nice(i.type)}`).join(", ")}</td>
              <td className="tiny">{hours(r.durationSeconds)}</td>
              <td className="tiny">{r.output.containerSpace} ECE</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
