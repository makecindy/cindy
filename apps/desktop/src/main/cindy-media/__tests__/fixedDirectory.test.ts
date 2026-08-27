import { describe, expect, it, vi } from 'vitest';
import type fs from 'node:fs';

import { openOrCreateFixedDirectory } from '../fixedDirectory';

function directoryStat(isDirectory: boolean): fs.Stats {
  return { isDirectory: () => isDirectory } as fs.Stats;
}

function missingPathError(): NodeJS.ErrnoException {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

describe('openOrCreateFixedDirectory', () => {
  it('creates a missing fixed directory before opening it', async () => {
    const lstat = vi.fn().mockRejectedValueOnce(missingPathError()).mockResolvedValueOnce(
      directoryStat(true),
    );
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const openPath = vi.fn().mockResolvedValue('');
    const canOpen = vi.fn().mockReturnValue(true);

    await expect(
      openOrCreateFixedDirectory('C:\\cache\\images', {
        canOpen,
        fileSystem: { lstat, mkdir },
        openPath,
      }),
    ).resolves.toBe(true);

    expect(mkdir).toHaveBeenCalledWith('C:\\cache\\images', { recursive: true });
    expect(lstat).toHaveBeenCalledTimes(2);
    expect(canOpen).toHaveBeenCalledTimes(2);
    expect(openPath).toHaveBeenCalledWith('C:\\cache\\images');
  });

  it('recreates a directory removed by concurrent cleanup before opening it', async () => {
    const lstat = vi
      .fn()
      .mockRejectedValueOnce(missingPathError())
      .mockRejectedValueOnce(missingPathError())
      .mockResolvedValueOnce(directoryStat(true));
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const openPath = vi.fn().mockResolvedValue('');

    await expect(
      openOrCreateFixedDirectory('/cache/images', {
        fileSystem: { lstat, mkdir },
        openPath,
      }),
    ).resolves.toBe(true);

    expect(mkdir).toHaveBeenCalledTimes(2);
    expect(openPath).toHaveBeenCalledWith('/cache/images');
  });

  it('keeps repeated concurrent deletion as a recoverable not-opened result', async () => {
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const openPath = vi.fn();

    await expect(
      openOrCreateFixedDirectory('/cache/images', {
        fileSystem: {
          lstat: vi.fn().mockRejectedValue(missingPathError()),
          mkdir,
        },
        openPath,
      }),
    ).resolves.toBe(false);

    expect(mkdir).toHaveBeenCalledTimes(2);
    expect(openPath).not.toHaveBeenCalled();
  });

  it('opens an existing fixed directory without creating it again', async () => {
    const lstat = vi.fn().mockResolvedValue(directoryStat(true));
    const mkdir = vi.fn();
    const openPath = vi.fn().mockResolvedValue('');

    await expect(
      openOrCreateFixedDirectory('/cache/images', {
        fileSystem: { lstat, mkdir },
        openPath,
      }),
    ).resolves.toBe(true);

    expect(mkdir).not.toHaveBeenCalled();
    expect(openPath).toHaveBeenCalledWith('/cache/images');
  });

  it('does not open or replace a fixed path that is not a directory', async () => {
    const mkdir = vi.fn();
    const openPath = vi.fn();

    await expect(
      openOrCreateFixedDirectory('/cache/images', {
        fileSystem: {
          lstat: vi.fn().mockResolvedValue(directoryStat(false)),
          mkdir,
        },
        openPath,
      }),
    ).resolves.toBe(false);

    expect(mkdir).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
  });

  it('does not create a missing owner-scoped directory after the owner changes', async () => {
    const mkdir = vi.fn();
    const openPath = vi.fn();

    await expect(
      openOrCreateFixedDirectory('/cache/owner-a', {
        canOpen: () => false,
        fileSystem: {
          lstat: vi.fn().mockRejectedValue(missingPathError()),
          mkdir,
        },
        openPath,
      }),
    ).rejects.toThrow('fixed directory owner changed before open');

    expect(mkdir).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
  });

  it('rechecks the owner after creating the directory and before opening it', async () => {
    const canOpen = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const openPath = vi.fn();

    await expect(
      openOrCreateFixedDirectory('/cache/owner-a', {
        canOpen,
        fileSystem: {
          lstat: vi
            .fn()
            .mockRejectedValueOnce(missingPathError())
            .mockResolvedValueOnce(directoryStat(true)),
          mkdir: vi.fn().mockResolvedValue(undefined),
        },
        openPath,
      }),
    ).rejects.toThrow('fixed directory owner changed before open');

    expect(openPath).not.toHaveBeenCalled();
  });

  it('propagates directory creation and shell opening failures', async () => {
    const createError = new Error('access denied');
    await expect(
      openOrCreateFixedDirectory('/cache/images', {
        fileSystem: {
          lstat: vi.fn().mockRejectedValue(missingPathError()),
          mkdir: vi.fn().mockRejectedValue(createError),
        },
        openPath: vi.fn(),
      }),
    ).rejects.toBe(createError);

    await expect(
      openOrCreateFixedDirectory('/cache/images', {
        fileSystem: {
          lstat: vi.fn().mockResolvedValue(directoryStat(true)),
          mkdir: vi.fn(),
        },
        openPath: vi.fn().mockResolvedValue('shell failed'),
      }),
    ).rejects.toThrow('shell failed');
  });

  it('keeps deletion during shell opening as a recoverable not-opened result', async () => {
    const openPath = vi.fn().mockResolvedValue('path disappeared');

    await expect(
      openOrCreateFixedDirectory('/cache/images', {
        fileSystem: {
          lstat: vi
            .fn()
            .mockResolvedValueOnce(directoryStat(true))
            .mockRejectedValueOnce(missingPathError()),
          mkdir: vi.fn(),
        },
        openPath,
      }),
    ).resolves.toBe(false);

    expect(openPath).toHaveBeenCalledWith('/cache/images');
  });
});
