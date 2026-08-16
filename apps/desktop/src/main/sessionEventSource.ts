/**
 * Lightweight main-process event source for durable consumers such as Cindy
 * Bots. Producers publish facts without importing Bot/database services.
 */
export interface SessionMetadataPatchEvent {
  sessionId: string;
  patch: Record<string, unknown>;
  occurredAt: number;
}

const metadataListeners = new Set<(event: SessionMetadataPatchEvent) => void>();

export function subscribeSessionMetadataPatches(
  listener: (event: SessionMetadataPatchEvent) => void,
): () => void {
  metadataListeners.add(listener);
  return () => metadataListeners.delete(listener);
}

export function publishSessionMetadataPatch(
  sessionId: string,
  patch: Record<string, unknown>,
): void {
  if (!Object.hasOwn(patch, 'title') && !Object.hasOwn(patch, 'status')) return;
  const event = { sessionId, patch: { ...patch }, occurredAt: Date.now() };
  for (const listener of metadataListeners) {
    try {
      listener(event);
    } catch {
      // Event persistence is best-effort at the producer boundary. Consumers
      // own logging/retry and must never break the primary Session mutation.
    }
  }
}
