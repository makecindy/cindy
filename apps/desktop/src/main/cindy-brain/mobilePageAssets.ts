import fs from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import type { InstalledGhost } from '../../shared/ghost.js';
import { isSafeGhostRelativePath } from '../../shared/ghost.js';
import {
  PLUGIN_PAGE_MAX_BUNDLE_BYTES,
  type PluginPageFile,
  type PluginPageAsset,
} from '@cindy/device-link';
import {
  collectGhostContentFiles,
  resolveGhostContentPath,
  sameStableFileState,
} from './ghostContentTree.js';
import { ghostFileMime } from './runtime/ghostFiles.js';

const CHUNK_BYTES = 48 * 1024; // Divisible by 3: mobile can join independently encoded chunks.
const snapshots = new WeakMap<PluginPageFile, { stat: BigIntStats; root: string }>();
const WEB_FILE = /\.(?:html|js|mjs|css|json|txt|png|jpe?g|gif|webp|svg|ico|woff2?)$/i;

export async function listMobilePageFiles(
  ghost: InstalledGhost,
  entry: string,
): Promise<PluginPageFile[]> {
  const tree = await collectGhostContentFiles(ghost.dir, {
    dotEntries: 'skip',
    nonRegular: 'throw',
    label: 'plugin mobile page',
  });
  if (!tree.files.includes(entry)) throw new Error('PLUGIN_PAGE_MISSING');
  const files: PluginPageFile[] = [];
  let totalBytes = 0;
  for (const relative of tree.files) {
    if (!WEB_FILE.test(relative) || !isSafeGhostRelativePath(relative)) continue;
    const file = await resolveGhostContentPath(ghost.dir, relative, {
      expect: 'file',
      label: 'plugin mobile page',
    });
    const stat = await fs.lstat(file, { bigint: true });
    if (!stat.isFile()) throw new Error('PLUGIN_ASSET_CHANGED');
    const descriptor = { path: relative, mime: ghostFileMime(file), size: Number(stat.size) };
    totalBytes += descriptor.size;
    if (totalBytes > PLUGIN_PAGE_MAX_BUNDLE_BYTES || files.length >= 10_000)
      throw new Error('PLUGIN_PAGE_BUNDLE_TOO_LARGE');
    snapshots.set(descriptor, { stat, root: tree.rootIdentity.realPath });
    files.push(descriptor);
  }
  return files;
}

export async function readMobilePageChunk(
  ghost: InstalledGhost,
  file: PluginPageFile,
  offset: number,
): Promise<PluginPageAsset> {
  if (!isSafeGhostRelativePath(file.path)) throw new Error('PLUGIN_ASSET_UNAVAILABLE');
  const resolved = await resolveGhostContentPath(ghost.dir, file.path, {
    expect: 'file',
    label: 'plugin mobile page',
  });
  const snapshot = snapshots.get(file);
  if (!snapshot || !Number.isSafeInteger(offset) || offset < 0 || offset > file.size)
    throw new Error('PLUGIN_ASSET_UNAVAILABLE');
  const real = await fs.realpath(resolved);
  if (real !== path.join(snapshot.root, ...file.path.split('/')))
    throw new Error('PLUGIN_ASSET_CHANGED');
  const handle = await fs.open(
    resolved,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat({ bigint: true });
    if (!sameStableFileState(snapshot.stat, stat)) throw new Error('PLUGIN_ASSET_CHANGED');
    const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, file.size - offset));
    const result = await handle.read(bytes, 0, bytes.length, offset);
    if (result.bytesRead !== bytes.length) throw new Error('PLUGIN_ASSET_CHANGED');
    await resolveGhostContentPath(ghost.dir, file.path, {
      expect: 'file',
      label: 'plugin mobile page',
    });
    const [after, named, afterReal] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(resolved, { bigint: true }),
      fs.realpath(resolved),
    ]);
    if (
      !sameStableFileState(stat, after) ||
      !sameStableFileState(stat, named) ||
      afterReal !== real
    )
      throw new Error('PLUGIN_ASSET_CHANGED');
    return { mime: file.mime, base64: bytes.toString('base64') };
  } finally {
    await handle.close();
  }
}
