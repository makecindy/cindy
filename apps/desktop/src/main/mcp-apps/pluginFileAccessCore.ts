import fs, { type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { ghostCanRead } from '../cindy-media/ledger.js';
import { buildRangedFileResponse } from '../cindy-media/rangeResponse.js';
import type { PluginFileAccess } from './pluginFiles.js';

/** Reuse the panel's Library resolver and media ownership ledger, never page paths. */
export function createPluginFileAccessCore(media: {
  resolveSafe(uri: string): { hash: string };
  openBlobFile(uri: string): Promise<{ file: FileHandle; totalSize: number; mimeType: string }>;
}, deps: {
  libraryPath(instance: string, relativePath: string): Promise<string | null>;
  libraryMime(relativePath: string): string;
  /** Live, link-checked handoff copy of this instance; null when expired or deleted. */
  openHandoff?(instance: string, ref: string): Promise<{ file: FileHandle; size: number; mimeType: string } | null>;
}): PluginFileAccess {
  const open = async (instance: string, uri: string) => {
    let path: string | null = null,
      mimeType: string;
    if (uri.startsWith('handoff:')) return (await deps.openHandoff?.(instance, uri)) ?? null;
    if (uri.startsWith('cindy-media:')) {
      const blob = media.resolveSafe(uri);
      if (!(await ghostCanRead(blob.hash, instance))) return null;
      const opened = await media.openBlobFile(uri);
      return { file: opened.file, size: opened.totalSize, mimeType: opened.mimeType };
    } else if (uri.startsWith('library:')) {
      const relativePath = uri.slice('library:'.length);
      path = await deps.libraryPath(instance, relativePath);
      mimeType = deps.libraryMime(relativePath);
    } else return null;
    if (!path) return null;
    const file = await fs.open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const stat = await file.stat({ bigint: true });
      const freshPath = await deps.libraryPath(instance, uri.slice('library:'.length));
      const current = freshPath === path ? await fs.lstat(path, { bigint: true }) : null;
      if (
        !stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER) ||
        !current?.isFile() ||
        current.dev !== stat.dev ||
        current.ino !== stat.ino
      ) {
        await file.close();
        return null;
      }
      return { file, size: Number(stat.size), mimeType };
    } catch (error) {
      await file.close();
      throw error;
    }
  };
  return {
    async describe(instance, uri) {
      try {
        const info = await open(instance, uri);
        if (!info) return null;
        await info.file.close();
        return { size: info.size, mimeType: info.mimeType };
      } catch {
        return null;
      }
    },
    async read(instance, uri, request) {
      try {
        const info = await open(instance, uri);
        if (!info) return new Response(null, { status: 404 });
        if (request.method === 'HEAD') {
          await info.file.close();
          return new Response(null, {
            headers: { 'Content-Type': info.mimeType, 'Content-Length': String(info.size) },
          });
        }
        return await buildRangedFileResponse({
          file: info.file,
          totalSize: info.size,
          mimeType: info.mimeType,
          rangeHeader: request.headers.get('range'),
          cacheControl: 'no-store',
          signal: request.signal,
        });
      } catch {
        return new Response(null, { status: 404 });
      }
    },
  };
}
