import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __extraDirsPathOverlapForTesting,
  addRecentWritableDir,
  countUserExtraDirs,
  extraDirDisplayLabel,
  LIBRARY_EXTRA_DIR_SLOT_PREFIX,
  MAX_EXTRA_DIRS,
  partitionExtraDirs,
  pickAndAddExtraDir,
  selectableRecentExtraDirs,
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

  // PR #8602 review：最近列表直接授权，漏判上级目录 = 不经二次确认就把整个上级目录交给 Agent。
  // 根目录曾被比成空串；Windows 盘符路径大小写不同也认不出。POSIX 路径仍区分大小写。
  it.each([
    ['/', '/home/me/project', []],
    ['D:/repo', 'D:/Repo/App', []],
    ['D:/REPO/APP/src', 'D:/Repo/App', []],
    ['/Users/Me', '/users/me/app', ['/Users/Me']],
  ])('recent list hides %s for working dir %s unless it is unrelated', (path, workingDir, kept) => {
    expect(
      selectableRecentExtraDirs([{ path }], { addedDirs: [], workingDir }).map((o) => o.path),
    ).toEqual(kept);
  });
});

describe('pickAndAddExtraDir', () => {
  it('可写目录使用任务绑定的系统选择器授权，并确认父目录扩权', async () => {
    const showOpenDirectory = vi.fn(async () => ({ success: true, path: 'D:\\repo' }));
    vi.stubGlobal('window', {
      electronAPI: {
        dialog: {
          showOpenDirectory,
        },
      },
    });
    const confirm = vi.fn(async () => true);
    const onChange = vi.fn();

    await pickAndAddExtraDir({
      extraDirs: [],
      workingDir: 'D:/repo/app',
      writableGrantScope: 'task-directory-grant',
      onChange,
      confirm,
      parentDirectoryConfirm: {
        title: 'localized title',
        description: (path) => `localized description: ${path}`,
        confirmText: 'localized confirm',
        cancelText: 'localized cancel',
      },
    });

    expect(showOpenDirectory).toHaveBeenCalledWith({ writableGrantScope: 'task-directory-grant' });
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
    expect(extraDirDisplayLabel(library, 'Localized library')).toBe('Localized library');

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

describe('添加目录二级页的保存与留页依据', () => {
  // 取消系统选择器时二级页要留着，ChatInput 靠返回值决定关不关面板。
  it('选择器取消时返回 false 且不保存', async () => {
    vi.stubGlobal('window', {
      electronAPI: { dialog: { showOpenDirectory: vi.fn(async () => ({ success: true, path: null })) } },
    });
    const onChange = vi.fn();
    await expect(pickAndAddExtraDir({
      extraDirs: [],
      workingDir: '/workspace',
      writableGrantScope: 'task',
      onChange,
      confirm: vi.fn(async () => true),
      parentDirectoryConfirm: {
        title: 'title',
        description: (path) => path,
        confirmText: 'confirm',
        cancelText: 'cancel',
      },
    })).resolves.toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('最近目录先由 Main 授权再保存；授权被拒时不保存', async () => {
    const authorizeRecentWritableDirectory = vi.fn(async () => ({ success: true as const }));
    vi.stubGlobal('window', { electronAPI: { dialog: { authorizeRecentWritableDirectory } } });
    const onChange = vi.fn();
    await addRecentWritableDir({
      path: 'D:/work/ai-gateway',
      writableDirs: ['/work/refs'],
      writableGrantScope: 'task',
      onChange,
    });
    expect(authorizeRecentWritableDirectory).toHaveBeenCalledWith({
      directory: 'D:/work/ai-gateway',
      writableGrantScope: 'task',
    });
    expect(onChange).toHaveBeenCalledWith(['/work/refs', 'D:/work/ai-gateway']);

    authorizeRecentWritableDirectory.mockRejectedValueOnce(
      new Error('[WRITABLE_DIRECTORY_AUTHORIZATION_REQUIRED] not recent'),
    );
    onChange.mockClear();
    await expect(addRecentWritableDir({
      path: '/work/other',
      writableDirs: [],
      writableGrantScope: 'task',
      onChange,
    })).rejects.toThrow(/AUTHORIZATION_REQUIRED/);
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
