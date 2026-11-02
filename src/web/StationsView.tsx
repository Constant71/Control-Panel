import { useEffect, useState } from "react";
import type { PanelState, Schemas } from "./types";
import { ago } from "./format";
import type { GoalStatus } from "../shared/crafting";
import {
  MEMBER_ROLES, MODE_LABEL, type MemberRole, type MemberStatus, type StationConfig, type StationLogEntry, type StationMode,
  type StationStatus, type StockResource, type StockTarget,
} from "../shared/stations";

interface StationsResponse {
  stations: StationStatus[];
  log: StationLogEntry[];
  production: GoalStatus[];
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
    return data;
  });
const nice = (t: string) => t.replaceAll("_", " ");
const vec = (v: { x: number; y: number; z: number } | null) => (v ? `${v.x}, ${v.y}, ${v.z}` : "?");
const RESOURCES: StockResource[] = ["metals", "ice", "carbon_compounds", "deuterium"];
const STEP_TEXT: Record<string, string> = {
  starting: "ordering", in_progress: "crafting", needs_ingredients: "needs parts", needs_resources: "needs resources",
  needs_manny: "waiting for a Manny", printer_busy: "printer busy", no_printer: "no printer", no_room: "no room", no_recipe: "no recipe",
};
const TRIP_TEXT: Record<string, string> = {
  outbound: "flying out", mining: "mining", returning: "flying home", handing_over: "handing over", done: "done", failed: "failed",
};

const MODE_TEXT: Record<StationMode, string> = {
  parts: "Crafts parts toward the stock targets.",
  manny_factory: "Keeps building Mannies (the manny recipe) for the station and its short group probes.",
  probe_yard: "Gathers an assembly kit and keeps 2 empty containers; every build is a confirm card on the Builds page.",
};

