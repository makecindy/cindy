/**
 * The bytes of a Codex generated image: decoding and bounded reading, with no media store.
 * Moved verbatim from generatedMedia.ts so the Node Host loads it without the desktop's
 * blob store (generatedMedia.ts re-exports these names).
 */

import { sniffMediaMime } from './sniffMediaMime';
import { readBoundedFileNoFollow } from '../utils/readBoundedFile';

export interface GeneratedImageSource {
  data?: string;
  url?: string;
  path?: string;
  pathOrigin?: 'remote-agent';
}

export const MAX_GENERATED_IMAGE_BYTES = 20 * 1024 * 1024;

/** Decode only in the Host. Declared MIME and filename do not establish the image type. */
export function generatedImageBytes(data: GeneratedImageSource): { mimeType: string; buffer: Buffer } | null {
  const encoded = data.data ?? (data.url?.startsWith('data:')
    ? /^data:image\/[a-zA-Z0-9.+-]+;base64,([\s\S]*)$/.exec(data.url)?.[1]
    : undefined);
  if (encoded === undefined) return null;
  if (encoded.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 + 4096)
    throw new Error('MEDIA_TOO_LARGE');
  const compact = encoded.replace(/\s/g, '');
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1)
    throw new Error('INVALID_IMAGE');
  const buffer = Buffer.from(compact, 'base64');
  if (buffer.length > MAX_GENERATED_IMAGE_BYTES) throw new Error('MEDIA_TOO_LARGE');
  if (buffer.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, ''))
    throw new Error('INVALID_IMAGE');
  const mimeType = sniffMediaMime(buffer);
  if (!mimeType?.startsWith('image/')) throw new Error('INVALID_IMAGE');
  return { buffer, mimeType };
}

/** Read on the machine that owns the native file, before crossing the transport boundary. */
export async function readGeneratedImageFile(sourcePath: string): Promise<{ buffer: Buffer; mimeType: string }> {
  if (/^[\\/]{2}|^[\\/]\?\?[\\/]/.test(sourcePath)) throw new Error('INVALID_IMAGE_SOURCE');
  const buffer = await readBoundedFileNoFollow(sourcePath, MAX_GENERATED_IMAGE_BYTES, { nonBlocking: true });
  if (!buffer?.length) throw new Error('INVALID_IMAGE_SOURCE');
  const mimeType = sniffMediaMime(buffer);
  if (!mimeType?.startsWith('image/')) throw new Error('INVALID_IMAGE');
  return { buffer, mimeType };
}
