import type fs from 'node:fs';
import path from 'node:path';

export interface GhostSnapshotParentIdentity {
  realPath: string;
  dev: bigint;
  ino: bigint;
}

export interface GhostSnapshotTargetIdentity {
  realPath: string;
  dev: bigint;
  ino: bigint;
}

export function sameGhostSnapshotPath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
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

/**
 * A renamed/quarantined target is accepted only when its no-follow type and
 * inode identity still match. The canonical path is expected to change.
 */
export function sameGhostSnapshotInodeIdentity(
  stats: fs.BigIntStats,
  expected: Pick<GhostSnapshotTargetIdentity, 'dev' | 'ino'>,
): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink() &&
    stats.dev !== 0n && stats.ino !== 0n &&
    expected.dev !== 0n && expected.ino !== 0n &&
    stats.dev === expected.dev &&
    stats.ino === expected.ino;
}

/**
 * A target is accepted only when its no-follow type, inode identity, and
 * canonical path all still match the identity captured before the operation.
 * The path comparison closes the realpath-reuse case that dev/ino alone cannot
 * distinguish on every filesystem.
 */
export function sameGhostSnapshotTargetIdentity(
  stats: fs.BigIntStats,
  realPath: string,
  expected: GhostSnapshotTargetIdentity,
): boolean {
  return sameGhostSnapshotInodeIdentity(stats, expected) &&
    sameGhostSnapshotPath(realPath, expected.realPath);
}
