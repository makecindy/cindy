import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';

function isPathWithin(base: string, target: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const relative = path.relative(normalize(base), normalize(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  // Windows file indexes are not always populated; skip identity when both are 0.
  if (left.ino === 0 && right.ino === 0) return true;
  return left.dev === right.dev && left.ino === right.ino;
}

function nofollowReadFlags(): number | null {
  const nofollow = fsConstants.O_NOFOLLOW;
  if (typeof nofollow !== 'number') return null;
  return fsConstants.O_RDONLY | nofollow;
}

async function openConfinedRead(targetReal: string): Promise<FileHandle> {
  // Windows maps O_NOFOLLOW to FILE_FLAG_OPEN_REPARSE_POINT, which makes
  // ordinary temp files fail or report as non-files. Bind identity with
  // lstat/fstat + a second realpath instead of that flag.
  const flags = process.platform === 'win32' ? null : nofollowReadFlags();
  if (flags !== null) return await fs.open(targetReal, flags);
  return await fs.open(targetReal, 'r');
}

async function openedPathStaysInRoot(
  handle: FileHandle,
  rootReal: string,
  fallbackPath: string,
): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      const fdPath = await fs.readlink(`/proc/self/fd/${handle.fd}`);
      if (!isPathWithin(rootReal, fdPath)) return null;
      return fdPath;
    } catch {
      // /proc may be unavailable; fall through to the caller path.
    }
  }
  if (!isPathWithin(rootReal, fallbackPath)) return null;
  return fallbackPath;
}

export interface AllowedOutboundFile {
  absPath: string;
  handle: FileHandle;
}

/**
 * Resolve a model-authored attachment only when both its lexical path and
 * canonical target stay under a host-approved root. The returned handle is
 * opened with `O_NOFOLLOW` on that canonical path when the platform supports
 * it, then re-checked against the still-canonical object so an ancestor
 * directory swap after `realpath()` cannot upload a root-escape. Caller must
 * close the handle.
 */
export async function resolveAllowedOutboundFile(
  absPath: string,
  allowedRoots: readonly string[],
  realpath: (target: string) => Promise<string> = fs.realpath,
): Promise<AllowedOutboundFile | null> {
  const targetAbs = path.resolve(absPath);
  for (const root of allowedRoots) {
    if (!root.trim()) continue;
    const rootAbs = path.resolve(root);
    if (!isPathWithin(rootAbs, targetAbs)) continue;
    try {
      const [rootReal, targetReal] = await Promise.all([
        realpath(rootAbs),
        realpath(targetAbs),
      ]);
      if (!isPathWithin(rootReal, targetReal)) continue;
      const expected = await fs.lstat(targetReal);
      if (expected.isSymbolicLink() || !expected.isFile()) continue;
      const handle = await openConfinedRead(targetReal);
      let handedOff = false;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || !sameFileIdentity(expected, opened)) continue;
        const stillReal = await realpath(targetAbs);
        if (!isPathWithin(rootReal, stillReal)) continue;
        const stillStat = await fs.lstat(stillReal);
        if (!stillStat.isFile() || !sameFileIdentity(opened, stillStat)) continue;
        const confinedPath = await openedPathStaysInRoot(handle, rootReal, stillReal);
        if (!confinedPath) continue;
        handedOff = true;
        return { absPath: confinedPath, handle };
      } finally {
        if (!handedOff) await handle.close().catch(() => undefined);
      }
    } catch {
      // Missing, unreadable, symlink swap, or cyclic paths fail closed.
    }
  }
  return null;
}
