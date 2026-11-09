// @vitest-environment jsdom

/**
 * openInSidebarFileBrowser — 覆盖聊天文件 / 目录 chip 打开 RSB 文件浏览器的
 * 状态写入协议。目录定位只写 revealDirPath;已有 tab 的文件定位只写
 * revealFilePath,由 FileBrowserBody 过 dirty guard 后再选中文件并滚动到文件行。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Bucket = {
  tabs: Array<{ id: string; kind: string; state: unknown }>;
  activeTabId: string | null;
};

let bucket: Bucket = { tabs: [], activeTabId: null };

vi.mock('../../store', () => ({
  addTab: vi.fn(async () => ({ id: 't_new', kind: 'file-browser', state: null })),
  ensureHydrated: vi.fn(async () => undefined),
  getBucket: vi.fn(() => bucket),
  patchTabState: vi.fn(async () => undefined),
  setActiveTab: vi.fn(async () => undefined),
}));
vi.mock('../sidebarCommands', () => ({
  requestRightSidebarVisibility: vi.fn(),
}));
vi.mock('../detachedSidebarRouting', () => ({
  routeSidebarCommand: vi.fn(async () => 'attached'),
}));

import { addTab, ensureHydrated, patchTabState, setActiveTab } from '../../store';
import { requestRightSidebarVisibility } from '../sidebarCommands';
import { routeSidebarCommand } from '../detachedSidebarRouting';
import {
  openDirInSidebarFileBrowser,
  openExternalFileInSidebarFileBrowser,
  openFileInSidebarFileBrowser,
} from '../openInSidebarFileBrowser';

describe('openInSidebarFileBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(routeSidebarCommand).mockResolvedValue('attached');
    bucket = { tabs: [], activeTabId: null };
  });

  it('creates a file-browser tab when opening a file without an existing one', async () => {
    await openFileInSidebarFileBrowser('s1', 'src/App.tsx');

    expect(ensureHydrated).toHaveBeenCalledWith('s1');
    expect(addTab).toHaveBeenCalledWith('s1', 'file-browser', {
      selectedFilePath: 'src/App.tsx',
      revealFilePath: 'src/App.tsx',
      revealFileNonce: 1,
    });
    expect(requestRightSidebarVisibility).toHaveBeenCalledWith('open', { sessionId: 's1' });
  });

  it('reuses an existing file-browser tab and writes a reveal request without bypassing dirty guard', async () => {
    bucket = {
      tabs: [{ id: 't1', kind: 'file-browser', state: { selectedFilePath: 'old.ts' } }],
      activeTabId: 'other',
    };

    await openFileInSidebarFileBrowser('s1', 'src/App.tsx');

    expect(setActiveTab).toHaveBeenCalledWith('s1', 't1');
    expect(patchTabState).toHaveBeenCalledWith('s1', 't1', expect.any(Function));
    const updater = vi.mocked(patchTabState).mock.calls[0]?.[2] as
      | ((current: unknown) => unknown)
      | undefined;
    expect(updater?.({ selectedFilePath: 'old.ts', revealFileNonce: 4 })).toEqual({
      selectedFilePath: 'old.ts',
      revealFilePath: 'src/App.tsx',
      revealFileNonce: 5,
    });
    expect(requestRightSidebarVisibility).toHaveBeenCalledWith('open', { sessionId: 's1' });
  });

  // Plugin requests must retain background routing instead of acting as a user focus gesture.
  it('passes background intent through the production file-open entry', async () => {
    await openFileInSidebarFileBrowser('s1', 'report.md', { userInitiated: false });
    expect(routeSidebarCommand).toHaveBeenCalledWith({
      type: 'open-file-browser', sessionId: 's1', relPath: 'report.md', targetKind: 'file',
    }, { userInitiated: false });
  });

  it('keeps directory reveal behavior separate from file selection', async () => {
    await openDirInSidebarFileBrowser('s1', 'src/components');

    expect(addTab).toHaveBeenCalledWith('s1', 'file-browser', {
      selectedFilePath: null,
      revealDirPath: 'src/components',
      revealDirNonce: 1,
    });
  });

  it('writes an external-file request for FileBrowserBody to consume through the drop path', async () => {
    await openExternalFileInSidebarFileBrowser('s1', 'C:\\tmp\\note.md');

    expect(addTab).toHaveBeenCalledWith('s1', 'file-browser', {
      selectedFilePath: null,
      externalFilePath: 'C:\\tmp\\note.md',
      externalFileNonce: 1,
    });
    expect(requestRightSidebarVisibility).toHaveBeenCalledWith('open', { sessionId: 's1' });
  });

  it('reuses an existing file-browser tab for repeated external-file requests', async () => {
    bucket = {
      tabs: [{ id: 't1', kind: 'file-browser', state: { selectedFilePath: 'old.ts' } }],
      activeTabId: 't1',
    };

    await openExternalFileInSidebarFileBrowser('s1', 'C:\\tmp\\note.md');

    const updater = vi.mocked(patchTabState).mock.calls[0]?.[2] as
      ((current: unknown) => unknown) | undefined;
    expect(updater?.({ selectedFilePath: 'old.ts', externalFileNonce: 2 })).toEqual({
      selectedFilePath: 'old.ts',
      externalFilePath: 'C:\\tmp\\note.md',
      externalFileNonce: 3,
    });
  });

  it('routes detached file and directory opens without writing the main renderer store', async () => {
    vi.mocked(routeSidebarCommand).mockResolvedValue('routed');

    await openFileInSidebarFileBrowser('remote-lead', 'src/App.tsx');
    await openDirInSidebarFileBrowser('remote-lead', 'src/components');
    await openExternalFileInSidebarFileBrowser('remote-lead', 'C:\\tmp\\note.md');

    expect(routeSidebarCommand).toHaveBeenNthCalledWith(1, {
      type: 'open-file-browser',
      sessionId: 'remote-lead',
      relPath: 'src/App.tsx',
      targetKind: 'file',
    });
    expect(routeSidebarCommand).toHaveBeenNthCalledWith(2, {
      type: 'open-file-browser',
      sessionId: 'remote-lead',
      relPath: 'src/components',
      targetKind: 'directory',
    });
    expect(routeSidebarCommand).toHaveBeenNthCalledWith(3, {
      type: 'open-file-browser',
      sessionId: 'remote-lead',
      absPath: 'C:\\tmp\\note.md',
      targetKind: 'external-file',
    });
    expect(ensureHydrated).not.toHaveBeenCalled();
    expect(addTab).not.toHaveBeenCalled();
    expect(patchTabState).not.toHaveBeenCalled();
  });

  it.each(['queued', 'stale-context'] as const)(
    'does not write local state for %s',
    async (routeResult) => {
      vi.mocked(routeSidebarCommand).mockResolvedValue(routeResult);
      await openFileInSidebarFileBrowser('stale', 'src/App.tsx');

      expect(ensureHydrated).not.toHaveBeenCalled();
      expect(addTab).not.toHaveBeenCalled();
      expect(patchTabState).not.toHaveBeenCalled();
      expect(requestRightSidebarVisibility).not.toHaveBeenCalled();
    },
  );
});
