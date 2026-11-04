import { useEffect, useState } from "react";
import type { SectorInfo } from "../shared/starmap";
import { ago, until, label } from "./format";

/** Everything the panel knows about one sector (GET /panel-api/sector-info), shown when a sector is tapped. */
export function SectorCard({ sectorKey, pollKey, onClose }: { sectorKey: string; pollKey: unknown; onClose: () => void }) {
  const [info, setInfo] = useState<SectorInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [x, y, z] = sectorKey.split(",").map(Number);
  useEffect(() => {
    setErr(null);
    fetch(`panel-api/sector-info?x=${x}&y=${y}&z=${z}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: SectorInfo) => setInfo(d))
      .catch((e) => setErr(String(e.message ?? e)));
  }, [sectorKey, pollKey]);

  const current = info && info.pos.x === x && info.pos.y === y && info.pos.z === z ? info : null;
  return (
    <div className="card mt sector-card">
      <div className="sector-card-head">
        <strong>Sector ({x}, {y}, {z})</strong>
        <button className="small" onClick={onClose} aria-label="Close sector details">Close</button>
      </div>
      {err && <p className="warn-t">Couldn't load this sector: {err}</p>}
      {!current ? <p className="muted">Loading…</p> : <SectorBody info={current} />}
    </div>
  );
}

const TYPE_ORDER = ["star", "solar_system", "planet", "asteroid", "black_hole", "dust_cloud", "dormant_construct", "scut_relay",
  "deuterium_refuel_station", "detached_container", "drifting_item", "manny", "missile"];
const TYPE_NAME: Record<string, string> = {
  star: "Stars", solar_system: "Solar systems", planet: "Planets", asteroid: "Asteroids", black_hole: "Black holes",
  dust_cloud: "Dust clouds", dormant_construct: "Dormant constructs", scut_relay: "SCUT relays", deuterium_refuel_station: "Deuterium refuel stations",
  detached_container: "Detached containers", drifting_item: "Drifting items", manny: "Mannies", missile: "Missiles",
};
const RES: Record<string, string> = { deuterium: "Deuterium", metals: "Metals", ice: "Ice", carbon_compounds: "Carbon" };

function SectorBody({ info }: { info: SectorInfo }) {
  const s = info.scan;
  const objects = s?.objects ?? [];
  const byType = new Map<string, Array<Record<string, unknown>>>();
  for (const o of objects) {
    const t = String(o.type ?? "other");
    byType.set(t, [...(byType.get(t) ?? []), o]);
  }
  const types = [...byType.keys()].sort((a, b) => (TYPE_ORDER.indexOf(a) + 99) % 199 - (TYPE_ORDER.indexOf(b) + 99) % 199);
  const res = Object.entries(s?.resources ?? {}).filter(([, v]) => v > 0);
  const ns = info.neighbourScan;

  return (
    <>
      <div className="chips">
        {info.visited ? <span className="chip good">Visited {info.visited.visitCount}×, last {ago(info.visited.lastVisitedAt)}</span>
          : <span className="chip">Not visited</span>}
        {s?.coverage && <span className={`chip ${s.coverage === "covered" ? "good" : ""}`}>SCUT {s.coverage}</span>}
        {s?.detail?.scutNetworks.map((n) => <span key={n.id} className="chip">Network {n.name ?? `#${n.id}`}</span>)}
        {s?.scannedAt && <span className="chip">Scanned {ago(s.scannedAt)} ({label(s.knowledgeLevel)}{s.detail ? `, ${Math.round(s.detail.confidence * 100)}%` : ""})</span>}
        {s?.detail?.sensorMode && s.detail.sensorMode !== "normal" && <span className="chip warn">Sensors {s.detail.sensorMode}</span>}
        {s?.detail?.navigationalRisk && <span className="chip">Navigational risk {s.detail.navigationalRisk}</span>}
      </div>
      {s?.error && <p className="warn-t tiny">Last scan failed: {s.error}</p>}

      {info.probes.length > 0 && (
        <section>
          <h4>Probes</h4>
          {info.probes.map((p) => (
            <div key={p.id} className="sector-row">
              <div>
                <a href={`#/probe/${p.id}`}><b>{p.name}</b></a>
                <span className="muted"> · {label(p.status)}{p.role ? ` · ${p.role}` : ""}{p.station ? " · station" : ""}{p.isDefault ? " · default" : ""}{!p.reachable ? " · out of SCUT range" : ""}</span>
              </div>
              {p.arrivingAt && <div className="muted tiny">Arriving {until(p.arrivingAt)}</div>}
              {p.exploring ? <div className="tiny">Exploring: {p.exploring.text}</div>
                : !p.station && <div className="tiny muted">Explore is off for this probe, so the panel won't move it on its own. Turn it on in Automation.</div>}
            </div>
          ))}
        </section>
      )}

      {info.discoveries.length > 0 && (
        <section>
          <h4>Discoveries</h4>
          {info.discoveries.map((d, i) => (
            <div key={i} className="sector-row">
              <b className={d.kind === "dormant_construct" ? "accent-t" : ""}>{d.title}</b>
              {!d.read && <span className="chip info">new</span>}
              {!d.present && <span className="chip">gone</span>}
              <div className="muted tiny">{d.detail} · found {ago(d.firstSeenAt)}</div>
            </div>
          ))}
        </section>
      )}

      {res.length > 0 && (
        <section>
          <h4>Mineable resources</h4>
          <div className="chips">{res.map(([k, v]) => <span key={k} className="chip">{RES[k] ?? label(k)} {fmt(v)} ECE</span>)}</div>
        </section>
      )}

      {s && (
        <section>
          <h4>Objects{objects.length ? ` (${objects.length})` : ""}</h4>
          {!objects.length && <p className="muted tiny">The last scan listed no objects.</p>}
          {types.map((t) => (
            <details key={t} open={byType.get(t)!.length <= 6}>
              <summary>{TYPE_NAME[t] ?? label(t)} ({byType.get(t)!.length})</summary>
              {byType.get(t)!.map((o, i) => <ObjectRow key={String(o.id ?? i)} o={o} />)}
            </details>
          ))}
        </section>
      )}
      {s?.detail?.possibleObjects.length ? <p className="muted tiny">Possible: {s.detail.possibleObjects.map(label).join(", ")}</p> : null}

      {ns && (
        <section>
          <h4>Neighbour scan</h4>
          <div className="chips">
            <span className="chip">{label(ns.knowledgeLevel)}, {Math.round(ns.confidence * 100)}% confidence</span>
            {typeof ns.estimatedObjects.star === "boolean" && <span className="chip">{ns.estimatedObjects.star ? "Star likely" : "No star"}</span>}
            {ns.estimatedObjects.planetCountMax !== undefined && <span className="chip">Planets {String(ns.estimatedObjects.planetCountMin ?? 0)}–{String(ns.estimatedObjects.planetCountMax)}</span>}
            {Number(ns.estimatedObjects.blackHoleProbability ?? 0) > 0 && (
              <span className={`chip ${Number(ns.estimatedObjects.blackHoleProbability) >= 0.05 ? "crit" : ""}`}>
                Black hole {Math.round(Number(ns.estimatedObjects.blackHoleProbability) * 100)}%
              </span>
            )}
            {ns.estimatedObjects.dangerEstimate !== undefined && <span className="chip">Danger {String(ns.estimatedObjects.dangerEstimate)}</span>}
            {ns.navigationalRisk && <span className="chip">Navigational risk {ns.navigationalRisk}</span>}
            <span className="chip">SCUT {ns.scutCoverageStatus}</span>
          </div>
          {ns.possibleObjects.length > 0 && <p className="muted tiny">Possible: {ns.possibleObjects.map(label).join(", ")}</p>}
          {ns.message && <p className="muted tiny">{ns.message}</p>}
        </section>
      )}

      {info.candidates.length > 0 && (
        <section>
          <h4>As a next hop</h4>
          {info.candidates.map((c, i) => (
            <div key={i} className="sector-row tiny">
              <b>{c.probeName}</b> scores it {c.score}{c.safe ? "" : " (risky)"}
              {c.notes.length > 0 && <div className="muted">{c.notes.join(" ")}</div>}
            </div>
          ))}
        </section>
      )}

      {!s && !ns && !info.visited && <p className="muted">The panel has no scan of this sector.</p>}
    </>
  );
}

const fmt = (n: number) => (n >= 100 ? Math.round(n).toString() : (+n.toFixed(2)).toString());

/** One SectorObject with the fields the spec defines for its type. */
function ObjectRow({ o }: { o: Record<string, unknown> }) {
  const facts: string[] = [];
  const add = (cond: unknown, text: string) => { if (cond !== undefined && cond !== null && cond !== false) facts.push(text); };
  add(o.starCount, `${o.starCount} star(s)`);
  add(o.planetCount, `${o.planetCount} planet(s)`);
  add(o.orbitalBodyCount, `${o.orbitalBodyCount} orbital bodies`);
  add(o.category, `category ${label(String(o.category))}`);
  add(o.composition, `${label(String(o.composition))}`);
  add(o.sizeCategory, `${o.sizeCategory}`);
  add(o.habitabilityScore, `habitability ${o.habitabilityScore}`);
  add(o.mass, `mass ${num(o.mass)} ${label(String(o.massUnit ?? ""))}`.trim());
  add(o.radius, `radius ${num(o.radius)} ${label(String(o.radiusUnit ?? ""))}`.trim());
  add(o.dangerLevel, `danger ${o.dangerLevel}`);
  add(o.motorized, `motorized${o.motorFuelStatus ? ` (fuel ${o.motorFuelStatus})` : ""}`);
  add(o.capturedByObjectId, "captured");
  add(o.inTransit, "in transit");
  add(o.mannyMineable, "mineable");
  add(o.inspectable, "inspectable");
  add(o.salvageable, "salvageable");
  add(o.inventoryAccessible, "storage accessible");
  add(o.observedClass, label(String(o.observedClass)));
  add(o.distinctiveFeature, String(o.distinctiveFeature));
  const traj = o.trajectory as Record<string, unknown> | undefined;
  add(traj?.status, `trajectory ${label(String(traj?.status))}`);
  add(o.targetsCurrentProbe, "targeting our probe");
  add(o.impactAt, `impact ${until(String(o.impactAt))}`);
  const amounts = o.resourceAmounts as Record<string, number> | undefined;
  const res = amounts ? Object.entries(amounts).filter(([, v]) => v > 0).map(([k, v]) => `${RES[k] ?? label(k)} ${fmt(v)}`) : [];
  const targets = (o.minableTargets as Array<Record<string, unknown>> | undefined) ?? [];
  const abandoned = (o.abandonedMannies as unknown[] | undefined)?.length ?? 0;
  add(abandoned > 0, `${abandoned} abandoned Manny(ies) inside`);
  return (
    <div className={`sector-row ${o.type === "missile" ? "crit-t" : ""}`}>
      <div><b>{String(o.name ?? o.id ?? label(String(o.type)))}</b>{o.estimated ? <span className="muted"> (estimated)</span> : null}</div>
      {o.summary ? <div className="muted tiny">{String(o.summary)}</div> : null}
      {facts.length > 0 && <div className="tiny">{facts.join(" · ")}</div>}
      {res.length > 0 && <div className="tiny">Resources (ECE): {res.join(" · ")}</div>}
      {targets.length > 0 && (
        <div className="tiny sector-nested">
          {targets.map((t, i) => {
            const a = t.resourceAmounts as Record<string, number> | undefined;
            const r = a ? Object.entries(a).filter(([, v]) => v > 0).map(([k, v]) => `${RES[k] ?? label(k)} ${fmt(v)}`).join(", ") : "";
            return <div key={i}>{label(String(t.type))} <b>{String(t.name ?? t.id)}</b>{t.composition ? ` · ${label(String(t.composition))}` : ""}{r ? ` · ${r}` : ""}</div>;
          })}
        </div>
      )}
    </div>
  );
}

const num = (v: unknown) => {
  const n = Number(v);
  return !Number.isFinite(n) ? String(v) : Math.abs(n) >= 1000 || (Math.abs(n) < 0.01 && n !== 0) ? n.toExponential(2) : (+n.toFixed(2)).toString();
};
