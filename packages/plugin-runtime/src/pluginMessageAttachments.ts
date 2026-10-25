import { createHash } from 'node:crypto';
import { sniffMediaMime, extForMime } from '@cindy/media-core';
import { PLUGIN_ATTACHMENT_MAX_BYTES, validPluginMessageAttachments } from './shared/pluginAttachments.js';

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

