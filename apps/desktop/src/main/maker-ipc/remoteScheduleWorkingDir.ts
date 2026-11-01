import { stat } from 'node:fs/promises';

/** Device-link creates must not persist a path that does not exist on this computer. */
export async function remoteCreateWorkingDirError(dir: unknown): Promise<string | null> {
  if (dir == null || dir === '') return null;
  if (typeof dir !== 'string') return 'invalid workingDir: path must be a string';
  if (dir !== dir.trim()) {
    return 'invalid workingDir: path has leading or trailing whitespace';
  }
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) return `invalid workingDir: not a directory on this computer: ${dir}`;
    return null;
  } catch {
    return `invalid workingDir: does not exist on this computer: ${dir}`;
  }
}
