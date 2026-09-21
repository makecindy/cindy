import os from 'node:os';
import path from 'node:path';
import { lstat, mkdtemp, realpath } from 'node:fs/promises';
import originalFs from 'original-fs';

/** Owns disposable launch files only; the stable test profile is never a cleanup target. */
export async function createMakeTestTempDirectory(tempRoot = os.tmpdir()) {
  const root = await realpath(tempRoot);
  const directory = await mkdtemp(path.join(root, 'cindy-make-test-'));
  const identity = await lstat(directory);
  return {
    directory,
    async clean(): Promise<void> {
      let current;
      try {
        current = await lstat(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      // Reject a replaced directory or junction instead of following it into user data.
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        path.dirname(await realpath(directory)) !== root
      )
        throw new Error('Make test temporary directory was replaced');
      await originalFs.promises.rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 200,
      });
    },
  };
}
