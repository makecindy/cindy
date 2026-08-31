import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __extraDirsPathOverlapForTesting,
  pickAndAddExtraDir,
} from '../components/new-chat/extraDirsActions';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ExtraDirsButton path overlap normalization', () => {
  const { hasExtraDir, isParentOrAncestor, isSelfOrSubdir } = __extraDirsPathOverlapForTesting;

  it('dedupes picked Windows paths against stored POSIX-style draft paths', () => {
    expect(hasExtraDir(['D:/repo/refs'], 'D:\\repo\\refs\\')).toBe(true);
  });

  it('compares workingDir parent/subdir relationships after storage normalization', () => {
    expect(isSelfOrSubdir('D:\\repo\\app\\src', 'D:/repo/app')).toBe(true);
    expect(isParentOrAncestor('D:\\repo', 'D:/repo/app')).toBe(true);
    expect(isSelfOrSubdir('D:\\repo-other', 'D:/repo')).toBe(false);
  });
});

describe('pickAndAddExtraDir', () => {
  it('由调用方提供父目录确认弹窗的本地化文案', async () => {
    vi.stubGlobal('window', {
      electronAPI: {
        dialog: {
          showOpenDirectory: vi.fn(async () => ({ success: true, path: 'D:\\repo' })),
        },
      },
    });
    const confirm = vi.fn(async () => true);
    const onChange = vi.fn();

    await pickAndAddExtraDir({
      extraDirs: [],
      workingDir: 'D:/repo/app',
      onChange,
      confirm,
      parentDirectoryConfirm: {
        title: 'localized title',
        description: (path) => `localized description: ${path}`,
        confirmText: 'localized confirm',
        cancelText: 'localized cancel',
      },
    });

    expect(confirm).toHaveBeenCalledWith({
      title: 'localized title',
      description: 'localized description: D:/repo',
      confirmText: 'localized confirm',
      cancelText: 'localized cancel',
    });
    expect(onChange).toHaveBeenCalledWith(['D:/repo']);
  });

  it('在只读与可写授权组之间去重,不把同一路径加入第二组', async () => {
    vi.stubGlobal('window', {
      electronAPI: {
        dialog: {
          showOpenDirectory: vi.fn(async () => ({ success: true, path: '/shared/output/' })),
        },
      },
    });
    const confirm = vi.fn(async () => true);
    const onChange = vi.fn();

    await pickAndAddExtraDir({
      extraDirs: [],
      otherDirs: ['/shared/output'],
      workingDir: '/workspace',
      onChange,
      confirm,
      parentDirectoryConfirm: {
        title: 'title',
        description: (path) => path,
        confirmText: 'confirm',
        cancelText: 'cancel',
      },
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});
