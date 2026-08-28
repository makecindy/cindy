import fs from 'node:fs/promises';
import path from 'node:path';

function isPathWithin(base: string, target: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const relative = path.relative(normalize(base), normalize(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolve a model-authored attachment only when both its lexical path and
 * canonical target stay under a host-approved root. Returning the canonical
 * path keeps the later stat/read on the same symlink-resolved target.
 */
export async function resolveAllowedOutboundFile(
  absPath: string,
  allowedRoots: readonly string[],
  realpath: (target: string) => Promise<string> = fs.realpath,
): Promise<string | null> {
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
      if (isPathWithin(rootReal, targetReal)) return targetReal;
    } catch {
      // Missing, unreadable, or cyclic paths fail closed.
    }
  }
  return null;
}
