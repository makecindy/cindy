import { createHash, randomUUID } from 'node:crypto';
import type { AgentInputSerializedFile } from '../../shared/agentInputQueue.js';
import { PLUGIN_ATTACHMENT_MAX_BYTES, validPluginMessageAttachments } from '../../shared/pluginAttachments.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { blobUrl, extForMime } from './blobStore.js';
import { ingestMedia } from './ingest.js';
import { sniffMediaMime } from './sniffMediaMime.js';

export interface PluginMessageImage {
  buffer: Buffer;
  mimeType: string;
  hash: string;
  name: string;
}
// Shared by tasks and targets, including time spent waiting for their receipt locks.
let inFlightBytes = 0;
export async function withParsedPluginMessageAttachments<T>(
  value: unknown,
  use: (images: PluginMessageImage[]) => Promise<T>,
): Promise<T> {
  const invalid = () => Object.assign(new Error('INVALID_ATTACHMENTS'), { code: 'INVALID_ATTACHMENTS' });
  if (!validPluginMessageAttachments(value)) throw invalid();
  const bytes = (value ?? []).reduce((total, item) => total + item.base64.length / 4 * 3
    - (item.base64.endsWith('==') ? 2 : item.base64.endsWith('=') ? 1 : 0), 0);
  if (inFlightBytes + bytes > PLUGIN_ATTACHMENT_MAX_BYTES * 2)
    throw Object.assign(new Error('TASK_BUSY'), { code: 'TASK_BUSY', retryable: true });
  inFlightBytes += bytes;
  try {
    const images = (value ?? []).map(item => {
      const buffer = Buffer.from(item.base64, 'base64');
      const mimeType = sniffMediaMime(buffer);
      if (!mimeType || !['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)
        || buffer.toString('base64') !== item.base64) throw invalid();
      return { buffer, mimeType, hash: createHash('sha256').update(buffer).digest('hex'),
        name: item.name ?? `image${extForMime(mimeType)}` };
    });
    return await use(images);
  } finally {
    inFlightBytes -= bytes;
  }
}

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
