import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { FILE_INLINE_MAX_BYTES } from '@cindy/device-link';

/** Same opened file identity in prepare/open; no raw path or stat fields cross the wire. */
function fileVersion(absPath: string, stat: Stats, sourceVersion?: string, bytes?: Buffer): string {
  // SSH materialization supplies the remote identity; local paths include login generation.
  // Immutable copies may move or receive LRU touches without changing their version.
  return createHash('sha256')
    .update(
      JSON.stringify(
        sourceVersion !== undefined
          ? [sourceVersion, stat.size]
          : [absPath, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs],
      ),
    )
    .update(bytes ?? Buffer.alloc(0))
    .digest('hex');
}

/**
 * Small mutable files need content identity: Windows can preserve every stat field
 * across a same-length rewrite, even with bigint timestamps. Keep the work bounded
 * by the existing inline limit; large files retain metadata identity, not a content
 * integrity guarantee. Never rescan a large video for each range.
 */
export async function readFileVersion(
  file: FileHandle, absPath: string, stat: Stats, sourceVersion?: string,
): Promise<{ version: string; bytes?: Buffer }> {
  let bytes: Buffer | undefined;
  if (sourceVersion === undefined && stat.size <= FILE_INLINE_MAX_BYTES) {
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error('FILE_PEER_CHANGED');
      offset += read.bytesRead;
    }
    const after = await file.stat();
    if (fileVersion(absPath, stat) !== fileVersion(absPath, after))
      throw new Error('FILE_PEER_CHANGED');
  }
  return { version: fileVersion(absPath, stat, sourceVersion, bytes), bytes };
}
