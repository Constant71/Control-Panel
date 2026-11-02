import { useMemo, useState } from "react";
import type { PanelState } from "./types";
import { isFullProbe } from "../shared/attention";
import { ago } from "./format";
import { ExplorationPanel } from "./ExplorationPanel";

type V = { x: number; y: number; z: number };
const key = (v: V) => `${v.x},${v.y},${v.z}`;

/**
 * Map of visited sectors (GET /api/visited-sectors) and probe positions
 * (relative sector telemetry from GET /api/probe/{id}). Coordinates are
 * player-relative, as the API returns them. The view is a top-down x/y
 * projection; pick a z layer to slice.
 */
export function SectorMap({ state }: { state: PanelState }) {
  const { visitedSectors, probes } = state.snapshot;
  const [layer, setLayer] = useState<"all" | number>("all");
  const [selected, setSelected] = useState<string | null>(null);

  const probePos = useMemo(
    () =>
      probes
        .map((p) => {
          const d = p.detail;
          const pos = d?.sector?.relative;
          const target = isFullProbe(d) && d.movement && d.movement.status !== "arrived" ? d.movement.target : null;
          return pos ? { id: p.summary.id, name: p.summary.name, pos, target, reachable: p.summary.isReachable } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    [probes],
  );

  const layers = useMemo(() => {
    const zs = new Set<number>();
    visitedSectors.forEach((s) => zs.add(s.relativeCoordinates.z));
    probePos.forEach((p) => zs.add(p.pos.z));
    return [...zs].sort((a, b) => a - b);
  }, [visitedSectors, probePos]);

  const inLayer = (v: V) => layer === "all" || v.z === layer;
  const pts: V[] = [
    ...visitedSectors.map((s) => s.relativeCoordinates),
    ...probePos.map((p) => p.pos),
    ...probePos.flatMap((p) => (p.target ? [p.target] : [])),
    { x: 0, y: 0, z: 0 },
  ].filter(inLayer);
  const minX = Math.min(...pts.map((p) => p.x)) - 1;
  const maxX = Math.max(...pts.map((p) => p.x)) + 1;
  const minY = Math.min(...pts.map((p) => p.y)) - 1;
  const maxY = Math.max(...pts.map((p) => p.y)) + 1;
  const C = 40;
  const W = (maxX - minX + 1) * C;
  const H = (maxY - minY + 1) * C;
  const sx = (x: number) => (x - minX) * C;
  const sy = (y: number) => (maxY - y) * C; // y up

  const sel = selected ? visitedSectors.find((s) => key(s.relativeCoordinates) === selected) : null;
  const selProbes = selected ? probePos.filter((p) => key(p.pos) === selected) : [];

  return (
    <div className="pad">
      <div className="tabs small">
        <button className={layer === "all" ? "on" : ""} onClick={() => setLayer("all")}>all z</button>
        {layers.map((z) => (
          <button key={z} className={layer === z ? "on" : ""} onClick={() => setLayer(z)}>z = {z}</button>
        ))}
      </div>
      <div className="map-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} className="map" role="img" aria-label="Visited sectors map">
          {Array.from({ length: maxX - minX + 2 }, (_, i) => (
            <line key={"vx" + i} x1={i * C} y1={0} x2={i * C} y2={H} className="grid" />
          ))}
          {Array.from({ length: maxY - minY + 2 }, (_, i) => (
            <line key={"hy" + i} x1={0} y1={i * C} x2={W} y2={i * C} className="grid" />
          ))}
          {visitedSectors.filter((s) => inLayer(s.relativeCoordinates)).map((s) => {
            const v = s.relativeCoordinates;
            const k = key(v);
            return (
              <rect key={k} x={sx(v.x) + 3} y={sy(v.y) + 3} width={C - 6} height={C - 6} rx={4}
                className={`sector ${selected === k ? "sel" : ""}`} onClick={() => setSelected(k)}>
                <title>{`(${v.x}, ${v.y}, ${v.z}) visited ${s.visitCount}×`}</title>
              </rect>
            );
          })}
          <circle cx={sx(0) + C / 2} cy={sy(0) + C / 2} r={C / 2 - 2} className="home" />
          {probePos.filter((p) => (state.stationIds ?? []).includes(p.id) && inLayer(p.pos)).map((p) => (
            <g key={"st" + p.id}>
              <rect x={sx(p.pos.x) + 1} y={sy(p.pos.y) + 1} width={C - 2} height={C - 2} rx={6} className="station-mark" />
              <text x={sx(p.pos.x) + 4} y={sy(p.pos.y) + 12} className="station-label">S</text>
              <title>{`Station ${p.name}`}</title>
            </g>
          ))}
          {probePos.filter((p) => p.target && inLayer(p.pos)).map((p) => (
            <line key={"mv" + p.id} x1={sx(p.pos.x) + C / 2} y1={sy(p.pos.y) + C / 2}
              x2={sx(p.target!.x) + C / 2} y2={sy(p.target!.y) + C / 2} className="route" />
          ))}
          {probePos.filter((p) => inLayer(p.pos)).map((p, i) => (
            <g key={p.id} onClick={() => setSelected(key(p.pos))}>
              <circle cx={sx(p.pos.x) + C / 2 + ((i % 3) - 1) * 7} cy={sy(p.pos.y) + C / 2} r={5}
                className={p.reachable ? "probe-dot" : "probe-dot far"} />
              <title>{p.name}</title>
            </g>
          ))}
        </svg>
      </div>
      <p className="muted tiny">
        Squares are visited sectors, dots are probes (hollow means out of SCUT range), dashed lines are moves in progress (including station trips), an outlined square marked S is a station, and the ring is
        your home sector (0, 0, 0). The view is top-down x/y{layer === "all" ? " with every z layer overlaid" : ""}.
      </p>
      {selected && (
        <div className="card">
          <strong>Sector ({selected.replace(/,/g, ", ")})</strong>
          {sel ? (
            <p className="muted">
              Visited {sel.visitCount}×, first {ago(sel.firstVisitedAt)}, last {ago(sel.lastVisitedAt)}
            </p>
          ) : (
            <p className="muted">Not in visited history.</p>
          )}
          {selProbes.map((p) => (
            <div key={p.id}><a href={`#/probe/${p.id}`}>{p.name}</a></div>
          ))}
        </div>
      )}
      <ExplorationPanel state={state} />
    </div>
  );
}
