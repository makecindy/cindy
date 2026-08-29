import { constants as fsConstants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

function isPathWithin(base: string, target: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const relative = path.relative(normalize(base), normalize(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isSameFile(left: BigIntStats, right: BigIntStats): boolean {
  // Windows file indexes are not always populated. Fail closed on POSIX when
  // either inode is 0; on win32 treat a pair of zeros as "identity unknown"
  // and let the pre/post canonical-path checks carry the containment proof.
  if (left.ino === 0n || right.ino === 0n) {
    return process.platform === 'win32' && left.ino === 0n && right.ino === 0n;
  }
  return left.dev === right.dev && left.ino === right.ino;
}

export interface OpenedAllowedOutboundFile {
  /** Canonical path is metadata only. Uploads must read from `handle`. */
  canonicalPath: string;
  handle: FileHandle;
  size: number;
}

interface AllowedOutboundFileSystem {
  realpath(target: string): Promise<string>;
  open(target: string): Promise<FileHandle>;
  stat(target: string): Promise<BigIntStats>;
}

const defaultFileSystem: AllowedOutboundFileSystem = {
  realpath: (target) => fs.realpath(target),
  open: (target) => {
    const nofollow = fsConstants.O_NOFOLLOW;
    // Windows maps O_NOFOLLOW to FILE_FLAG_OPEN_REPARSE_POINT, which makes
    // ordinary files fail or report as non-files. Bind identity with the
    // pre/post realpath + dev/ino checks instead of that flag.
    if (process.platform === 'win32' || typeof nofollow !== 'number') {
      return fs.open(target, 'r');
    }
    return fs.open(target, fsConstants.O_RDONLY | nofollow);
  },
  stat: (target) => fs.stat(target, { bigint: true }),
};

/**
 * Open a model-authored attachment only when both its lexical path and the
 * opened file identity stay under a host-approved root.
 *
 * The pre/post canonical checks plus `dev`/`ino` comparison close the race
 * between path validation and `open()`. Callers must upload from `handle` and
 * close it in a `finally`; reopening `canonicalPath` would reintroduce TOCTOU.
 */
export async function openAllowedOutboundFile(
  absPath: string,
  allowedRoots: readonly string[],
  fileSystem: AllowedOutboundFileSystem = defaultFileSystem,
): Promise<OpenedAllowedOutboundFile | null> {
  const targetAbs = path.resolve(absPath);
  for (const root of allowedRoots) {
    if (!root.trim()) continue;
    const rootAbs = path.resolve(root);
    if (!isPathWithin(rootAbs, targetAbs)) continue;

    let handle: FileHandle | null = null;
    let keepHandle = false;
    try {
      const [rootRealBefore, targetRealBefore] = await Promise.all([
        fileSystem.realpath(rootAbs),
        fileSystem.realpath(targetAbs),
      ]);
      if (!isPathWithin(rootRealBefore, targetRealBefore)) continue;

      const rootStatBefore = await fileSystem.stat(rootRealBefore);
      if (!rootStatBefore.isDirectory()) continue;

      handle = await fileSystem.open(targetRealBefore);
      const openedStat = await handle.stat({ bigint: true });
      if (!openedStat.isFile()) continue;

      const [rootRealAfter, targetRealAfter] = await Promise.all([
        fileSystem.realpath(rootAbs),
        fileSystem.realpath(targetAbs),
      ]);
      if (!isPathWithin(rootRealAfter, targetRealAfter)) continue;

      const [rootStatAfter, targetStatAfter] = await Promise.all([
        fileSystem.stat(rootRealAfter),
        fileSystem.stat(targetRealAfter),
      ]);
      if (
        !rootStatAfter.isDirectory() ||
        !targetStatAfter.isFile() ||
        !isSameFile(rootStatBefore, rootStatAfter) ||
        !isSameFile(openedStat, targetStatAfter)
      ) {
        continue;
      }

      keepHandle = true;
      return {
        canonicalPath: targetRealAfter,
        handle,
        size: Number(openedStat.size),
      };
    } catch {
      // Missing, unreadable, cyclic, or concurrently replaced paths fail closed.
    } finally {
      if (handle && !keepHandle) {
        await handle.close().catch(() => undefined);
      }
    }
  }
  return null;
}
