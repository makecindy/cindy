// @vitest-environment jsdom

/**
 * openGhostTabInSidebar — 覆盖宿主裁决三分支(仿 openInSidebarBrowser.test):
 *  - attached:ensureHydrated → addOrFocusSingletonTab(ghost:<id>) → 请求可见
 *  - routed:命令已到子窗口,本地只请求可见(持久化折叠态)
 *  - queued / stale-context:不动本地 store 也不请求可见
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../store', () => ({
  addOrFocusSingletonTab: vi.fn(async () => ({ id: 't_1', kind: 'ghost:tab-demo-a', state: null })),
  ensureHydrated: vi.fn(async () => undefined),
}));
vi.mock('../sidebarCommands', () => ({
  requestRightSidebarVisibility: vi.fn(),
}));
vi.mock('../detachedSidebarRouting', () => ({
  routeSidebarCommand: vi.fn(async () => 'attached'),
}));

import { addOrFocusSingletonTab, ensureHydrated } from '../../store';
import { requestRightSidebarVisibility } from '../sidebarCommands';
import { routeSidebarCommand } from '../detachedSidebarRouting';
import { openGhostTabInSidebar } from '../openGhostTabInSidebar';

describe('openGhostTabInSidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(routeSidebarCommand).mockResolvedValue('attached');
  });

  it('attached:先 hydrate 再单例聚焦 ghost:<id>,最后请求侧栏可见', async () => {
    await openGhostTabInSidebar('s1', 'tab-demo-a');

    expect(routeSidebarCommand).toHaveBeenCalledWith({
      type: 'open-ghost-tab',
      sessionId: 's1',
      ghostId: 'tab-demo-a',
    });
    expect(ensureHydrated).toHaveBeenCalledWith('s1');
    expect(vi.mocked(ensureHydrated).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(addOrFocusSingletonTab).mock.invocationCallOrder[0],
    );
    expect(addOrFocusSingletonTab).toHaveBeenCalledWith('s1', 'ghost:tab-demo-a');
    expect(requestRightSidebarVisibility).toHaveBeenCalledWith('open', { sessionId: 's1' });
  });

  it('routed:命令交给子窗口,本地不写 store、仍请求可见', async () => {
    vi.mocked(routeSidebarCommand).mockResolvedValueOnce('routed');

    await openGhostTabInSidebar('remote-lead', 'tab-demo-a');

    expect(ensureHydrated).not.toHaveBeenCalled();
    expect(addOrFocusSingletonTab).not.toHaveBeenCalled();
    expect(requestRightSidebarVisibility).toHaveBeenCalledWith('open', {
      sessionId: 'remote-lead',
    });
  });

  it.each(['queued', 'stale-context'] as const)('%s:不写本地也不请求可见', async (routeResult) => {
    vi.mocked(routeSidebarCommand).mockResolvedValueOnce(routeResult);

    await openGhostTabInSidebar('stale', 'tab-demo-a');

    expect(ensureHydrated).not.toHaveBeenCalled();
    expect(addOrFocusSingletonTab).not.toHaveBeenCalled();
    expect(requestRightSidebarVisibility).not.toHaveBeenCalled();
  });

  it('addOrFocusSingletonTab 失败时向上抛,不请求可见(调用方兜错)', async () => {
    vi.mocked(addOrFocusSingletonTab).mockRejectedValueOnce(new Error('boom'));
    await expect(openGhostTabInSidebar('s1', 'tab-demo-a')).rejects.toThrow('boom');
    expect(requestRightSidebarVisibility).not.toHaveBeenCalled();
  });
});
