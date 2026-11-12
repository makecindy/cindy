import { constants as fsConstants, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';

export function isWithinConfinement(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function sameStableFileIdentity(before: Stats, after: Stats): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

function sameResolvedPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/**
 * Resolves one package path without allowing a replacement during realpath to
 * silently redefine the object that subsequent confinement checks trust.
 */
export async function resolveStablePackagePath(
  rawPath: string,
  changedMessage: string,
): Promise<{ canonicalPath: string; stat: Stats }> {
  const before = await fs.lstat(rawPath);
  const canonicalPath = await fs.realpath(rawPath);
  const [after, resolvedAgain] = await Promise.all([
    fs.lstat(rawPath),
    fs.realpath(rawPath),
  ]);
  if (!sameStableFileIdentity(before, after) || !sameResolvedPath(canonicalPath, resolvedAgain)) {
    throw new Error(changedMessage);
  }
  const [canonicalStat, followedStat] = await Promise.all([
    fs.stat(canonicalPath),
    fs.stat(rawPath),
  ]);
  if (!sameStableFileIdentity(canonicalStat, followedStat)) {
    throw new Error(changedMessage);
  }
  return { canonicalPath, stat: canonicalStat };
}

export async function openConstrainedRegularFile(
  confinementRoot: string,
  rawPath: string,
  escapedMessage: string,
  changedMessage: string,
): Promise<{
  handle: Awaited<ReturnType<typeof fs.open>>;
  stat: Stats;
  canonicalPath: string;
}> {
  const canonicalPath = await fs.realpath(rawPath);
  if (!isWithinConfinement(confinementRoot, canonicalPath)) {
    throw new Error(escapedMessage);
  }
  // O_NOFOLLOW closes the final-component swap on POSIX. Windows does not
  // consistently expose that flag, so the post-open path/handle proof below
  // remains mandatory on every platform.
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(canonicalPath, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(changedMessage);
    const rebound = await fs.realpath(canonicalPath);
    if (!isWithinConfinement(confinementRoot, rebound)) {
      throw new Error(escapedMessage);
    }
    const reboundStat = await fs.stat(rebound);
    if (!sameStableFileIdentity(opened, reboundStat)) {
      throw new Error(changedMessage);
    }
    return { handle, stat: opened, canonicalPath: rebound };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
