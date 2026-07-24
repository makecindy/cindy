import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve()),
}));

vi.mock('electron', () => ({
  shell: { openExternal: mocks.openExternal },
}));

import {
  detectProtectedFolderEperm,
  openFolderPrivacySettings,
  releaseEpermGuidance,
  resetEpermGuidanceForTest,
  shouldShowEpermGuidance,
} from '../permissions.js';

beforeEach(() => {
  mocks.openExternal.mockReset();
  mocks.openExternal.mockResolvedValue(undefined);
  resetEpermGuidanceForTest();
});

afterEach(() => {
  resetEpermGuidanceForTest();
});

describe('protected folder permission guidance', () => {
  it.each([
    ['Desktop', 'Desktop'],
    ['Documents', 'Documents'],
    ['Downloads', 'Downloads'],
  ] as const)('detects macOS EPERM for %s', (folderName, expected) => {
    expect(
      detectProtectedFolderEperm(
        `Error: EPERM: operation not permitted, open '${path.join(homedir(), folderName, 'blocked.txt')}'`,
        'darwin',
      ),
    ).toBe(expected);
  });

  it('detects an exact protected folder path followed by a quote', () => {
    expect(
      detectProtectedFolderEperm(
        `Error: EPERM: operation not permitted, scandir '${path.join(homedir(), 'Desktop')}'`,
        'darwin',
      ),
    ).toBe('Desktop');
  });

  it.each(['DesktopBackup', 'Documents (Archive)', 'Downloads-old'])(
    'does not classify a similarly prefixed folder: %s',
    (folderName) => {
      expect(
        detectProtectedFolderEperm(
          `Error: EPERM: operation not permitted, open '${path.join(homedir(), folderName, 'blocked.txt')}'`,
          'darwin',
        ),
      ).toBeNull();
    },
  );

  it('does not classify non-macOS or unrelated failures', () => {
    const failure = `Error: EPERM: operation not permitted, open '${path.join(homedir(), 'Desktop', 'blocked.txt')}'`;
    expect(detectProtectedFolderEperm(failure, 'linux')).toBeNull();
    expect(detectProtectedFolderEperm(failure, 'win32')).toBeNull();
    expect(
      detectProtectedFolderEperm(
        `ENOENT: '${path.join(homedir(), 'Desktop', 'missing.txt')}'`,
        'darwin',
      ),
    ).toBeNull();
    expect(
      detectProtectedFolderEperm(
        `EPERM: '${path.join(homedir(), 'Pictures', 'blocked.txt')}'`,
        'darwin',
      ),
    ).toBeNull();
  });

  it('deduplicates each folder for the app process and supports release', () => {
    expect(shouldShowEpermGuidance('Desktop')).toBe(true);
    expect(shouldShowEpermGuidance('Desktop')).toBe(false);
    expect(shouldShowEpermGuidance('Documents')).toBe(true);
    releaseEpermGuidance('Desktop');
    expect(shouldShowEpermGuidance('Desktop')).toBe(true);
  });

  it('opens the matching macOS privacy pane only on macOS', async () => {
    await openFolderPrivacySettings('Desktop', 'darwin');
    expect(mocks.openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_DesktopFolder',
    );

    mocks.openExternal.mockClear();
    await openFolderPrivacySettings('Desktop', 'linux');
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
});
