import { useEffect, useRef, useState } from "react";
import { useLiveState } from "./useLiveState";
import { useReloadOnNewVersion } from "./TvView";
import type { StarMapData, StarMapSector, StarMapFrontier, StarMapProbe } from "../shared/starmap";

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

type Vec = { x: number; y: number; z: number };
const key = (v: Vec) => `${v.x},${v.y},${v.z}`;

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

interface Cam { cx: number; cy: number; cz: number; r: number }

function bounds(d: StarMapData): Cam {
  const pts: Vec[] = [...d.sectors.map((s) => s.pos), ...d.probes.flatMap((p) => [p.pos, p.move?.target].filter((v): v is Vec => !!v))];
  if (!pts.length) pts.push({ x: 0, y: 0, z: 0 });
  const c = pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length, z: a.z + p.z / pts.length }), { x: 0, y: 0, z: 0 });
  // Frontier only nudges the frame so a big ring of scans doesn't shrink the empire to a dot.
  const r = Math.max(2.2, ...pts.map((p) => Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z)), ...d.frontier.map((f) => Math.hypot(f.pos.x - c.x, f.pos.y - c.y, f.pos.z - c.z) * 0.8));
  return { cx: c.x, cy: c.y, cz: c.z, r };
}

const isNeighbour = (a: Vec, b: Vec) => {
  const d = [Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z)].sort();
  return d[0] === 0 && d[1] === 1 && d[2] === 1;
};

