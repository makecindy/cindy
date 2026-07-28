import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve()),
  readdir: vi.fn<(...args: unknown[]) => Promise<string[]>>(() => Promise.resolve([])),
}));

vi.mock('electron', () => ({
  shell: { openExternal: mocks.openExternal },
}));

// 只替换 readdir,其余 fs/promises 能力保持真实,避免影响同模块图下的其他代码。
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readdir: mocks.readdir,
}));

import {
  beginProtectedFolderCheck,
  detectProtectedFolderEperm,
  endProtectedFolderCheck,
  markEpermGuidanceShown,
  openFolderPrivacySettings,
  probeProtectedFolderAccess,
  releaseEpermGuidance,
  resetEpermGuidanceForTest,
} from '../permissions.js';

function fsError(code: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

beforeEach(() => {
  mocks.openExternal.mockReset();
  mocks.openExternal.mockResolvedValue(undefined);
  mocks.readdir.mockReset();
  mocks.readdir.mockResolvedValue([]);
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

  it('requires the denial phrase and the protected path to be near each other', () => {
    const blocked = path.join(homedir(), 'Documents', 'blocked.txt');
    // 读到一份**内容里写着 EPERM 的源码**:关键词与路径同时出现,但相隔很远。
    const sourceFileRead = [
      "const EPERM_PATTERNS = /operation not permitted|eperm/i;",
      'x'.repeat(600),
      `matched at '${blocked}'`,
    ].join('\n');
    expect(detectProtectedFolderEperm(sourceFileRead, 'darwin')).toBeNull();

    // 真实报错里两者紧挨着,必须仍然命中。
    expect(
      detectProtectedFolderEperm(
        `Error: EPERM: operation not permitted, open '${blocked}'`,
        'darwin',
      ),
    ).toBe('Documents');
  });

  it('finds a near pair even when unrelated far-apart occurrences come first', () => {
    const blocked = path.join(homedir(), 'Desktop', 'blocked.txt');
    // 先来一对隔得很远的(无关),真正的报错出现在后面;双指针扫描不能在第一对就放弃。
    const text = [
      'EPERM appears here first, with no path nearby',
      'y'.repeat(400),
      `unrelated mention of '${blocked}' far from the phrase above`,
      'z'.repeat(400),
      `Error: EPERM: operation not permitted, scandir '${blocked}'`,
    ].join('\n');
    expect(detectProtectedFolderEperm(text, 'darwin')).toBe('Desktop');
  });

  it('reports granted when the main process can read the folder', async () => {
    await expect(probeProtectedFolderAccess('Documents', 'darwin')).resolves.toBe('granted');
    expect(mocks.readdir).toHaveBeenCalledWith(path.join(homedir(), 'Documents'));
  });

  it.each(['EPERM', 'EACCES'])('reports denied when macOS rejects the read: %s', async (code) => {
    mocks.readdir.mockRejectedValue(fsError(code));
    await expect(probeProtectedFolderAccess('Desktop', 'darwin')).resolves.toBe('denied');
  });

  it('reports unknown for failures unrelated to TCC', async () => {
    mocks.readdir.mockRejectedValue(fsError('ENOENT'));
    await expect(probeProtectedFolderAccess('Downloads', 'darwin')).resolves.toBe('unknown');
  });

  it('does not probe on other platforms', async () => {
    await expect(probeProtectedFolderAccess('Desktop', 'linux')).resolves.toBe('granted');
    expect(mocks.readdir).not.toHaveBeenCalled();
  });

  it('serializes probes process-wide and only consumes the slot once guidance is shown', () => {
    expect(beginProtectedFolderCheck('Desktop')).toBe(true);
    // 探测进行中:同目录与其它目录都必须等,未授权的 readdir 会卡在系统弹窗上。
    expect(beginProtectedFolderCheck('Desktop')).toBe(false);
    expect(beginProtectedFolderCheck('Documents')).toBe(false);
    // 结束的是别的目录时不得误放开当前占位。
    endProtectedFolderCheck('Documents');
    expect(beginProtectedFolderCheck('Documents')).toBe(false);

    // 探测结论是「权限正常」时不标记已提示:名额没被误报吃掉,之后真被拒仍会提示。
    endProtectedFolderCheck('Desktop');
    expect(beginProtectedFolderCheck('Desktop')).toBe(true);

    markEpermGuidanceShown('Desktop');
    endProtectedFolderCheck('Desktop');
    expect(beginProtectedFolderCheck('Desktop')).toBe(false);

    releaseEpermGuidance('Desktop');
    expect(beginProtectedFolderCheck('Desktop')).toBe(true);
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
