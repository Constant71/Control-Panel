import { useEffect, useRef, useState } from "react";
import type { StarMapData } from "../shared/starmap";
import { StarRenderer, hitTest, vkey, type Hit, type View } from "./starRender";

/**
 * Interactive 3D map for the Map page: drag to turn, pinch or scroll to zoom, tap a sector to
 * select it (the camera glides to it). Same data and drawing as the projector page.
 */
export function StarMap3D({ data, selected, onSelect }: {
  data: StarMapData | null;
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const selRef = useRef(selected);
  selRef.current = selected;
  const view = useRef<View>({ yaw: 0.6, pitch: 0.5, zoom: 1, focus: null });
  const [spin, setSpin] = useState(true);
  const spinRef = useRef(spin);
  spinRef.current = spin;
  const hits = useRef<Hit[]>([]);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  // Glide to whatever gets selected (from a tap here or from the list on the flat map).
  useEffect(() => {
    if (!selected) { view.current.focus = null; return; }
    const [x, y, z] = selected.split(",").map(Number);
    view.current.focus = { x, y, z };
    if (view.current.zoom < 1.6) view.current.zoom = 1.6;
  }, [selected]);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const renderer = new StarRenderer();
    let raf = 0, last = 0, prev = performance.now();
    const start = prev;
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (t - last < 30) return;
      last = t;
      const dt = (t - prev) / 1000;
      prev = t;
      if (spinRef.current) view.current.yaw += dt * (Math.PI * 2) / 180;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      const narrow = canvas.clientWidth < 600;
      hits.current = renderer.render(ctx, W, H, (t - start) / 1000, dataRef.current, view.current, {
        labels: true, vignette: false, backdrop: true, mood: false, selected: selRef.current, labelSize: narrow ? 0.045 : 0.03,
      }).map((h) => ({ ...h, x: h.x / dpr, y: h.y / dpr, r: h.r / dpr }));
    };
    raf = requestAnimationFrame(frame);

    // Pointer handling: one finger/mouse turns, two fingers pinch-zoom, a short still press taps.
    const pts = new Map<number, { x: number; y: number }>();
    let downAt = 0, moved = 0, pinch0 = 0, zoom0 = 1;
    const pos = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const down = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, pos(e));
      if (pts.size === 1) { downAt = performance.now(); moved = 0; }
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch0 = Math.hypot(a.x - b.x, a.y - b.y); zoom0 = view.current.zoom;
      }
      setSpin(false);
    };
    const move = (e: PointerEvent) => {
      const p0 = pts.get(e.pointerId);
      if (!p0) return;
      const p = pos(e);
      pts.set(e.pointerId, p);
      if (pts.size === 1) {
        const dx = p.x - p0.x, dy = p.y - p0.y;
        moved += Math.abs(dx) + Math.abs(dy);
        view.current.yaw += dx * 0.009;
        view.current.pitch = Math.min(1.45, Math.max(-1.45, view.current.pitch + dy * 0.007));
      } else if (pts.size === 2 && pinch0 > 0) {
        moved += 20;
        const [a, b] = [...pts.values()];
        view.current.zoom = clampZoom(zoom0 * (Math.hypot(a.x - b.x, a.y - b.y) / pinch0));
      }
    };
    const up = (e: PointerEvent) => {
      const p = pos(e);
      const wasTap = pts.size === 1 && moved < 10 && performance.now() - downAt < 600;
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch0 = 0;
      if (wasTap) {
        const h = hitTest(hits.current, p.x, p.y);
        selectRef.current(h ? h.key : null);
      }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      view.current.zoom = clampZoom(view.current.zoom * Math.exp(-e.deltaY * 0.0015));
      setSpin(false);
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("wheel", wheel);
    };
  }, []);

  const reset = () => {
    view.current = { yaw: 0.6, pitch: 0.5, zoom: 1, focus: null };
    onSelect(null);
  };
  const topDown = () => { view.current.pitch = 1.45; view.current.yaw = 0; setSpin(false); };
  const zoomBy = (k: number) => { view.current.zoom = clampZoom(view.current.zoom * k); };
  const home = () => onSelect(vkey({ x: 0, y: 0, z: 0 }));

  return (
    <div className="map3d">
      <canvas ref={ref} className="map3d-canvas" aria-label="3D map of explored sectors and probes. Tap a sector for details." />
      <div className="map3d-tools">
        <button onClick={() => setSpin(!spin)} className={spin ? "on" : ""} title="Slowly turn the map">{spin ? "Spinning" : "Spin"}</button>
        <button onClick={() => zoomBy(1.4)} title="Zoom in">+</button>
        <button onClick={() => zoomBy(1 / 1.4)} title="Zoom out">−</button>
        <button onClick={topDown} title="Look straight down">Top</button>
        <button onClick={home} title="Go to sector (0, 0, 0)">Home</button>
        <button onClick={reset} title="Show everything">Reset</button>
      </div>
      {!data && <div className="map3d-wait">Loading map…</div>}
    </div>
  );
}

const clampZoom = (z: number) => Math.min(12, Math.max(0.4, z));
