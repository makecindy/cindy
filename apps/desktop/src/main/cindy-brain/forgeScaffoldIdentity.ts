import type fs from 'node:fs';

export interface ForgeScaffoldParentIdentity {
  realPath: string;
  dev: bigint;
  ino: bigint;
}

/**
 * Forge scaffold can only promise a stable parent when both sides expose a
 * real filesystem identity. Zero-valued identities are "unknown", not a
 * wildcard: accepting them would reduce the worker check to a same-path test.
 */
export function sameForgeScaffoldParentIdentity(
  stats: fs.BigIntStats,
  expected: ForgeScaffoldParentIdentity,
): boolean {
  if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
  if (stats.dev === 0n || stats.ino === 0n || expected.dev === 0n || expected.ino === 0n) {
    return false;
  }
  return stats.dev === expected.dev && stats.ino === expected.ino;
}
