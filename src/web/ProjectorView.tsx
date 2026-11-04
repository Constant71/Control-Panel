import { useEffect, useRef, useState } from "react";
import { useLiveState } from "./useLiveState";
import { useReloadOnNewVersion } from "./TvView";
import type { StarMapData } from "../shared/starmap";
import { StarRenderer } from "./starRender";

/**
 * Projector star map (/projector). A slowly turning 3D view of the empire, drawn on pure
 * black so that, on a projector, everything that isn't data is simply the wall.
 *
 * Sectors, what is in them, scanned neighbours and probe moves come from /panel-api/starmap
 * (see src/shared/starmap.ts for the API fields behind each one). View-only: nothing here
 * sends orders.
 *
 * URL options (query string or after the hash, e.g. /projector?brightness=0.7&flip=1):
 *   brightness=0.2–1   overall brightness (default 1)
 *   turn=minutes       minutes per full turn (default 4; 0 stops turning)
 *   labels=0           hide probe names and countdowns
 *   flip=1             upside down, for a ceiling-mounted projector
 *   mirror=1           mirrored, for rear projection
 *   backdrop=0         hide the faint decorative dust in the far background
 */

interface Opts {
  brightness: number;
  turnMinutes: number;
  labels: boolean;
  flip: boolean;
  mirror: boolean;
  backdrop: boolean;
}

function readOpts(): Opts {
  const q = new URLSearchParams(location.search + "&" + (location.hash.split("?")[1] ?? ""));
  const n = (k: string, d: number, lo: number, hi: number) => {
    const v = Number(q.get(k));
    return q.has(k) && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  };
  return {
    brightness: n("brightness", 1, 0.2, 1),
    turnMinutes: n("turn", 4, 0, 120),
    labels: q.get("labels") !== "0",
    flip: q.get("flip") === "1",
    mirror: q.get("mirror") === "1",
    backdrop: q.get("backdrop") !== "0",
  };
}

export function ProjectorView() {
  const { state } = useLiveState();
  const [data, setData] = useState<StarMapData | null>(null);
  const [failed, setFailed] = useState(false);
  const pollKey = state?.snapshot.lastPollFinishedAt ?? null;
  useReloadOnNewVersion();
  useEffect(() => {
    fetch("panel-api/starmap")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d: StarMapData) => { setData(d); setFailed(false); })
      .catch(() => setFailed(true));
  }, [pollKey]);

  const opts = useRef(readOpts()).current;
  const transform = [opts.flip ? "rotate(180deg)" : "", opts.mirror ? "scaleX(-1)" : ""].join(" ").trim();
  return (
    <div className="projector" style={{ transform: transform || undefined, filter: opts.brightness < 1 ? `brightness(${opts.brightness})` : undefined }}>
      <StarCanvas data={data} opts={opts} />
      {!data && <div className="projector-wait">{failed ? "Waiting for the panel…" : "Connecting…"}</div>}
    </div>
  );
}

// ---------- drawing ----------

function StarCanvas({ data, opts }: { data: StarMapData | null; opts: Opts }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const renderer = new StarRenderer();
    let raf = 0;
    let last = 0;
    const start = performance.now();
    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (t - last < 33) return; // ~30 fps is plenty for slow motion and keeps small boxes cool
      last = t;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      const secs = (t - start) / 1000;
      const yaw = opts.turnMinutes > 0 ? (secs / (opts.turnMinutes * 60)) * Math.PI * 2 : 0.6;
      const pitch = 0.42 + Math.sin(secs / 47) * 0.08;
      renderer.render(ctx, W, H, secs, dataRef.current, { yaw, pitch, zoom: 1, focus: null }, {
        labels: opts.labels, vignette: true, backdrop: opts.backdrop, mood: true, selected: null, labelSize: 0.03,
      });
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [opts]);

  return <canvas ref={ref} className="projector-canvas" aria-label="Star map of explored sectors and probes" />;
}
