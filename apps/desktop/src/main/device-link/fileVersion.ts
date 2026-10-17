import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';

/** Same opened file identity in prepare/open; no raw path or stat fields cross the wire. */
export function fileVersion(absPath: string, stat: Stats, sourceVersion?: string): string {
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
    .digest('hex');
}
