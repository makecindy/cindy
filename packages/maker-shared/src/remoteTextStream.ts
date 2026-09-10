/** Shared remote-stream rules. Stores, notifications and clocks belong to adapters. */
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : undefined;

export function isRemoteTextDelta(event: unknown): boolean {
  const value = record(event);
  const data = record(value?.data);
  return value?.type === 'text' && data?.isFinal === false && data.isFullText !== true
    && typeof data.text === 'string' && data.text.length > 0;
}

export function readRemoteTextSnapshot(event: unknown): { text: string; createdAt?: string; truncated: boolean } | undefined {
  const value = record(event);
  const data = record(value?.data);
  if (value?.type !== 'text' || data?.isFinal !== false || data.isFullText !== true
    || typeof data.text !== 'string' || !data.text) return undefined;
  const createdAt = typeof data.createdAt === 'string' && Number.isFinite(Date.parse(data.createdAt))
    ? new Date(data.createdAt).toISOString() : undefined;
  return { text: data.text, createdAt,
    truncated: value.__deviceLinkTruncated === true || data.__deviceLinkTruncated === true };
}

/** A repair replaces the prefix; it cannot overwrite a durable row or use a truncated prefix. */
export function reconcileRemoteText(current: string, incoming: string, options: {
  snapshot: boolean; durable: boolean; truncated?: boolean;
}): string {
  if (!options.snapshot) return current + incoming;
  return options.durable || options.truncated ? current : incoming;
}

export function consumeRemoteSessionSync(payload: unknown, adapter: {
  applyEvent(payload: RecordValue): void;
  invalidateHistory(sessionId: string): void;
}): void {
  const value = record(payload);
  if (!value || typeof value.sessionId !== 'string' || !value.sessionId) return;
  // Keep this order: older local batches flush before the snapshot, then history reconciles.
  const snapshot = readRemoteTextSnapshot(value.event);
  if (snapshot && !snapshot.truncated && typeof value.persistId === 'string' && value.persistId.trim()) {
    adapter.applyEvent(value);
  }
  if (value.resyncRequired === true) adapter.invalidateHistory(value.sessionId);
}
