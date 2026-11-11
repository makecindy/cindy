import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMakeTestTempDirectory } from '../testTempDirectory';

describe('Make test temporary files', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'make-temp-cleanup-test-'));
  });
  afterEach(async () => {
    expect(path.dirname(root)).toBe(await realpath(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^make-temp-cleanup-test-/);
    await rm(root, { recursive: true, force: true });
  });

  it('removes only this launch, preserving profile data and other launches', async () => {
    const first = await createMakeTestTempDirectory(root);
    const second = await createMakeTestTempDirectory(root);
    const settings = path.join(root, 'test-profile-settings.json');
    await writeFile(settings, 'keep-login-and-settings');
    await writeFile(path.join(first.directory, 'startup.json'), 'temporary-status');
    await writeFile(path.join(second.directory, 'relaunch.json'), 'other-launch');
    await first.clean();
    await first.clean();
    await expect(readFile(path.join(first.directory, 'startup.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(settings, 'utf8')).toBe('keep-login-and-settings');
    expect(await readFile(path.join(second.directory, 'relaunch.json'), 'utf8')).toBe(
      'other-launch',
    );
    await second.clean();
  });

  it('refuses a replaced cleanup target instead of deleting its new contents', async () => {
    const temporary = await createMakeTestTempDirectory(root);
    await rmdir(temporary.directory);
    await writeFile(temporary.directory, 'not-owned');
    await expect(temporary.clean()).rejects.toThrow('replaced');
    expect(await readFile(temporary.directory, 'utf8')).toBe('not-owned');
  });

  it('does not follow a replacement junction into a retained profile', async (context) => {
    const temporary = await createMakeTestTempDirectory(root);
    const retained = await createMakeTestTempDirectory(root);
    const settings = path.join(retained.directory, 'settings.json');
    await writeFile(settings, 'retained');
    await rmdir(temporary.directory);
    try {
      await symlink(
        retained.directory,
        temporary.directory,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        context.skip();
        return;
      }
      throw error;
    }
    await expect(temporary.clean()).rejects.toThrow('replaced');
    expect(await readFile(settings, 'utf8')).toBe('retained');
  });
});
