import fs from 'node:fs';
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
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export function sameGhostSnapshotPath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
}

function sameFileIdentity(
  left: Pick<fs.BigIntStats, 'dev' | 'ino'>,
  right: Pick<fs.BigIntStats, 'dev' | 'ino'>,
): boolean {
  return left.dev !== 0n && left.ino !== 0n &&
    right.dev !== 0n && right.ino !== 0n &&
    left.dev === right.dev &&
    left.ino === right.ino;
}

export function sameGhostSnapshotParentIdentity(
  stats: fs.BigIntStats,
  expected: GhostSnapshotParentIdentity,
): boolean {
  return stats.isDirectory() && !stats.isSymbolicLink() &&
    sameFileIdentity(stats, expected);
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
    sameFileIdentity(stats, expected);
}

/**
 * A target is accepted only when its no-follow type, inode identity, stable
 * timestamps, and canonical path all still match the identity captured before
 * the operation. Timestamps close inode reuse; the path comparison closes the
 * realpath-reuse case that inode identity alone cannot distinguish.
 */
export function sameGhostSnapshotTargetIdentity(
  stats: fs.BigIntStats,
  realPath: string,
  expected: GhostSnapshotTargetIdentity,
): boolean {
  return stats.isDirectory() &&
    !stats.isSymbolicLink() &&
    sameFileIdentity(stats, expected) &&
    stats.mtimeNs === expected.mtimeNs &&
    stats.ctimeNs === expected.ctimeNs &&
    sameGhostSnapshotPath(realPath, expected.realPath);
}

export function ghostSnapshotTargetIdentityFrom(
  stats: fs.BigIntStats,
  realPath: string,
): GhostSnapshotTargetIdentity {
  return {
    realPath,
    dev: stats.dev,
    ino: stats.ino,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

/**
 * Bind lstat, realpath, and a confirming lstat to one directory object.
 * Separate pathname reads can otherwise mix an old inode with a replacement
 * path at the same lexical location.
 */
export async function captureGhostSnapshotTargetIdentity(
  targetPath: string,
): Promise<GhostSnapshotTargetIdentity> {
  const lexicalBefore = await fs.promises.lstat(targetPath, { bigint: true });
  if (lexicalBefore.isSymbolicLink() || !lexicalBefore.isDirectory()) {
    throw new Error('snapshot target is not a real directory');
  }
  const realPath = await fs.promises.realpath(targetPath);
  const lexicalAfter = await fs.promises.lstat(targetPath, { bigint: true });
  if (
    !lexicalAfter.isDirectory() ||
    lexicalAfter.isSymbolicLink() ||
    !sameFileIdentity(lexicalBefore, lexicalAfter) ||
    lexicalBefore.mtimeNs !== lexicalAfter.mtimeNs ||
    lexicalBefore.ctimeNs !== lexicalAfter.ctimeNs
  ) {
    throw new Error('snapshot target identity changed while capturing');
  }
  return ghostSnapshotTargetIdentityFrom(lexicalAfter, realPath);
}

export function sameCapturedGhostSnapshotTargetIdentity(
  current: GhostSnapshotTargetIdentity,
  expected: GhostSnapshotTargetIdentity,
): boolean {
  return sameFileIdentity(current, expected) &&
    current.mtimeNs === expected.mtimeNs &&
    current.ctimeNs === expected.ctimeNs &&
    sameGhostSnapshotPath(current.realPath, expected.realPath);
}

export function ghostContentRootIdentityFromSnapshot(
  identity: GhostSnapshotTargetIdentity,
): {
  realPath: string;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
} {
  return {
    realPath: identity.realPath,
    dev: identity.dev,
    ino: identity.ino,
    mtimeNs: identity.mtimeNs,
    ctimeNs: identity.ctimeNs,
  };
}
