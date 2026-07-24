import { homedir } from 'node:os';
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
    expect(detectProtectedFolderEperm(
      `Error: EPERM: operation not permitted, open '${homedir()}/${folderName}/blocked.txt'`,
      'darwin',
    )).toBe(expected);
  });

  it('does not classify non-macOS or unrelated failures', () => {
    const failure = `Error: EPERM: operation not permitted, open '${homedir()}/Desktop/blocked.txt'`;
    expect(detectProtectedFolderEperm(failure, 'linux')).toBeNull();
    expect(detectProtectedFolderEperm(failure, 'win32')).toBeNull();
    expect(detectProtectedFolderEperm(`ENOENT: '${homedir()}/Desktop/missing.txt'`, 'darwin')).toBeNull();
    expect(detectProtectedFolderEperm(`EPERM: '${homedir()}/Pictures/blocked.txt'`, 'darwin')).toBeNull();
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
