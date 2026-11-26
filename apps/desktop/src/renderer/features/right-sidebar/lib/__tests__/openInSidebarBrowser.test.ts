// @vitest-environment jsdom

/**
 * openInSidebarBrowser — 覆盖两块确定性逻辑:
 *  - pathToFileUrl:Windows 盘符 / POSIX / 空格 / 中文 / `#` `?` 的 file:// 编码
 *  - openUrlInSidebarBrowser:addTab(web-browser, 正确 initialState) +
 *    requestRightSidebarVisibility('open', {sessionId}) 的调用次序与参数
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../store', async (importOriginal) => {
  const store = await importOriginal<typeof import('../../store')>();
  return { ...store, addTab: vi.fn(store.addTab), ensureHydrated: vi.fn(store.ensureHydrated) };
});
vi.mock('../sidebarCommands', () => ({
  requestRightSidebarVisibility: vi.fn(),
}));
vi.mock('../detachedSidebarRouting', () => ({
  routeSidebarCommand: vi.fn(async () => 'attached'),
}));

import { _resetStore, addTab, ensureHydrated, getBucket, patchTabState } from '../../store';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { requestRightSidebarVisibility } from '../sidebarCommands';
import { routeSidebarCommand } from '../detachedSidebarRouting';
import {
  openUrlInSidebarBrowser,
  pathToFileUrl,
  fileUrlToAbsPath,
  isLocalHtmlFileUrl,
} from '../openInSidebarBrowser';

describe('pathToFileUrl', () => {
  it('converts a Windows drive path with backslashes', () => {
    expect(pathToFileUrl('E:\\out\\index.html')).toBe('file:///E:/out/index.html');
  });

  it('keeps POSIX absolute paths and encodes spaces', () => {
    expect(pathToFileUrl('/Users/a b/x.html')).toBe('file:///Users/a%20b/x.html');
  });

  it('percent-encodes CJK, # and ? so they cannot become fragment/query', () => {
    expect(pathToFileUrl('E:\\页 面#1.html')).toBe('file:///E:/%E9%A1%B5%20%E9%9D%A2%231.html');
    expect(pathToFileUrl('/tmp/a?b.html')).toBe('file:///tmp/a%3Fb.html');
  });
});

describe('fileUrlToAbsPath / isLocalHtmlFileUrl', () => {
  it('round-trips POSIX paths including spaces', () => {
    expect(fileUrlToAbsPath('file:///Users/a%20b/x.html')).toBe('/Users/a b/x.html');
    expect(isLocalHtmlFileUrl('file:///Users/a%20b/x.html')).toBe(true);
  });

  it('round-trips Windows drive paths', () => {
    expect(fileUrlToAbsPath('file:///E:/out/index.html')).toBe('E:\\out\\index.html');
    expect(isLocalHtmlFileUrl('file:///E:/out/index.htm')).toBe(true);
  });

  it('rejects non-file and non-html URLs', () => {
    expect(fileUrlToAbsPath('https://example.com/x.html')).toBeNull();
    expect(fileUrlToAbsPath('file:///%E0%A4%A.html')).toBeNull();
    expect(isLocalHtmlFileUrl('https://example.com/x.html')).toBe(false);
    expect(isLocalHtmlFileUrl('file:///tmp/notes.md')).toBe(false);
    expect(isLocalHtmlFileUrl('about:blank')).toBe(false);
    expect(isLocalHtmlFileUrl('file:///tmp/preview.xhtml')).toBe(false);
  });

  it('rejects non-local file authorities', () => {
    expect(fileUrlToAbsPath('file://server/share/index.html')).toBeNull();
    expect(isLocalHtmlFileUrl('file://server/share/index.html')).toBe(false);
    expect(fileUrlToAbsPath('file://localhost:8080/tmp/index.html')).toBeNull();
    expect(isLocalHtmlFileUrl('file://localhost:8080/tmp/index.html')).toBe(false);
  });

  it('ignores hash/query when recovering the path', () => {
    expect(fileUrlToAbsPath('file:///tmp/x.html#section')).toBe('/tmp/x.html');
  });
});

describe('openUrlInSidebarBrowser', () => {
  beforeEach(() => {
    _resetStore();
    setDataOwnerGeneration('owner-a', 1);
    vi.clearAllMocks();
    vi.mocked(routeSidebarCommand).mockResolvedValue('attached');
  });

  it('adds a fresh web-browser tab with the canonical initial state, then requests visibility', async () => {
    await openUrlInSidebarBrowser('s1', 'https://example.com/');
    // hydrate 竞态防护:addTab 前必须先 ensureHydrated(同一 session)。
    expect(ensureHydrated).toHaveBeenCalledWith('s1');
    expect(vi.mocked(ensureHydrated).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(addTab).mock.invocationCallOrder[0],
    );
    expect(addTab).toHaveBeenCalledWith('s1', 'web-browser', {
      url: 'https://example.com/',
      title: '',
      favicon: null,
      isAudible: false,
    });
    expect(requestRightSidebarVisibility).toHaveBeenCalledWith('open', {
      sessionId: 's1',
      userInitiated: true,
    });
  });

  it('插件 preview 开页(userInitiated:false)照常落标签,但不请求抢焦点', async () => {
    await openUrlInSidebarBrowser('s1', 'https://example.com/', { userInitiated: false });

    expect(routeSidebarCommand).toHaveBeenCalledWith(
      { type: 'open-web-browser', sessionId: 's1', url: 'https://example.com/' },
      { userInitiated: false },
    );
    expect(addTab).toHaveBeenCalled();
    expect(requestRightSidebarVisibility).toHaveBeenCalledWith('open', {
      sessionId: 's1',
      userInitiated: false,
    });
  });

  // unit：原测试只记录开页调用。同任务同实例同 URL 并发打开是最小失败输入，真实任务桶应只新增一页。
  const previewOptions = (instanceId = 'preview-ghost', reuseExisting = true) => ({
    userInitiated: false,
    pluginPreview: {
      instanceId,
      ...(reuseExisting ? { reuseExisting: true as const } : {}),
      ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 1 },
    },
  });

  it('adds one preview for concurrent requests that resolve to the same complete URL', async () => {
    await Promise.all([
      openUrlInSidebarBrowser('s1', 'https://EXAMPLE.com:443/path?q=1#one', previewOptions()),
      openUrlInSidebarBrowser('s1', 'https://example.com/path?q=1#one', previewOptions()),
    ]);
    expect(getBucket('s1').tabs).toHaveLength(1);
  });

  it('focuses a matching plugin tab and opens another after navigation', async () => {
    const url = 'https://example.com/path?q=1#one';
    await openUrlInSidebarBrowser('s1', url, previewOptions('preview-ghost', false));
    const [first] = getBucket('s1').tabs;
    await openUrlInSidebarBrowser('s1', url);
    await openUrlInSidebarBrowser('s1', url, previewOptions());
    expect(getBucket('s1').tabs).toHaveLength(2);
    expect(getBucket('s1').activeTabId).toBe(first.id);

    await patchTabState('s1', first.id, (current) => ({ ...current as object, url: 'https://example.com/path?q=1#two' }));
    await openUrlInSidebarBrowser('s1', url, previewOptions());
    expect(getBucket('s1').tabs).toHaveLength(3);
    expect(getBucket('s1').activeTabId).not.toBe(first.id);
  });

  it('keeps instance, task and account boundaries', async () => {
    const url = 'https://example.com/';
    await openUrlInSidebarBrowser('s1', url, previewOptions());
    await openUrlInSidebarBrowser('s1', url, previewOptions('other-ghost'));
    await openUrlInSidebarBrowser('s2', url, previewOptions());
    setDataOwnerGeneration('owner-b', 2);
    await openUrlInSidebarBrowser('s1', url, previewOptions());
    expect(getBucket('s1').tabs).toHaveLength(2);
    expect(getBucket('s2').tabs).toHaveLength(1);
  });

  it('does not request visibility when addTab rejects (caller surfaces the error)', async () => {
    vi.mocked(addTab).mockRejectedValueOnce(new Error('boom'));
    await expect(openUrlInSidebarBrowser('s1', 'https://example.com/')).rejects.toThrow('boom');
    expect(requestRightSidebarVisibility).not.toHaveBeenCalled();
  });

  it('routes detached open to the sidebar window without touching the main renderer store', async () => {
    vi.mocked(routeSidebarCommand).mockResolvedValueOnce('routed');

    await openUrlInSidebarBrowser('remote-lead', 'https://example.com/');

    expect(routeSidebarCommand).toHaveBeenCalledWith(
      {
        type: 'open-web-browser',
        sessionId: 'remote-lead',
        url: 'https://example.com/',
      },
      { userInitiated: true },
    );
    expect(ensureHydrated).not.toHaveBeenCalled();
    expect(addTab).not.toHaveBeenCalled();
    expect(requestRightSidebarVisibility).toHaveBeenCalledWith('open', {
      sessionId: 'remote-lead',
      userInitiated: true,
    });
  });

  it.each(['queued', 'stale-context'] as const)(
    'does not write local state or request visibility for %s',
    async (routeResult) => {
      vi.mocked(routeSidebarCommand).mockResolvedValueOnce(routeResult);
      await openUrlInSidebarBrowser('stale', 'https://example.com/');

      expect(ensureHydrated).not.toHaveBeenCalled();
      expect(addTab).not.toHaveBeenCalled();
      expect(requestRightSidebarVisibility).not.toHaveBeenCalled();
    },
  );
});
