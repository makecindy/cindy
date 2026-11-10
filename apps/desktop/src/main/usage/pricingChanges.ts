// Main-side notification only; consumers reuse cached quotes and never request a sync.
const listeners = new Set<() => void>();

export function onUsagePricingChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyUsagePricingChanged(): void {
  for (const listener of listeners) queueMicrotask(listener);
}
