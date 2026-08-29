import { constants as fsConstants } from 'node:fs';
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

function nofollowReadFlags(): number {
  const nofollow = fsConstants.O_NOFOLLOW;
  if (typeof nofollow !== 'number') {
    throw new Error('O_NOFOLLOW is required to confine outbound file reads');
  }
  return fsConstants.O_RDONLY | nofollow;
}

export interface AllowedOutboundFile {
  absPath: string;
  handle: FileHandle;
}

/**
 * Resolve a model-authored attachment only when both its lexical path and
 * canonical target stay under a host-approved root. The returned handle is
 * opened with `O_NOFOLLOW` on that canonical path so later stat/read cannot
 * follow a symlink swapped in after the check. Caller must close the handle.
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
      const handle = await fs.open(targetReal, nofollowReadFlags());
      let handedOff = false;
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) continue;
        handedOff = true;
        return { absPath: targetReal, handle };
      } finally {
        if (!handedOff) await handle.close().catch(() => undefined);
      }
    } catch {
      // Missing, unreadable, symlink swap, or cyclic paths fail closed.
    }
  }
  return null;
}
