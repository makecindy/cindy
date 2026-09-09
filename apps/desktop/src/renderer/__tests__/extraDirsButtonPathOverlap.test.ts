import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __extraDirsPathOverlapForTesting,
  countUserExtraDirs,
  extraDirDisplayLabel,
  LIBRARY_EXTRA_DIR_SLOT_PREFIX,
  MAX_EXTRA_DIRS,
  partitionExtraDirs,
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

  it('library 槽不占用户 EXTRA_DIRS_MAX,显示为系统项', async () => {
    const library = `${LIBRARY_EXTRA_DIR_SLOT_PREFIX}/tmp/mivo-library`;
    const userDirs = Array.from({ length: MAX_EXTRA_DIRS }, (_, i) => `/tmp/user-${i}`);
    expect(countUserExtraDirs([...userDirs, library])).toBe(MAX_EXTRA_DIRS);
    expect(partitionExtraDirs([...userDirs, library])).toEqual({
      system: [library],
      user: userDirs,
    });
    expect(extraDirDisplayLabel(library)).toBe('Mivo 作品库（只读）');

    vi.stubGlobal('window', {
      electronAPI: {
        dialog: {
          showOpenDirectory: vi.fn(async () => ({ success: true, path: '/tmp/another' })),
        },
      },
    });
    const onChange = vi.fn();
    await pickAndAddExtraDir({
      extraDirs: [...userDirs, library],
      workingDir: '/workspace',
      onChange,
      confirm: vi.fn(async () => true),
      parentDirectoryConfirm: {
        title: 'title',
        description: (path) => path,
        confirmText: 'confirm',
        cancelText: 'cancel',
      },
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('composer extraDirs UI 接线 library 槽', () => {
  it('ChatInput 配额与计数走 countUserExtraDirs,不把 extraDirs.length 当用户名额', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '../components/new-chat/ChatInput.tsx'), 'utf8');
    expect(source).toMatch(/countUserExtraDirs\(currentExtraDirs\) \+ countUserExtraDirs\(currentWritableDirs\)/);
    expect(source).toMatch(/countUserExtraDirs\(extraDirs \?\? \[\]\) \+ countUserExtraDirs\(writableDirs \?\? \[\]\)/);
    expect(source).not.toMatch(/currentExtraDirs\.length \+ currentWritableDirs\.length/);
    expect(source).not.toMatch(/extraDirsCount=\{\(extraDirs \?\? \[\]\)\.length \+ \(writableDirs \?\? \[\]\)\.length\}/);
  });

  it('AtMentionPanel 把 library 槽显示为系统项且不提供移除按钮', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '../components/new-chat/AtMentionPanel.tsx'), 'utf8');
    expect(source).toContain('extraDirDisplayLabel');
    expect(source).toContain('isLibraryExtraDirSlot');
    expect(source).toMatch(/isLibraryExtraDirSlot\(p\) \? null/);
  });
});
