import { randomUUID } from 'node:crypto';
import type { AgentInputSerializedFile } from '../../shared/agentInputQueue.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { blobUrl, extForMime } from './blobStore.js';
import { ingestMedia } from './ingest.js';

export { withParsedPluginMessageAttachments } from '@cindy/plugin-runtime/pluginMessageAttachments';
export type { PluginMessageImage } from '@cindy/plugin-runtime/pluginMessageAttachments';
import type { PluginMessageImage } from '@cindy/plugin-runtime/pluginMessageAttachments';

// Extend the existing draft/queued-message live set across import → durable queue.
// Register before the first await, including deduplicated blobs older than the GC buffer.
const inFlight = new Set<string[]>();
export function collectPluginAttachmentPayloadTexts(): string[] {
  return [...inFlight].map(urls => JSON.stringify(urls));
}
export async function withPluginMessageAttachments<T>(
  images: PluginMessageImage[],
  assertCurrent: () => void,
  deliver: (files: AgentInputSerializedFile[]) => Promise<T>,
): Promise<T> {
  assertCurrent();
  if (!images.length) return deliver([]);
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot) throw Object.assign(new Error('HOST_NOT_READY'), { code: 'HOST_NOT_READY' });
  const guard = () => {
    assertCurrent();
    if (snapshot !== getCurrentDbClientSnapshot())
      throw Object.assign(new Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' });
  };
  const urls = images.map(image => blobUrl(image.hash, extForMime(image.mimeType) ?? '.png'));
  inFlight.add(urls);
  try {
    const files = [];
    for (const image of images) {
      const media = await ingestMedia({ buffer: image.buffer, mimeType: image.mimeType,
        isCache: false, refs: [], assertStillValid: guard }, snapshot.client.drizzle);
      guard();
      files.push({ id: randomUUID(), name: image.name, originalName: image.name, category: 'image' as const,
        path: '', ext: media.ext, size: media.bytes, mimeType: media.mimeType, url: media.url });
    }
    // Caller awaits the existing durable queue write, or same-turn message persistence.
    // Those existing owners protect the URL after this in-flight scope is released.
    return await deliver(files);
  } finally {
    inFlight.delete(urls);
  }
}
