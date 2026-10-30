import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { expect, vi } from 'vitest';

/**
 * Prefer a real file symlink. Unprivileged Windows cannot create one, so keep a
 * real external-file alias (hard link) and simulate only its lstat type bits.
 * Reads/writes and inode replacement remain real; no production operation is
 * mocked to reject. Directory attacks use real junctions instead of this helper.
 */
export function fileSymlinkFixture(target: string, linkPath: string) {
  let native = true;
  try {
    fs.symlinkSync(target, linkPath, 'file');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES')) throw error;
    native = false;
    fs.linkSync(target, linkPath);
  }

  const identity = fs.lstatSync(linkPath);
  const originalLstat = fsp.lstat.bind(fsp);
  const spy = native ? undefined : vi.spyOn(fsp, 'lstat').mockImplementation(async (candidate, opts) => {
    const stat = await originalLstat(candidate, opts);
    // Stop reporting a link if the code replaced the fixture. Otherwise a
    // constant mocked stat could hide the very unsafe mutation we are testing.
    if (
      path.resolve(String(candidate)) === path.resolve(linkPath) &&
      stat.dev === identity.dev && stat.ino === identity.ino
    ) {
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
        isSymbolicLink: () => true,
        isFile: () => false,
      });
    }
    return stat;
  });

  return {
    restore: () => spy?.mockRestore(),
    expectIntact: () => {
      const current = fs.lstatSync(linkPath);
      expect(current.isSymbolicLink()).toBe(native);
      expect(current.dev).toBe(identity.dev);
      expect(current.ino).toBe(identity.ino);
    },
  };
}
