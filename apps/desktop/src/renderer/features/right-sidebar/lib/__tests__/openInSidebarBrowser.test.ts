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
}));
vi.mock('../sidebarCommands', () => ({
  requestRightSidebarVisibility: vi.fn(),
}));
vi.mock('../detachedSidebarRouting', () => ({
  routeSidebarCommand: vi.fn(async () => 'attached'),
}));

import { addTab, ensureHydrated } from '../../store';
import { requestRightSidebarVisibility } from '../sidebarCommands';
import { routeSidebarCommand } from '../detachedSidebarRouting';
import { openUrlInSidebarBrowser, pathToFileUrl } from '../openInSidebarBrowser';

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

describe('openUrlInSidebarBrowser', () => {
  beforeEach(() => {
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
