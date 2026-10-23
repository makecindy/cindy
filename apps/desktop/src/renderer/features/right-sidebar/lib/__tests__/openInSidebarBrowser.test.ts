// @vitest-environment jsdom

/**
 * openInSidebarBrowser — 覆盖两块确定性逻辑:
 *  - pathToFileUrl:Windows 盘符 / POSIX / 空格 / 中文 / `#` `?` 的 file:// 编码
 *  - openUrlInSidebarBrowser:addTab(web-browser, 正确 initialState) +
 *    requestRightSidebarVisibility('open', {sessionId}) 的调用次序与参数
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../store', () => ({
  addTab: vi.fn(async () => ({ id: 't_1', kind: 'web-browser', state: null })),
  ensureHydrated: vi.fn(async () => undefined),
  closeTab: vi.fn(async () => undefined),
  getBucket: vi.fn(() => ({ tabs: [], activeTabId: null })),
}));
vi.mock('../sidebarCommands', () => ({
  requestRightSidebarVisibility: vi.fn(),
}));
vi.mock('../detachedSidebarRouting', () => ({
  routeSidebarCommand: vi.fn(async () => 'attached'),
}));

import { addTab, closeTab, ensureHydrated, getBucket } from '../../store';
import { requestRightSidebarVisibility } from '../sidebarCommands';
import { routeSidebarCommand } from '../detachedSidebarRouting';
import {
  _resetPluginPreviewTabsForTests,
  getPendingPreviewTabIds,
  getPluginPreviewGhostId,
  markPluginPreviewTab,
} from '../pluginPreviewTabs';
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
    vi.clearAllMocks();
    _resetPluginPreviewTabsForTests();
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

  it('插件预览标签登记为「待绑定」(进程内),普通网页标签不登记', async () => {
    await openUrlInSidebarBrowser('s1', 'https://example.com/');
    expect(getPendingPreviewTabIds().size).toBe(0);

    await openUrlInSidebarBrowser('s1', 'https://example.com/', {
      userInitiated: false,
      previewRequestId: 'P'.repeat(43),
    });
    expect([...getPendingPreviewTabIds()]).toEqual(['t_1']);
  });

  it('detached 路由(routed)时不在本窗口登记:标签由对方窗口创建', async () => {
    vi.mocked(routeSidebarCommand).mockResolvedValue('routed');
    await openUrlInSidebarBrowser('s1', 'https://example.com/', {
      previewRequestId: 'P'.repeat(43),
    });
    expect(getPendingPreviewTabIds().size).toBe(0);
  });

  it('previewRequestId:随 detached 路由命令与新标签 initialState 一起下发;缺省时两处都不带该字段', async () => {
    const previewRequestId = 'P'.repeat(43);
    await openUrlInSidebarBrowser('s1', 'https://example.com/', {
      userInitiated: false,
      previewRequestId,
    });
    expect(routeSidebarCommand).toHaveBeenCalledWith(
      { type: 'open-web-browser', sessionId: 's1', url: 'https://example.com/', previewRequestId },
      { userInitiated: false },
    );
    expect(addTab).toHaveBeenCalledWith('s1', 'web-browser', {
      url: 'https://example.com/',
      title: '',
      favicon: null,
      isAudible: false,
      previewRequestId,
    });

    vi.mocked(addTab).mockClear();
    await openUrlInSidebarBrowser('s1', 'https://example.com/');
    expect(vi.mocked(addTab).mock.calls[0][2]).not.toHaveProperty('previewRequestId');
  });

  describe('同一预览页再次打开', () => {
    const PAGE = 'http://127.0.0.1:60296/control?udid=U&lang=en';
    const previewTab = (id: string, url: string, kind = 'web-browser') => ({
      id,
      kind,
      state: { url },
    });
    const open = (url: string) =>
      openUrlInSidebarBrowser('s1', url, {
        userInitiated: false,
        previewRequestId: 'P'.repeat(43),
      });

    it('已登记的同页预览标签被新标签取代(hash 令牌不同也算同一页),一个页面只留一个标签', async () => {
      markPluginPreviewTab('old-1');
      markPluginPreviewTab('old-2');
      vi.mocked(getBucket).mockReturnValue({
        tabs: [
          previewTab('old-1', `${PAGE}#cindyClipboard=60296.aaa`),
          previewTab('old-2', `${PAGE}#cindyClipboard=60296.bbb`),
        ],
        activeTabId: 'old-1',
      } as never);

      await open(`${PAGE}#cindyClipboard=60296.ccc`);

      expect(vi.mocked(closeTab).mock.calls.map((c) => c[1])).toEqual(['old-1', 'old-2']);
      expect(vi.mocked(closeTab).mock.invocationCallOrder[1]).toBeLessThan(
        vi.mocked(addTab).mock.invocationCallOrder[0],
      );
      expect(addTab).toHaveBeenCalledTimes(1);
    });

    it('不同端口 / 不同路径 / 不同 query、未登记的普通网页标签、非浏览器标签都不动', async () => {
      markPluginPreviewTab('other-port');
      markPluginPreviewTab('other-query');
      markPluginPreviewTab('not-browser');
      vi.mocked(getBucket).mockReturnValue({
        tabs: [
          previewTab('other-port', 'http://127.0.0.1:58232/control?udid=U&lang=en'),
          previewTab('other-query', 'http://127.0.0.1:60296/control?udid=V&lang=en'),
          previewTab('plain-web', PAGE), // 用户自己开的同址网页:未登记,不碰
          previewTab('not-browser', PAGE, 'file-browser'),
        ],
        activeTabId: null,
      } as never);

      await open(PAGE);

      expect(closeTab).not.toHaveBeenCalled();
      expect(addTab).toHaveBeenCalledTimes(1);
    });

    describe('同一插件的本机预览服务换端口', () => {
      const GHOST = 'baguette-simulator';
      const at = (port: number, extra = '') =>
        `http://127.0.0.1:${port}/control?udid=U&lang=en${extra}`;
      const openAs = (url: string, ghost: string | undefined = GHOST) =>
        openUrlInSidebarBrowser('s1', url, {
          userInitiated: false,
          previewRequestId: 'P'.repeat(43),
          ...(ghost ? { previewGhostId: ghost } : {}),
        });
      const bucketOf = (...tabs: ReturnType<typeof previewTab>[]) =>
        vi.mocked(getBucket).mockReturnValue({ tabs, activeTabId: null } as never);

      it('回环地址 + 同 path/query、仅端口不同 + 同一插件实例开的旧标签 → 被取代(含 localhost / 忽略 hash)', async () => {
        markPluginPreviewTab('dead-58232', GHOST);
        markPluginPreviewTab('dead-59832', GHOST);
        markPluginPreviewTab('dead-localhost', GHOST);
        bucketOf(
          previewTab('dead-58232', at(58232, '#cindyClipboard=58232.a')),
          previewTab('dead-59832', at(59832)),
          previewTab('dead-localhost', 'http://localhost:61000/control?udid=U&lang=en'),
        );

        await openAs(at(60296, '#cindyClipboard=60296.b'));

        expect(vi.mocked(closeTab).mock.calls.map((c) => c[1])).toEqual([
          'dead-58232',
          'dead-59832',
          'dead-localhost',
        ]);
        expect(addTab).toHaveBeenCalledTimes(1);
        // 新标签带上插件身份登记,下一次重开还能认出它
        expect(getPluginPreviewGhostId('t_1')).toBe(GHOST);
      });

      it('别的插件实例开的、没有身份记录的、path 或 query 不同的回环标签都不取代', async () => {
        markPluginPreviewTab('other-ghost', 'another-plugin');
        markPluginPreviewTab('no-ghost'); // 没有身份记录(只能按完全同页取代)
        markPluginPreviewTab('other-path', GHOST);
        markPluginPreviewTab('other-udid', GHOST);
        bucketOf(
          previewTab('other-ghost', at(58232)),
          previewTab('no-ghost', at(58233)),
          previewTab('other-path', 'http://127.0.0.1:58234/other?udid=U&lang=en'),
          previewTab('other-udid', 'http://127.0.0.1:58235/control?udid=V&lang=en'),
        );

        await openAs(at(60296));

        expect(closeTab).not.toHaveBeenCalled();
      });

      it('非回环地址维持 origin + path + query:换端口不算同一页,即使同一插件', async () => {
        markPluginPreviewTab('remote-old', GHOST);
        markPluginPreviewTab('remote-same', GHOST);
        bucketOf(
          previewTab('remote-old', 'https://preview.example.dev:8443/app?x=1'),
          previewTab('remote-same', 'https://preview.example.dev:9443/app?x=1#tok'),
        );

        await openAs('https://preview.example.dev:9443/app?x=1#tok2');

        expect(vi.mocked(closeTab).mock.calls.map((c) => c[1])).toEqual(['remote-same']);
      });

      it('回环旧标签与非回环新预览(或反过来)互不取代', async () => {
        markPluginPreviewTab('loop-old', GHOST);
        bucketOf(previewTab('loop-old', at(58232)));

        await openAs('https://preview.example.dev/control?udid=U&lang=en');

        expect(closeTab).not.toHaveBeenCalled();
      });

      it('身份随 detached 路由命令下发;没有 previewRequestId 时不带身份', async () => {
        await openAs(at(60296));
        expect(routeSidebarCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'open-web-browser',
            previewRequestId: 'P'.repeat(43),
            previewGhostId: GHOST,
          }),
          { userInitiated: false },
        );
        vi.mocked(routeSidebarCommand).mockClear();
        await openUrlInSidebarBrowser('s1', at(60296), { previewGhostId: GHOST });
        expect(vi.mocked(routeSidebarCommand).mock.calls[0][0]).not.toHaveProperty(
          'previewGhostId',
        );
      });
    });

    it('非预览打开(无 previewRequestId)从不关闭任何标签', async () => {
      markPluginPreviewTab('old-1');
      vi.mocked(getBucket).mockReturnValue({
        tabs: [previewTab('old-1', PAGE)],
        activeTabId: null,
      } as never);

      await openUrlInSidebarBrowser('s1', PAGE);

      expect(closeTab).not.toHaveBeenCalled();
    });
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
