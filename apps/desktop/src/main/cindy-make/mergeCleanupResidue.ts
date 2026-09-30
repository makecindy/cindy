import type { Stats } from 'node:fs';
import path from 'node:path';
import originalFs from 'original-fs';

const fs = originalFs.promises;
const samePath = (left: string, right: string) =>
  process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);

/** Git on Windows can report successful removal while leaving dangling dependency junctions.
 * Only reclaim links inside node_modules and empty directories, never remaining file content.
 * The caller must first prove adoption, runtime shutdown and removal of Git registration.
 */
export async function removeMergeWorktreeResidue(
  root: string,
  canCleanup: () => boolean,
): Promise<boolean> {
  const entries: Array<{ target: string; identity: Stats }> = [];
  const inspect = async (target: string): Promise<boolean> => {
    if (!canCleanup()) return false;
    const identity = await fs.lstat(target);
    if (identity.isSymbolicLink()) {
      const parts = path.relative(root, target).split(path.sep);
      if (!parts.includes('node_modules')) return false;
    } else {
      if (!identity.isDirectory() || !samePath(await fs.realpath(target), target)) return false;
      for (const name of await fs.readdir(target)) {
        if (name.toLowerCase() === '.git' || !(await inspect(path.join(target, name))))
          return false;
      }
    }
    entries.push({ target, identity });
    return true;
  };
  if (!(await inspect(root))) return false;
  for (const { target, identity } of entries) {
    if (!canCleanup() || !samePath(await fs.realpath(path.dirname(target)), path.dirname(target)))
      return false;
    const current = await fs.lstat(target);
    if (
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      current.isSymbolicLink() !== identity.isSymbolicLink() ||
      !canCleanup()
    )
      return false;
    // Never recurse through a link or force-delete a file added since inspection.
    if (identity.isSymbolicLink()) await fs.unlink(target);
    else await fs.rmdir(target);
  }
  return true;
}
