import type fs from 'node:fs';

import { sameFileIdentity } from '../utils/fileIdentity.js';

export interface ForgeScaffoldParentIdentity {
  realPath: string;
  dev: bigint;
  ino: bigint;
}

/**
 * Forge scaffold can only promise a stable parent when both sides expose a
 * real filesystem identity. A zero inode remains unknown. On Windows,
 * however, path lstat commonly exposes dev=0 while retaining a nonzero NTFS
 * FileId; use the shared cross-platform identity rule for that case.
 */
export function sameForgeScaffoldParentIdentity(
  stats: fs.BigIntStats,
  expected: ForgeScaffoldParentIdentity,
): boolean {
  if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
  return sameFileIdentity(stats, expected);
}
