import type fs from 'node:fs';

import { sameFileIdentity } from '../utils/fileIdentity.js';

export interface GhostSnapshotParentIdentity {
  realPath: string;
  dev: bigint;
  ino: bigint;
}

export function sameGhostSnapshotParentIdentity(
  stats: fs.BigIntStats,
  expected: GhostSnapshotParentIdentity,
): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink() &&
    sameFileIdentity(stats, expected);
}
