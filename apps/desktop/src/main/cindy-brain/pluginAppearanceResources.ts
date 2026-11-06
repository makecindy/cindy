import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseGhostNativeUi } from '@cindy/plugin-protocol';
import { isPluginAppearanceResource } from '@cindy/maker-shared';
import { resolveGhostContentPath } from './ghostContentTree.js';
import { readBoundedFileNoFollow } from '../utils/readBoundedFile.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';
import type { PluginFileAccess } from '../mcp-apps/pluginFiles.js';

export interface LoadedPluginAppearanceResource {
  kind: 'font' | 'image' | 'video'; bytes: Buffer; mimeType: string; hash: string;
}
interface Source {
  instanceId: string;
  ghost: { dir: string; ui: unknown };
  files: PluginFileAccess;
  assertCurrent(): void;
}

/** Reuse the package content-tree guard and the Library/media ownership gate. */
export async function loadPluginAppearanceResource(
  source: Source, reference: string, expected: LoadedPluginAppearanceResource['kind'] | 'wallpaper',
): Promise<LoadedPluginAppearanceResource> {
  source.assertCurrent();
  if (!isPluginAppearanceResource(reference)) throw new Error('RESOURCE_UNAVAILABLE');
  const maxBytes = expected === 'font' ? 10 * 1024 * 1024 : expected === 'image' ? 20 * 1024 * 1024 : 100 * 1024 * 1024;
  let bytes: Buffer | null;
  let declaredKind: string | undefined;
  if (reference.startsWith('asset:')) {
    const ui = parseGhostNativeUi(source.ghost.ui);
    const resource = ui?.version === 1 && ui.appearance?.resources?.find(r => r.id === reference.slice(6));
    if (!resource) throw new Error('RESOURCE_UNAVAILABLE');
    declaredKind = resource.kind;
    if (expected === 'wallpaper' ? !['image', 'video'].includes(resource.kind) : resource.kind !== expected) throw new Error('RESOURCE_TYPE');
    if (!(await fs.lstat(source.ghost.dir)).isDirectory()) throw new Error('RESOURCE_UNAVAILABLE');
    const root = await fs.realpath(source.ghost.dir);
    const file = await resolveGhostContentPath(source.ghost.dir, resource.path, { expect: 'file', label: 'plugin appearance' });
    bytes = await readBoundedFileNoFollow(file, maxBytes, { containWithin: root, nonBlocking: true, rejectHardLinks: true,
      maxBytesForPrefix: prefix => sniffMediaMime(prefix)?.startsWith('image/') ? Math.min(maxBytes, 20 * 1024 * 1024) : maxBytes });
    await resolveGhostContentPath(source.ghost.dir, resource.path, { expect: 'file', label: 'plugin appearance' });
  } else {
    const info = await source.files.describe(source.instanceId, reference);
    source.assertCurrent();
    if (!info || info.size < 1 || info.size > maxBytes) throw new Error('RESOURCE_UNAVAILABLE');
    const response = await source.files.read(source.instanceId, reference, new Request('https://cindy.invalid/'));
    source.assertCurrent();
    if (!response.ok || !response.body) throw new Error('RESOURCE_UNAVAILABLE');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0, limit = maxBytes;
    try {
      for (;;) {
        const part = await reader.read();
        source.assertCurrent();
        if (part.done) break;
        size += part.value.byteLength;
        if (!chunks.length && sniffMediaMime(part.value)?.startsWith('image/')) limit = Math.min(maxBytes, 20 * 1024 * 1024);
        if (size > limit) throw new Error('RESOURCE_TOO_LARGE');
        chunks.push(part.value);
      }
      bytes = Buffer.concat(chunks, size);
    } finally { await reader.cancel().catch(() => {}); }
  }
  source.assertCurrent();
  if (!bytes?.length) throw new Error('RESOURCE_UNAVAILABLE');
  let mimeType: string;
  const kind = expected === 'wallpaper' ? sniffMediaMime(bytes) === 'video/mp4' ? 'video' : 'image' : expected;
  if (declaredKind && declaredKind !== kind) throw new Error('RESOURCE_TYPE');
  if (kind === 'font') mimeType = validateFont(bytes);
  else if (kind === 'video') {
    if (sniffMediaMime(bytes) !== 'video/mp4') throw new Error('RESOURCE_TYPE');
    mimeType = 'video/mp4';
  } else {
    const { prepareWallpaperImage } = await import('../custom-wallpaper.js');
    bytes = await prepareWallpaperImage(bytes);
    mimeType = 'image/webp';
  }
  source.assertCurrent();
  return { kind, bytes, mimeType, hash: createHash('sha256').update(bytes).digest('hex') };
}

/** SFNT bounds precede Chromium's complete font validation. */
function validateFont(bytes: Buffer): string {
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
