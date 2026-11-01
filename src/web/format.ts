export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 0) return "in " + span(-s);
  return span(s) + " ago";
}

export function until(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  return s <= 0 ? "due" : "in " + span(s);
}

export function span(totalSeconds: number): string {
  const s = Math.abs(Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export const pct = (n: number | undefined | null) => (n === undefined || n === null ? "—" : `${Math.round(n)}%`);
export const ece = (n: number | undefined | null) => (n === undefined || n === null ? "—" : `${n.toFixed(3)} ECE`);
export const label = (s: string | null | undefined) => (s ? s.replace(/_/g, " ") : "idle");
