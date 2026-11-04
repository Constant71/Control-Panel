import type { StarMapData, StarMapSector, StarMapFrontier } from "../shared/starmap";

/**
 * Canvas renderer for the 3D star map, shared by the projector page (/projector) and the
 * interactive map on the Map page. Draws only what /panel-api/starmap returns (see
 * src/shared/starmap.ts); the far background specks are decoration and carry no data.
 */

export type Vec = { x: number; y: number; z: number };
export const vkey = (v: Vec) => `${v.x},${v.y},${v.z}`;

export interface View {
  yaw: number;
  pitch: number;
  /** 1 fits the whole empire; higher zooms in. */
  zoom: number;
  /** Sector to centre on; null centres on the whole empire. */
  focus: Vec | null;
}

export interface RenderOpts {
  labels: boolean;
  /** Fade the edges to black (projector). */
  vignette: boolean;
  backdrop: boolean;
  /** Tint the bottom edge from the worst open problem. */
  mood: boolean;
  selected: string | null;
  /** Label size as a share of the shorter side. */
  labelSize: number;
}

export interface Hit {
  key: string;
  kind: "sector" | "frontier" | "probe";
  x: number;
  y: number;
  r: number;
}

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

export function countdown(ms: number): string {
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${Math.round(h / 24)} days`;
}

export class StarRenderer {
  private cam: Cam | null = null;
  private readonly dust: Array<{ a: number; e: number; b: number }>;

  constructor() {
    const rand = rng(7);
    this.dust = Array.from({ length: 220 }, () => ({ a: rand() * Math.PI * 2, e: Math.asin(rand() * 2 - 1), b: 0.25 + rand() * 0.75 }));
  }

  /** Draws one frame and returns where every tappable thing landed on screen. */
  render(ctx: Ctx, W: number, H: number, secs: number, d: StarMapData | null, view: View, opts: RenderOpts): Hit[] {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    const { yaw, pitch } = view;
    const U = Math.min(W, H);
    if (opts.backdrop) drawDust(ctx, this.dust, yaw, pitch, W, H, U);
    if (!d) return [];

    const all = bounds(d);
    const target: Cam = view.focus
      ? { cx: view.focus.x, cy: view.focus.y, cz: view.focus.z, r: all.r / view.zoom }
      : { ...all, r: all.r / view.zoom };
    const c0 = this.cam;
    const cam: Cam = (this.cam = c0 ? {
      cx: c0.cx + (target.cx - c0.cx) * 0.08, cy: c0.cy + (target.cy - c0.cy) * 0.08,
      cz: c0.cz + (target.cz - c0.cz) * 0.08, r: c0.r + (target.r - c0.r) * 0.08,
    } : target);

    // Game x/y is the map plane; game z is drawn as "up".
    const dist = cam.r * 2.5 + 2;
    const f = U * 1.35;
    const cy0 = Math.cos(yaw), sy0 = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const project = (v: Vec): P => {
      const X = v.x - cam.cx, Y = v.z - cam.cz, Z = v.y - cam.cy;
      const x1 = X * cy0 - Z * sy0, z1 = X * sy0 + Z * cy0;
      const y2 = Y * cp - z1 * sp, z2 = Y * sp + z1 * cp;
      const s = f / Math.max(0.3, z2 + dist);
      const depth = Math.min(1, Math.max(0, (z2 + cam.r) / (2 * cam.r)));
      return { x: W / 2 + x1 * s, y: H / 2 - y2 * s, s: Math.min(4, (s / f) * dist), depth, behind: z2 + dist < 0.3 };
    };
    const fade = (depth: number) => 1 - depth * 0.55;
    const pulse = (period: number, phase = 0) => 0.5 + 0.5 * Math.sin((secs / period + phase) * Math.PI * 2);
    const base = U / 90;
    const hits: Hit[] = [];

    // Links between neighbouring explored sectors; brighter where both share a SCUT network.
    ctx.lineCap = "round";
    for (let i = 0; i < d.sectors.length; i++) for (let j = i + 1; j < d.sectors.length; j++) {
      const a = d.sectors[i], b = d.sectors[j];
      if (!isNeighbour(a.pos, b.pos)) continue;
      const pa = project(a.pos), pb = project(b.pos);
      if (pa.behind || pb.behind) continue;
      const scut = a.scutNetworkIds.some((n) => b.scutNetworkIds.includes(n));
      const al = fade((pa.depth + pb.depth) / 2);
      ctx.strokeStyle = scut ? `rgba(90,230,210,${0.55 * al})` : `rgba(120,150,200,${0.22 * al})`;
      ctx.lineWidth = (scut ? 0.45 : 0.25) * base;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    }

    // Painter's order: far things first.
    const items: Array<{ depth: number; draw: () => void }> = [];
    for (const fr of d.frontier) {
      const p = project(fr.pos);
      if (p.behind) continue;
      hits.push({ key: vkey(fr.pos), kind: "frontier", x: p.x, y: p.y, r: Math.max(1.6 * base * p.s, 14) });
      items.push({ depth: p.depth, draw: () => drawFrontier(ctx, fr, p, base, fade(p.depth), pulse(6, fr.pos.x * 0.13)) });
    }
    for (const s of d.sectors) {
      const p = project(s.pos);
      if (p.behind) continue;
      hits.push({ key: vkey(s.pos), kind: "sector", x: p.x, y: p.y, r: Math.max(2.4 * base * p.s, 18) });
      items.push({ depth: p.depth, draw: () => drawSector(ctx, s, p, base, fade(p.depth), secs, pulse) });
    }
    const home = project({ x: 0, y: 0, z: 0 });
    if (!home.behind) items.push({ depth: home.depth, draw: () => {
      ctx.strokeStyle = `rgba(200,210,255,${0.35 * fade(home.depth)})`;
      ctx.lineWidth = 0.25 * base;
      ctx.setLineDash([0.6 * base, 0.6 * base]);
      ctx.beginPath(); ctx.arc(home.x, home.y, 3.2 * base * home.s, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    } });
    items.sort((a, b) => b.depth - a.depth).forEach((i) => i.draw());

    // Selection brackets.
    if (opts.selected) {
      const [x, y, z] = opts.selected.split(",").map(Number);
      const p = project({ x, y, z });
      if (!p.behind) {
        const r = Math.max(3.4 * base * p.s, 16);
        const l = r * 0.45;
        ctx.strokeStyle = "rgba(255,255,255,0.95)";
        ctx.lineWidth = Math.max(2, 0.3 * base);
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          ctx.beginPath();
          ctx.moveTo(p.x + sx * r, p.y + sy * (r - l)); ctx.lineTo(p.x + sx * r, p.y + sy * r); ctx.lineTo(p.x + sx * (r - l), p.y + sy * r);
          ctx.stroke();
        }
      }
    }

    // Probes on top, grouped per sector so names don't overprint.
    const now = Date.now();
    const groups = new Map<string, typeof d.probes>();
    const labels: Label[] = [];
    for (const pr of d.probes) {
      if (pr.move) {
        const a = project(pr.move.origin), b = project(pr.move.target);
        if (a.behind || b.behind) continue;
        const t0 = Date.parse(pr.move.startedAt), t1 = Date.parse(pr.move.arrivalAt);
        const k = t1 > t0 ? Math.min(1, Math.max(0, (now - t0) / (t1 - t0))) : 0;
        ctx.strokeStyle = "rgba(120,220,255,0.55)";
        ctx.lineWidth = 0.35 * base;
        ctx.setLineDash([1.2 * base, 1 * base]);
        ctx.lineDashOffset = -secs * base * 1.5;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.setLineDash([]);
        const x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k;
        const tx = a.x + (b.x - a.x) * Math.max(0, k - 0.12), ty = a.y + (b.y - a.y) * Math.max(0, k - 0.12);
        const g = ctx.createLinearGradient(tx, ty, x, y);
        g.addColorStop(0, "rgba(120,220,255,0)"); g.addColorStop(1, "rgba(160,235,255,0.9)");
        ctx.strokeStyle = g; ctx.lineWidth = 0.9 * base;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(x, y); ctx.stroke();
        glow(ctx, x, y, 2.6 * base, "160,235,255", 0.9);
        dot(ctx, x, y, 0.75 * base, "#eaffff");
        hits.push({ key: vkey(pr.move.target), kind: "probe", x, y, r: Math.max(2 * base, 16) });
        const left = Math.max(0, t1 - now);
        labels.push({ x, y, lines: [pr.name, left > 0 ? countdown(left) : "arriving"], color: "#9fe8ff" });
        continue;
      }
      if (!pr.pos) continue;
      const k = vkey(pr.pos);
      groups.set(k, [...(groups.get(k) ?? []), pr]);
    }
    for (const [k, list] of groups) {
      const p = project(list[0].pos!);
      if (p.behind) continue;
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
        hits.push({ key: k, kind: "probe", x, y, r: Math.max(2 * base, 16) });
      });
      const bad = list.filter((pr) => ["disabled", "dead", "trapped_by_black_hole"].includes(pr.status));
      labels.push({
        x: p.x, y: p.y,
        lines: [list.map((pr) => pr.name).join(" · "), ...bad.map((pr) => `${pr.name}: ${pr.status.replace(/_/g, " ")}`)],
        color: bad.length ? "#ff8a7a" : list.some((pr) => pr.station) ? "#ffd27a" : "#cdeeff",
      });
    }
    if (opts.selected && !groups.has(opts.selected)) {
      const [x, y, z] = opts.selected.split(",").map(Number);
      const p = project({ x, y, z });
      if (!p.behind) labels.push({ x: p.x, y: p.y, lines: [`(${x}, ${y}, ${z})`], color: "#ffffff" });
    }
    if (opts.labels) drawLabels(ctx, labels, U * opts.labelSize, W, H);

    if (opts.mood && d.mood !== "calm") {
      const c = d.mood === "critical" ? "255,70,60" : "255,170,40";
      const a = (d.mood === "critical" ? 0.22 : 0.12) * (0.6 + 0.4 * pulse(d.mood === "critical" ? 3 : 8));
      const g = ctx.createRadialGradient(W / 2, H * 1.25, 0, W / 2, H * 1.25, H * 0.95);
      g.addColorStop(0, `rgba(${c},${a})`); g.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    if (opts.vignette) {
      // Fade every edge to black so no projected rectangle shows on the wall.
      const v = ctx.createRadialGradient(W / 2, H / 2, U * 0.35, W / 2, H / 2, Math.hypot(W, H) / 2);
      v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,1)");
      ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
    }
    return hits;
  }
}

/** The tappable thing nearest to a point, preferring probes, then visited sectors. */
export function hitTest(hits: Hit[], x: number, y: number): Hit | null {
  let best: Hit | null = null, bestScore = Infinity;
  const rank = { probe: 0, sector: 1, frontier: 2 } as const;
  for (const h of hits) {
    const d = Math.hypot(h.x - x, h.y - y);
    if (d > h.r) continue;
    const score = d / h.r + rank[h.kind] * 0.25;
    if (score < bestScore) { best = h; bestScore = score; }
  }
  return best;
}

type P = { x: number; y: number; s: number; depth: number; behind?: boolean };
type Ctx = CanvasRenderingContext2D;
type Label = { x: number; y: number; lines: string[]; color: string };


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

function drawLabels(ctx: Ctx, labels: Label[], sizePx: number, W: number, H: number) {
  const size = Math.max(13, sizePx);
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
