/** A batch publishes only after the caller has produced a usable request. */
export interface PreserveAttachment {
  (bytes: Buffer, mimeType: string, index: number): Promise<string>;
  find?(hash: string, mimeType: string): Promise<string | null>;
}
export type PreserveAttachmentBatch = <T>(
  signal: AbortSignal,
  operation: (preserve: PreserveAttachment) => Promise<T | null>,
) => Promise<T | null>;

// Bindings are installed by the authenticated run, never by request headers.
// Replacing/closing a run cannot release a newer run's binding.
const hosted = new Map<string, PreserveAttachmentBatch>();
export function bindHostedAttachmentPreservation(sessionId: string, batch: PreserveAttachmentBatch): () => void {
  hosted.set(sessionId, batch);
  return () => { if (hosted.get(sessionId) === batch) hosted.delete(sessionId); };
}
export function hostedAttachmentPreservation(sessionId: string): PreserveAttachmentBatch | undefined {
  return hosted.get(sessionId);
}