/** Deterministic pseudo-random so the backdrop doesn't jump on reload. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function StarCanvas({ data, opts }: { data: StarMapData | null; opts: Opts }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    let last = 0;
    let cam: Cam | null = null;
    const start = performance.now();
    const rand = rng(7);
    const dust = Array.from({ length: 220 }, () => ({ a: rand() * Math.PI * 2, e: Math.asin(rand() * 2 - 1), b: 0.25 + rand() * 0.75 }));

    const frame = (t: number) => {
      raf = requestAnimationFrame(frame);
      if (t - last < 33) return; // ~30 fps is plenty for slow motion and keeps small boxes cool
      last = t;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      const d = dataRef.current;
      const secs = (t - start) / 1000;
      const yaw = opts.turnMinutes > 0 ? (secs / (opts.turnMinutes * 60)) * Math.PI * 2 : 0.6;
      const pitch = 0.42 + Math.sin(secs / 47) * 0.08;
      const U = Math.min(W, H);

      if (opts.backdrop) drawDust(ctx, dust, yaw, pitch, W, H, U);
      if (!d) return;

      const target = bounds(d);
      cam = cam ? {
        cx: cam.cx + (target.cx - cam.cx) * 0.03, cy: cam.cy + (target.cy - cam.cy) * 0.03,
        cz: cam.cz + (target.cz - cam.cz) * 0.03, r: cam.r + (target.r - cam.r) * 0.03,
      } : target;

      // Game x/y is the map plane; game z is drawn as "up".
      const dist = cam.r * 2.5 + 2;
      const f = U * 1.35;
      const cy0 = Math.cos(yaw), sy0 = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      const project = (v: Vec) => {
        const X = v.x - cam!.cx, Y = v.z - cam!.cz, Z = v.y - cam!.cy;
        const x1 = X * cy0 - Z * sy0, z1 = X * sy0 + Z * cy0;
        const y2 = Y * cp - z1 * sp, z2 = Y * sp + z1 * cp;
        const s = f / (z2 + dist);
        // depth: 0 nearest .. 1 farthest
        const depth = Math.min(1, Math.max(0, (z2 + cam!.r) / (2 * cam!.r)));
        return { x: W / 2 + x1 * s, y: H / 2 - y2 * s, s: s / f * dist, depth };
      };
      const fade = (depth: number) => 1 - depth * 0.55;
      const pulse = (period: number, phase = 0) => 0.5 + 0.5 * Math.sin((secs / period + phase) * Math.PI * 2);
      const base = U / 90; // one "unit" of mark size

      // Links between neighbouring explored sectors; brighter where both share a SCUT network.
      ctx.lineCap = "round";
      for (let i = 0; i < d.sectors.length; i++) for (let j = i + 1; j < d.sectors.length; j++) {
        const a = d.sectors[i], b = d.sectors[j];
        if (!isNeighbour(a.pos, b.pos)) continue;
        const pa = project(a.pos), pb = project(b.pos);
        const scut = a.scutNetworkIds.some((n) => b.scutNetworkIds.includes(n));
        const al = fade((pa.depth + pb.depth) / 2);
        ctx.strokeStyle = scut ? `rgba(90,230,210,${0.55 * al})` : `rgba(120,150,200,${0.22 * al})`;
        ctx.lineWidth = (scut ? 0.45 : 0.25) * base;
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      }

      // Painter's order: far things first.
      type Item = { depth: number; draw: () => void };
      const items: Item[] = [];
      for (const fr of d.frontier) {
        const p = project(fr.pos);
        items.push({ depth: p.depth, draw: () => drawFrontier(ctx, fr, p, base, fade(p.depth), pulse(6, fr.pos.x * 0.13)) });
      }
      for (const s of d.sectors) {
        const p = project(s.pos);
        items.push({ depth: p.depth, draw: () => drawSector(ctx, s, p, base, fade(p.depth), secs, pulse) });
      }
      const home = project({ x: 0, y: 0, z: 0 });
      items.push({ depth: home.depth, draw: () => {
        ctx.strokeStyle = `rgba(200,210,255,${0.35 * fade(home.depth)})`;
        ctx.lineWidth = 0.25 * base;
        ctx.setLineDash([0.6 * base, 0.6 * base]);
        ctx.beginPath(); ctx.arc(home.x, home.y, 3.2 * base * home.s, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      } });
      items.sort((a, b) => b.depth - a.depth).forEach((i) => i.draw());

      // Probes on top, grouped per sector so names don't overprint.
      const now = Date.now();
      const groups = new Map<string, StarMapProbe[]>();
      const labels: Array<{ x: number; y: number; lines: string[]; color: string }> = [];
      for (const pr of d.probes) {
        if (pr.move) {
          const a = project(pr.move.origin), b = project(pr.move.target);
          const t0 = Date.parse(pr.move.startedAt), t1 = Date.parse(pr.move.arrivalAt);
          const k = t1 > t0 ? Math.min(1, Math.max(0, (now - t0) / (t1 - t0))) : 0;
          ctx.strokeStyle = "rgba(120,220,255,0.55)";
          ctx.lineWidth = 0.35 * base;
          ctx.setLineDash([1.2 * base, 1 * base]);
          ctx.lineDashOffset = -secs * base * 1.5;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          ctx.setLineDash([]);
          const x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k;
          // comet tail
          const tx = a.x + (b.x - a.x) * Math.max(0, k - 0.12), ty = a.y + (b.y - a.y) * Math.max(0, k - 0.12);
          const g = ctx.createLinearGradient(tx, ty, x, y);
          g.addColorStop(0, "rgba(120,220,255,0)"); g.addColorStop(1, "rgba(160,235,255,0.9)");
          ctx.strokeStyle = g; ctx.lineWidth = 0.9 * base;
          ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(x, y); ctx.stroke();
          glow(ctx, x, y, 2.6 * base, "160,235,255", 0.9);
          dot(ctx, x, y, 0.75 * base, "#eaffff");
          const left = Math.max(0, t1 - now);
          labels.push({ x, y, lines: [pr.name, left > 0 ? countdown(left) : "arriving"], color: "#9fe8ff" });
          continue;
        }
        if (!pr.pos) continue;
        const k = key(pr.pos);
        groups.set(k, [...(groups.get(k) ?? []), pr]);
      }
      for (const [, list] of groups) {
        const p = project(list[0].pos!);
        list.forEach((pr, i) => {
          const ang = (i / list.length) * Math.PI * 2 + secs / 9;
          const orbit = list.length > 1 ? 2.2 * base * p.s : 0;
          const x = p.x + Math.cos(ang) * orbit, y = p.y + Math.sin(ang) * orbit * 0.5;
          if (pr.station) {
            glow(ctx, x, y, 2.8 * base, "255,200,90", 0.55 + 0.25 * pulse(5));
            diamond(ctx, x, y, 1.1 * base, "#ffd27a");
          } else if (!pr.reachable) {
            ctx.strokeStyle = "rgba(160,200,255,0.8)"; ctx.lineWidth = 0.3 * base;
            ctx.beginPath(); ctx.arc(x, y, 0.8 * base, 0, Math.PI * 2); ctx.stroke();
          } else {
            glow(ctx, x, y, 2.6 * base, "140,230,255", 0.45 + 0.3 * pulse(4, i * 0.3));
            dot(ctx, x, y, 0.7 * base, "#eaffff");
          }
        });
        const bad = list.filter((pr) => ["disabled", "dead", "trapped_by_black_hole"].includes(pr.status));
        labels.push({
          x: p.x, y: p.y,
          lines: [list.map((pr) => pr.name).join(" · "), ...bad.map((pr) => `${pr.name}: ${pr.status.replace(/_/g, " ")}`)],
          color: bad.length ? "#ff8a7a" : list.some((pr) => pr.station) ? "#ffd27a" : "#cdeeff",
        });
      }
      if (opts.labels) drawLabels(ctx, labels, U, W, H);

      // Room mood: a soft glow from the bottom edge when something needs attention.
      if (d.mood !== "calm") {
        const c = d.mood === "critical" ? "255,70,60" : "255,170,40";
        const a = (d.mood === "critical" ? 0.22 : 0.12) * (0.6 + 0.4 * pulse(d.mood === "critical" ? 3 : 8));
        const g = ctx.createRadialGradient(W / 2, H * 1.25, 0, W / 2, H * 1.25, H * 0.95);
        g.addColorStop(0, `rgba(${c},${a})`); g.addColorStop(1, `rgba(${c},0)`);
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }

      // Fade every edge to black so no projected rectangle shows on the wall.
      const v = ctx.createRadialGradient(W / 2, H / 2, U * 0.35, W / 2, H / 2, Math.hypot(W, H) / 2);
      v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,1)");
      ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [opts]);

  return <canvas ref={ref} className="projector-canvas" aria-label="Star map of explored sectors and probes" />;
}

type P = { x: number; y: number; s: number; depth: number };
type Ctx = CanvasRenderingContext2D;

function glow(ctx: Ctx, x: number, y: number, r: number, rgb: string, a: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${rgb},${a})`); g.addColorStop(0.35, `rgba(${rgb},${a * 0.35})`); g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}
function dot(ctx: Ctx, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}
function diamond(ctx: Ctx, x: number, y: number, r: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); ctx.fill();
}

function drawDust(ctx: Ctx, dust: Array<{ a: number; e: number; b: number }>, yaw: number, pitch: number, W: number, H: number, U: number) {
  // Far-off decoration on a sphere, turning at a tenth of the map's speed. It carries no data.
  for (const s of dust) {
    const a = s.a + yaw * 0.1;
    const x = Math.cos(s.e) * Math.cos(a), y = Math.sin(s.e), z = Math.cos(s.e) * Math.sin(a);
    const y2 = y * Math.cos(pitch * 0.3) - z * Math.sin(pitch * 0.3);
    const px = W / 2 + x * U * 1.1, py = H / 2 - y2 * U * 0.9;
    if (px < 0 || px > W || py < 0 || py > H) continue;
    ctx.fillStyle = `rgba(170,185,220,${0.1 + 0.18 * s.b})`;
    ctx.fillRect(px, py, U / 700 + 1, U / 700 + 1);
  }
}

function drawSector(ctx: Ctx, s: StarMapSector, p: P, base: number, al: number, secs: number, pulse: (period: number, phase?: number) => number) {
  const pr = s.profile;
  const sc = p.s;
  if (pr && pr.dustClouds > 0) glow(ctx, p.x, p.y, 7 * base * sc, "150,110,220", 0.22 * al);
  if (pr && pr.blackHoles > 0) {
    // Accretion ring around a dark core.
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(0.35);
    const r = 2.4 * base * sc;
    glow(ctx, 0, 0, r * 2.2, "255,120,60", 0.35 * al);
    ctx.strokeStyle = `rgba(255,170,90,${0.85 * al})`;
    ctx.lineWidth = 0.45 * base;
    ctx.beginPath(); ctx.ellipse(0, 0, r * 1.5, r * 0.45, 0, 0, Math.PI * 2); ctx.stroke();
    dot(ctx, 0, 0, r * 0.7, "#000");
    ctx.restore();
  }
  if (pr && pr.stars > 0) {
    const r = (1 + Math.min(pr.stars, 3) * 0.35) * base * sc;
    glow(ctx, p.x, p.y, r * 4.2, "255,190,100", 0.55 * al * (0.9 + 0.1 * pulse(7, p.x)));
    dot(ctx, p.x, p.y, r, `rgba(255,236,200,${al})`);
    // A faint orbit per planet the scan listed (up to four).
    for (let i = 0; i < Math.min(pr.planets, 4); i++) {
      const rr = r * (2.2 + i * 0.9);
      ctx.strokeStyle = `rgba(255,220,170,${0.16 * al})`;
      ctx.lineWidth = Math.max(1, 0.15 * base);
      ctx.beginPath(); ctx.ellipse(p.x, p.y, rr, rr * 0.42, 0, 0, Math.PI * 2); ctx.stroke();
      const ang = secs / (14 + i * 9) + i * 2.1;
      dot(ctx, p.x + Math.cos(ang) * rr, p.y + Math.sin(ang) * rr * 0.42, Math.max(1.2, 0.28 * base * sc), `rgba(200,220,255,${0.75 * al})`);
    }
  } else if (!pr || pr.blackHoles === 0) {
    // Empty space we've been to (or not scanned yet): a cool small marker.
    glow(ctx, p.x, p.y, 1.8 * base * sc, "120,160,230", 0.35 * al);
    dot(ctx, p.x, p.y, 0.45 * base * sc, `rgba(170,200,255,${(pr ? 0.8 : 0.5) * al})`);
  }
  if (pr && pr.relays > 0) diamond(ctx, p.x + 1.8 * base * sc, p.y - 1.8 * base * sc, 0.45 * base * sc, `rgba(90,230,210,${al})`);
  if (pr && pr.refuelStations > 0) dot(ctx, p.x - 1.8 * base * sc, p.y - 1.8 * base * sc, 0.4 * base * sc, `rgba(190,140,255,${al})`);
  if (pr && pr.missiles > 0 && pulse(1.2) > 0.5) dot(ctx, p.x + 2 * base * sc, p.y + 1.4 * base * sc, 0.5 * base * sc, "#ff4a3a");
  if (s.newDiscovery) {
    // Unread potential blueprint: a slow cyan beacon.
    const k = pulse(2.5);
    ctx.strokeStyle = `rgba(110,240,255,${(0.45 + 0.5 * k) * al})`;
    ctx.lineWidth = 0.4 * base;
    ctx.beginPath(); ctx.arc(p.x, p.y, (3 + k * 1.2) * base * sc, 0, Math.PI * 2); ctx.stroke();
  } else if (pr && pr.constructs > 0) {
    dot(ctx, p.x + 1.9 * base * sc, p.y + 1.6 * base * sc, 0.4 * base * sc, `rgba(110,240,255,${0.8 * al})`);
  }
  if (pr && pr.ducks > 0) {
    ctx.font = `${1.6 * base * sc}px system-ui, "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.globalAlpha = al;
    ctx.fillText("🦆", p.x - 2.4 * base * sc, p.y + 1.8 * base * sc);
    ctx.globalAlpha = 1;
  }
}

function drawFrontier(ctx: Ctx, f: StarMapFrontier, p: P, base: number, al: number, k: number) {
  const sc = p.s;
  const conf = 0.4 + 0.6 * Math.min(1, Math.max(0, f.confidence));
  if (f.blackHoleProbability >= 0.05) glow(ctx, p.x, p.y, (2.5 + f.blackHoleProbability * 10) * base * sc, "255,60,50", (0.18 + 0.1 * k) * al);
  if (f.star) glow(ctx, p.x, p.y, 2.4 * base * sc, "255,200,130", 0.14 * al * conf);
  ctx.strokeStyle = `rgba(170,190,230,${0.3 * al * conf})`;
  ctx.lineWidth = Math.max(1, 0.15 * base);
  ctx.setLineDash([0.35 * base, 0.5 * base]);
  ctx.beginPath(); ctx.arc(p.x, p.y, 1.1 * base * sc, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
}

function countdown(ms: number): string {
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${Math.round(h / 24)} days`;
}

function drawLabels(ctx: Ctx, labels: Array<{ x: number; y: number; lines: string[]; color: string }>, U: number, W: number, H: number) {
  const size = Math.max(14, U * 0.03);
  ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const l of labels.sort((a, b) => a.y - b.y)) {
    const h = size * 1.2 * l.lines.length;
    let x = l.x + size * 0.9, y = l.y - h / 2;
    ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const w = Math.max(...l.lines.map((s, i) => { ctx.font = `${i === 0 ? 600 : 400} ${size * (i === 0 ? 1 : 0.8)}px system-ui, sans-serif`; return ctx.measureText(s).width; }));
    if (x + w > W * 0.92) x = l.x - size * 0.9 - w;
    // Nudge down past labels already placed.
    for (const o of placed) if (x < o.x + o.w && x + w > o.x && y < o.y + o.h && y + h > o.y) y = o.y + o.h + size * 0.2;
    y = Math.min(Math.max(y, H * 0.06), H * 0.94 - h);
    placed.push({ x, y, w, h });
    l.lines.forEach((s, i) => {
      ctx.font = `${i === 0 ? 600 : 400} ${size * (i === 0 ? 1 : 0.8)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.fillStyle = i === 0 ? l.color : "rgba(200,215,240,0.75)";
      ctx.fillText(s, x, y + size * 0.6 + i * size * 1.2);
    });
  }
}
