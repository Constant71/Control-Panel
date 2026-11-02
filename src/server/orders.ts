/**
 * Mannies that just received an order. The game applies orders
 * asynchronously, so the next snapshot may still show them idle; both the
 * fixer and the automation skip these for a short while to avoid double orders.
 */
const RECENT_MS = 2 * 60_000;
const recent = new Map<string, number>();

export function markOrdered(mannyId: string, at = Date.now()): void {
  recent.set(mannyId, at);
}

export function recentlyOrdered(now = Date.now()): Set<string> {
  for (const [id, at] of recent) if (now - at > RECENT_MS) recent.delete(id);
  return new Set(recent.keys());
}

export function clearOrders(): void {
  recent.clear();
}
