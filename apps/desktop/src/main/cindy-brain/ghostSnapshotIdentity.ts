import type fs from 'node:fs';

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
    stats.dev !== 0n && stats.ino !== 0n &&
    expected.dev !== 0n && expected.ino !== 0n &&
    stats.dev === expected.dev && stats.ino === expected.ino;
}
