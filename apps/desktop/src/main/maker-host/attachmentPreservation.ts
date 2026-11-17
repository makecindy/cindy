import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';

/** Lookup and storage must classify the same bytes, not trust their declared MIME. */
export function attachmentMimeType(bytes: Buffer, declaredMime: string): string {
  return sniffMediaMime(bytes.subarray(0, 64 * 1024), declaredMime)
    ?? (bytes.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf' : 'application/octet-stream');
}

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
