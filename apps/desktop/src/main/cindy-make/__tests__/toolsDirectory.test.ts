import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openMakeToolsDirectory } from '../toolsDirectory.js';

// All filesystem calls are injected; these tests never touch a user profile.
const userData = path.join(os.tmpdir(), 'cindy-make-folder-test');

describe('Cindy Make tools directory', () => {
  it('creates a missing managed tools directory before opening it', async () => {
    const lstat = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
      .mockResolvedValue({ isDirectory: () => true });
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const openPath = vi.fn().mockResolvedValue('');
    await expect(
      openMakeToolsDirectory(userData, {
        fileSystem: { lstat, mkdir },
        openPath,
      }),
    ).resolves.toEqual({ success: true });
    const expected = path.join(userData, 'cindy-make', 'tools');
    expect(mkdir).toHaveBeenCalledWith(expected, { recursive: true });
    expect(openPath).toHaveBeenCalledWith(expected);
  });

  it.each(['mkdir', 'shell', 'file'])(
    'returns a stable IPC error on %s failure',
    async (failure) => {
      const lstat = vi.fn().mockResolvedValue({ isDirectory: () => failure !== 'file' });
      if (failure === 'mkdir')
        lstat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
      const mkdir = vi.fn().mockRejectedValue(new Error('private path and OS error'));
      const openPath = vi.fn().mockResolvedValue('private path and OS error');
      await expect(
        openMakeToolsDirectory(userData, {
          fileSystem: { lstat, mkdir },
          openPath,
        }),
      ).rejects.toMatchObject({ code: 'INTERNAL' });
      if (failure !== 'shell') expect(openPath).not.toHaveBeenCalled();
    },
  );
});
