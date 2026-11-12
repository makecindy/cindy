import { createHash } from 'node:crypto';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';
import { prepareWallpaperImage } from '../custom-wallpaper.js';

export interface LoadedAppearanceResource {
  kind: 'font' | 'image' | 'video';
  bytes: Buffer;
  mimeType: string;
  hash: string;
}

export const APPEARANCE_RESOURCE_MAX_BYTES = { font: 10_485_760, image: 20 * 1024 * 1024, video: 100 * 1024 * 1024 } as const;

/** Shared byte validation; source-specific resolvers remain responsible for grants. */
export function inspectAppearanceResource(bytes: Buffer, expected: LoadedAppearanceResource['kind'] | 'wallpaper') {
  if (!bytes.length) throw new Error('RESOURCE_UNAVAILABLE');
  const kind = expected === 'wallpaper' ? sniffMediaMime(bytes) === 'video/mp4' ? 'video' : 'image' : expected;
  if (bytes.length > APPEARANCE_RESOURCE_MAX_BYTES[kind]) throw new Error('RESOURCE_TOO_LARGE');
  const mimeType = kind === 'font' ? validateAppearanceFont(bytes) : sniffMediaMime(bytes);
  if (kind === 'video' && mimeType !== 'video/mp4') throw new Error('RESOURCE_TYPE');
  // Images go through the existing decoder in prepareAppearanceResource; keep
  // the plugin API's original error and supported-format semantics unchanged.
  return { kind, mimeType: mimeType ?? 'application/octet-stream', hash: createHash('sha256').update(bytes).digest('hex') };
}

/** Theme packages and plugins use the same decoding, metadata stripping and hashes. */
export async function prepareAppearanceResource(bytes: Buffer, expected: LoadedAppearanceResource['kind'] | 'wallpaper'): Promise<LoadedAppearanceResource> {
  const inspected = inspectAppearanceResource(bytes, expected);
  if (inspected.kind !== 'image') return { ...inspected, bytes };
  const prepared = await prepareWallpaperImage(bytes);
  return { kind: 'image', bytes: prepared, mimeType: 'image/webp', hash: createHash('sha256').update(prepared).digest('hex') };
}

/** SFNT bounds precede Chromium's complete font validation. */
function validateAppearanceFont(bytes: Buffer): string {
  if (bytes.length < 12 || ![0x00010000, 0x4f54544f].includes(bytes.readUInt32BE(0))) throw new Error('INVALID_FONT');
  const tables = bytes.readUInt16BE(4);
  if (!tables || tables > 256 || 12 + tables * 16 > bytes.length) throw new Error('INVALID_FONT');
  const tags = new Set<string>();
  for (let i = 0; i < tables; i++) {
    const start = 12 + i * 16, offset = bytes.readUInt32BE(start + 8), length = bytes.readUInt32BE(start + 12);
    const tag = bytes.toString('ascii', start, start + 4);
    if (tags.has(tag) || offset < 12 + tables * 16 || offset + length > bytes.length) throw new Error('INVALID_FONT');
    tags.add(tag);
  }
  if (['head', 'maxp', 'cmap', 'name'].some(tag => !tags.has(tag))) throw new Error('INVALID_FONT');
  return bytes.readUInt32BE(0) === 0x4f54544f ? 'font/otf' : 'font/ttf';
}