export function StationsView({ state, now }: { state: PanelState; now: number }) {
  const [data, setData] = useState<StationsResponse | null>(null);
  const [recipes, setRecipes] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => fetch("panel-api/stations").then((r) => r.json()).then(setData).catch(() => {});
  useEffect(() => {
    load();
  }, [state.snapshot.lastPollFinishedAt, (state.stationIds ?? []).join(","), JSON.stringify(state.stationMembers ?? {})]);
  useEffect(() => {
    fetch("panel-api/crafting").then((r) => r.json())
      .then((d: { recipes: Schemas["CraftingRecipe"][] }) => setRecipes(d.recipes.map((r) => r.id))).catch(() => {});
  }, []);
  if (!data) return <p className="pad muted">Loading…</p>;

  const run = async (fn: () => Promise<unknown>, okText?: string) => {
    try {
      const res = (await fn()) as { ok?: boolean; message?: string } | undefined;
      if (res && res.ok === false) setMsg({ ok: false, text: res.message ?? "Not done." });
      else if (res?.message || okText) setMsg({ ok: true, text: res?.message ?? okText! });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
    load();
  };

  const taken = new Set([...(state.stationIds ?? []), ...Object.keys(state.stationMembers ?? {}).map(Number)]);
  const free = state.snapshot.probes.filter((v) => !taken.has(v.summary.id));

  return (
    <div className="pad">
      <p className="muted tiny">
        A station is a probe the panel keeps in place as a production hub, with its own group of probes. The game doesn't know about
        stations: they only change which calls the panel makes. A station never gets automatic move orders.
      </p>
      {msg && <div className={`card ${msg.ok ? "" : "warning"}`} onClick={() => setMsg(null)}>{msg.text}</div>}

      <MakeStation free={free} onMake={(id) => run(() => post("panel-api/stations/create", { probeId: id }), "Station created.")} />

      {data.stations.length === 0 && <p className="muted">No stations yet.</p>}
      {data.stations.map((s) => (
        <StationCard key={s.probeId} s={s} free={free} recipes={recipes} run={run} goals={data.production.filter((g) => g.probeId === s.probeId)} />
      ))}

      {data.log.length > 0 && (
        <>
          <h3 className="mt">Station log</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>When</th><th>What</th><th>Call</th><th>Result</th></tr></thead>
              <tbody>
                {data.log.slice(0, 50).map((e, i) => (
                  <tr key={i}>
                    <td className="tiny">{ago(e.at, now)}</td>
                    <td>{e.label}</td>
                    <td className="tiny"><code>{e.endpoint ?? "panel only"}</code></td>
                    <td className={e.ok ? "ok-text tiny" : "warn-text tiny"}>{e.ok ? "ok" : e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function MakeStation({ free, onMake }: { free: PanelState["snapshot"]["probes"]; onMake: (id: number) => void }) {
  const [pick, setPick] = useState("");
  if (!free.length) return null;
  return (
    <div className="card">
      <div className="row wrap">
        <strong>Make a probe a station</strong>
        <select value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">Choose a probe…</option>
          {free.map((v) => <option key={v.summary.id} value={v.summary.id}>{v.summary.name}</option>)}
        </select>
        <button disabled={!pick} onClick={() => {
          const v = free.find((x) => String(x.summary.id) === pick);
          if (!v || !window.confirm(`Make ${v.summary.name} a station?\n\nIt will never get automatic move orders (exploration skips it), and its role becomes Station, which also renames it if naming is on. Nothing is sent to the game.`)) return;
          onMake(Number(pick));
          setPick("");
        }}>Make station</button>
      </div>
    </div>
  );
}

function StationCard({ s, free, recipes, run, goals }: {
  s: StationStatus; free: PanelState["snapshot"]["probes"]; recipes: string[]; goals: GoalStatus[];
  run: (fn: () => Promise<unknown>, okText?: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const update = (patch: Partial<StationConfig>) => run(() => post("panel-api/stations/update", { probeId: s.probeId, patch }));
  const bad = s.checks.filter((c) => !c.ok).length;
  const nameOf = (id: number) => s.members.find((m) => m.probeId === id)?.name ?? `Probe ${id}`;
  return (
    <div className="card station">
      <div className="card-h">
        <strong><a href={`#/probe/${s.probeId}`}>{s.name}</a></strong>
        <span className={`tag ${s.reachable ? "auto" : ""}`}>{s.status}</span>
        {s.isDefault && <span className="tag">default probe</span>}
        <span className="muted tiny">sector {vec(s.sector)}{s.scutNetworks.length ? ` · ${s.scutNetworks.join(", ")}` : ""}</span>
        <span className="spacer" />
        <label className="tiny">
          Production{" "}
          <select value={s.config.mode} onChange={(e) => update({ mode: e.target.value as StationMode })}>
            {(Object.keys(MODE_LABEL) as StationMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
          </select>
        </label>
      </div>
      <p className="muted tiny">
        {MODE_TEXT[s.config.mode]}
        {s.config.mode === "probe_yard" && (
          <> Kit for{" "}
            <select value={s.config.yardModel} onChange={(e) => update({ yardModel: e.target.value as StationConfig["yardModel"] })}>
              <option value="generic">generic probe</option>
              <option value="deuterium_tanker">deuterium tanker</option>
            </select>
          </>
        )}
      </p>
      {s.production.length > 0 && (
        <div className="kit">
          {s.production.map((g) => {
            const st = goals.find((x) => x.goal.item === g.item);
            const own = !st || !st.goal.id.startsWith("station:");
            return (
              <span key={g.item} title={g.why + (st && own ? " Your own crafting queue has this item, so its goal is used instead." : "")}
                className={`kitline ${(st?.done ?? (g.have ?? 0) >= g.quantity) ? "have" : "short"}`}>
                {st ? `${st.have}${st.inProgress ? `+${st.inProgress}` : ""}` : (g.have ?? "?")}/{g.quantity} {nice(g.item)}
                {st && !st.done && st.steps[0] ? ` · ${STEP_TEXT[st.steps[0].status] ?? st.steps[0].status}` : ""}
              </span>
            );
          })}
        </div>
      )}
      {s.production.length > 0 && <p className="muted tiny">Crafted through the Builds page's crafting queue (ingredients first). Probe builds stay confirm cards on the Builds page.</p>}

      <div className="tiny"><b>Checks</b>{bad > 0 && <span className="warn-text"> · {bad} to look at</span>}</div>
      <ul className="plain tiny">
        {s.checks.map((c, i) => <li key={i} className={c.ok ? "ok-text" : "warn-text"}>{c.ok ? "✓" : "!"} {c.text}</li>)}
      </ul>
      {!s.isDefault && s.reachable && (
        <button className="mt" onClick={() => {
          if (!window.confirm(`Make ${s.name} the default probe?\n\nThis calls PATCH /api/probe/${s.probeId} with isDefault: true. Orders then reach only probes in ${s.name}'s sector or on its SCUT network, so probes near the old default may drop out of reach. The game refuses unless both are in the same sector or on the same active SCUT network.`)) return;
          run(() => post("panel-api/stations/make-default", { probeId: s.probeId }));
        }}>Make default probe</button>
      )}

      <div className="card-h mt">
        <div className="tiny"><b>Stock against targets</b></div>
        <span className="spacer" />
        <button className="tiny" onClick={() => setEditing(!editing)}>{editing ? "Done" : "Edit settings"}</button>
      </div>
      <div className="targets">
        {s.targets.map((t) => {
          const fill = t.have === null || t.min <= 0 ? 100 : Math.min(100, (t.have / t.min) * 100);
          return (
            <div key={t.key} className="target">
              <div className="row tiny">
                <span>{t.label}</span>
                <span className="spacer" />
                <span className={t.short > 0 ? "warn-text" : ""}>
                  {t.have === null ? "?" : +t.have.toFixed(3)} / {t.min} {t.unit}
                  {t.short > 0 && ` · ${+t.short.toFixed(3)} short`}
                </span>
              </div>
              <div className="bar"><div className={`bar-fill ${t.short > 0 ? "warn" : "good"}`} style={{ width: `${fill}%` }} /></div>
            </div>
          );
        })}
      </div>
      {editing && <TargetEditor cfg={s.config} recipes={recipes} onSave={update} />}

      <div className="tiny mt"><b>Group</b> <span className="muted">({s.members.length} probe{s.members.length === 1 ? "" : "s"})</span></div>
      <div className="members">
        {s.members.map((m) => <MemberRow key={m.probeId} m={m} stationId={s.probeId} run={run} />)}
      </div>
      <AddMember stationId={s.probeId} free={free} run={run} />

      <div className="card-h mt">
        <div className="tiny"><b>Trips</b> <span className="muted">Haulers fetch what the station is short of, inside the SCUT network</span></div>
        <span className="spacer" />
        <div className="mode">
          <button className={s.config.dispatch ? "on" : ""} onClick={() => update({ dispatch: true })}>on</button>
          <button className={!s.config.dispatch ? "on" : ""} onClick={() => update({ dispatch: false })}>off</button>
        </div>
      </div>
      {s.dispatchNotes.length > 0 && <ul className="plain tiny muted">{s.dispatchNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      {s.trips.length > 0 && (
        <div className="members">
          {s.trips.slice(0, 6).map((t) => (
            <div key={t.id} className="member">
              <div className="row wrap">
                <b>{nameOf(t.haulerId)}</b>
                <span className={`tag ${t.state === "failed" ? "" : t.state === "done" ? "" : "auto"}`}>{TRIP_TEXT[t.state]}</span>
                <span className="tiny muted">{nice(t.resource)} from ({t.target.x}, {t.target.y}, {t.target.z})</span>
              </div>
              <div className={`tiny ${t.state === "failed" ? "warn-text" : "muted"}`}>{t.note ?? ""} <span className="muted">Why: {t.reason}.</span></div>
            </div>
          ))}
        </div>
      )}

      <div className="card-h mt">
        <div className="tiny"><b>Docked service</b> <span className="muted">hand-offs and refuelling while a group probe is in this sector</span></div>
        <span className="spacer" />
        <div className="mode">
          <button className={s.config.service ? "on" : ""} onClick={() => update({ service: true })}>on</button>
          <button className={!s.config.service ? "on" : ""} onClick={() => update({ service: false })}>off</button>
        </div>
      </div>
      <p className="muted tiny">
        Haulers hand over containers at least {s.config.handoffMinFillPercent}% full and get empties back (up to {s.config.containersPerHauler} each).
        Docked probes are topped up to {s.config.ferryFuelTargetPercent}% while the station stays above {s.config.fuelFloorPercent}%.
        Tankers top the station up and keep {s.config.tankerReservePercent}% for themselves. A container holding a Manny is never handed over.
      </p>
      {s.next.length > 0 ? (
        <ul className="plain tiny">
          {s.next.map((o) => <li key={o.id}><b>Next:</b> {o.label} <span className="muted">· {o.why}</span></li>)}
        </ul>
      ) : <p className="muted tiny">Nothing to do right now.</p>}
      {s.handoffs.length > 0 && (
        <ul className="plain tiny">
          {s.handoffs.slice(0, 8).map((h) => (
            <li key={h.id} className={h.state === "failed" ? "warn-text" : h.state === "done" ? "ok-text" : ""}>
              {h.purpose === "full" ? "Full" : "Empty"} container {h.containerId}: {h.state}{h.note ? ` · ${h.note}` : ""}
            </li>
          ))}
        </ul>
      )}

      <div className="row wrap mt tiny">
        <span className="muted">Remove the station: its group probes go back to normal automation.</span>
        <button onClick={() => {
          if (!window.confirm(`Remove ${s.name} as a station? Its ${s.members.length} group probe(s) go back to normal automation. Nothing is sent to the game.`)) return;
          run(() => post("panel-api/stations/remove", { probeId: s.probeId }), "Station removed.");
        }}>Remove station</button>
      </div>
    </div>
  );
}

function MemberRow({ m, stationId, run }: { m: MemberStatus; stationId: number; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const facts = [
    m.docked ? "docked at the station" : `${m.status} · sector ${vec(m.sector)}`,
    `fuel ${m.fuelPercent === null ? "?" : `${m.fuelPercent}%`}`,
    `${m.additionalContainers ?? "?"} extra containers`,
    `Mannies ${m.mannies ?? "?"}${m.mannyTarget !== null ? ` / ${m.mannyTarget}` : ""}`,
  ];
  return (
    <div className="member">
      <div className="row wrap">
        <a href={`#/probe/${m.probeId}`}><b>{m.name}</b></a>
        <select value={m.role ?? ""} disabled={!m.reachable} title={m.reachable ? "" : "Out of range: the role can change once it is back in reach"}
          onChange={(e) => run(() => post("panel-api/stations/member", { probeId: m.probeId, stationId, role: e.target.value || null }))}>
          <option value="">No role</option>
          {MEMBER_ROLES.map((r) => <option key={r}>{r}</option>)}
        </select>
        <span className="spacer" />
        <button className="tiny" onClick={() => {
          if (window.confirm(`Take ${m.name} out of the group? It goes back to normal automation.`))
            run(() => post("panel-api/stations/member", { probeId: m.probeId, stationId: null }));
        }}>Remove</button>
      </div>
      <div className={`tiny ${m.docked ? "ok-text" : "muted"}`}>{facts.join(" · ")}</div>
      {m.notes.length > 0 && <ul className="plain tiny warn-text">{m.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
    </div>
  );
}

function AddMember({ stationId, free, run }: { stationId: number; free: PanelState["snapshot"]["probes"]; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [pick, setPick] = useState("");
  const [role, setRole] = useState<MemberRole | "">("Hauler");
  if (!free.length) return null;
  const v = free.find((x) => String(x.summary.id) === pick);
  return (
    <div className="row wrap tiny mt">
      <span>Add to group</span>
      <select value={pick} onChange={(e) => setPick(e.target.value)}>
        <option value="">Choose a probe…</option>
        {free.map((x) => <option key={x.summary.id} value={x.summary.id}>{x.summary.name}{x.summary.isReachable ? "" : " (out of range)"}</option>)}
      </select>
      <select value={role} onChange={(e) => setRole(e.target.value as MemberRole | "")}>
        <option value="">No role</option>
        {MEMBER_ROLES.map((r) => <option key={r}>{r}</option>)}
      </select>
      <button disabled={!pick || (!!v && !v.summary.isReachable && role !== "")} onClick={() => {
        run(() => post("panel-api/stations/member", { probeId: Number(pick), stationId, role: role || null }));
        setPick("");
      }}>Add</button>
      {v && !v.summary.isReachable && role !== "" && <span className="warn-text">Out of range: add it with no role, then pick one when it is back in reach.</span>}
    </div>
  );
}

function TargetEditor({ cfg, recipes, onSave }: { cfg: StationConfig; recipes: string[]; onSave: (p: Partial<StationConfig>) => void }) {
  const [targets, setTargets] = useState<StockTarget[]>(cfg.targets);
  const [fuel, setFuel] = useState(cfg.fuelFloorPercent);
  const [mannies, setMannies] = useState(cfg.mannyTarget);
  const [perRole, setPerRole] = useState(cfg.mannyPerRole);
  const [fill, setFill] = useState(cfg.handoffMinFillPercent);
  const [boxes, setBoxes] = useState(cfg.containersPerHauler);
  const [ferryFuel, setFerryFuel] = useState(cfg.ferryFuelTargetPercent);
  const [reserve, setReserve] = useState(cfg.tankerReservePercent);
  const [tripHours, setTripHours] = useState(cfg.maxTripHours);
  const [tripMargin, setTripMargin] = useState(cfg.tripFuelMarginPercent);
  const [newKind, setNewKind] = useState<"resource" | "item">("resource");
  const [newName, setNewName] = useState("");
  const set = (i: number, min: number) => setTargets(targets.map((t, j) => (j === i ? { ...t, min } : t)));
  return (
    <div className="editor tiny">
      {targets.map((t, i) => (
        <div key={i} className="row">
          <span className="grow">{t.kind === "resource" ? nice(t.resource) : nice(t.item)}</span>
          <input type="number" min={0} step={t.kind === "resource" ? 0.1 : 1} value={t.min} onChange={(e) => set(i, Number(e.target.value))} />
          <span className="unit">{t.kind === "resource" ? "ECE" : "pcs"}</span>
          <button onClick={() => setTargets(targets.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <div className="row wrap">
        <select value={newKind} onChange={(e) => { setNewKind(e.target.value as "resource" | "item"); setNewName(""); }}>
          <option value="resource">Resource</option>
          <option value="item">Item</option>
        </select>
        <select value={newName} onChange={(e) => setNewName(e.target.value)}>
          <option value="">Choose…</option>
          {(newKind === "resource" ? RESOURCES : recipes).map((r) => <option key={r} value={r}>{nice(r)}</option>)}
        </select>
        <button disabled={!newName} onClick={() => {
          setTargets([...targets, newKind === "resource" ? { kind: "resource", resource: newName as StockResource, min: 1 } : { kind: "item", item: newName, min: 1 }]);
          setNewName("");
        }}>Add target</button>
      </div>
      <div className="row"><span className="grow">Station fuel floor (kept for one flee jump)</span><input type="number" min={0} max={100} value={fuel} onChange={(e) => setFuel(Number(e.target.value))} /><span className="unit">%</span></div>
      <div className="row"><span className="grow">Mannies kept at the station</span><input type="number" min={0} value={mannies} onChange={(e) => setMannies(Number(e.target.value))} /><span className="unit" /></div>
      {MEMBER_ROLES.map((r) => (
        <div key={r} className="row"><span className="grow">Mannies per {r}</span>
          <input type="number" min={0} value={perRole[r]} onChange={(e) => setPerRole({ ...perRole, [r]: Number(e.target.value) })} /><span className="unit" /></div>
      ))}
      <div className="row"><span className="grow">Longest stay at a mining sector</span><input type="number" min={1} max={72} value={tripHours} onChange={(e) => setTripHours(Number(e.target.value))} /><span className="unit">h</span></div>
      <div className="row"><span className="grow">Fuel left after a round trip</span><input type="number" min={0} max={90} value={tripMargin} onChange={(e) => setTripMargin(Number(e.target.value))} /><span className="unit">%</span></div>
      <div className="row"><span className="grow">Hand over containers at least this full</span><input type="number" min={1} max={100} value={fill} onChange={(e) => setFill(Number(e.target.value))} /><span className="unit">%</span></div>
      <div className="row"><span className="grow">Containers per Hauler (max 4)</span><input type="number" min={0} max={4} value={boxes} onChange={(e) => setBoxes(Number(e.target.value))} /><span className="unit" /></div>
      <div className="row"><span className="grow">Top up docked probes to</span><input type="number" min={0} max={100} value={ferryFuel} onChange={(e) => setFerryFuel(Number(e.target.value))} /><span className="unit">%</span></div>
      <div className="row"><span className="grow">Tanker keeps at least</span><input type="number" min={0} max={100} value={reserve} onChange={(e) => setReserve(Number(e.target.value))} /><span className="unit">%</span></div>
      <button onClick={() => onSave({
        targets, fuelFloorPercent: fuel, mannyTarget: mannies, mannyPerRole: perRole,
        handoffMinFillPercent: fill, containersPerHauler: boxes, ferryFuelTargetPercent: ferryFuel, tankerReservePercent: reserve,
        maxTripHours: tripHours, tripFuelMarginPercent: tripMargin,
      })}>Save settings</button>
    </div>
  );
}
