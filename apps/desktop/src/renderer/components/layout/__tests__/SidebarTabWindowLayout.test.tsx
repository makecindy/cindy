// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果:挂载真实 SidebarTabWindowLayout(页签弹出窗口根组件),观察它何时
 *   订阅聊天事件流(makerChatStore.initGlobalListeners)。未指派的预热 spare 订阅后,会在整个
 *   运行期对每个任务的每个流式片段跑 reducer 并囤积会话内存态。
 * - 规则依据:docs/dev-rules/electron-security-and-process-boundaries.md §3.1「隐藏预热阶段
 *   暂停后台工作」及页签弹出窗口段落(spare 指派前不订阅聊天事件流)。
 * - 现有覆盖缺口:controller 单测只覆盖 main 侧状态机;本组件此前没有任何测试。
 * - 最小失败输入:只挂载、不指派(spare 状态)。旧代码挂载即订阅,本用例失败。
 * - tier:unit(jsdom,依赖全部替换为内存 fake,不加载 RightSidebarShell)。
 * - 实测耗时:见 PR 描述。
 */

import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SidebarTabWindowAssignmentPayload } from '../../../../shared/sidebarTabWindow';

const hoisted = vi.hoisted(() => ({
  initGlobalListeners: vi.fn(),
  listenerCallsWhenShellRendered: [] as number[],
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: { initGlobalListeners: hoisted.initGlobalListeners },
}));
vi.mock('@/features/right-sidebar/RightSidebarShell', () => ({
  RightSidebarShell: () => {
    hoisted.listenerCallsWhenShellRendered.push(hoisted.initGlobalListeners.mock.calls.length);
    return null;
  },
}));
const emptyBucket = { tabs: [], hydrated: false };
vi.mock('@/features/right-sidebar/store', () => ({
  closeTab: vi.fn(),
  getBucket: () => emptyBucket,
  getSingleTabSnapshot: vi.fn(),
  importTabSnapshot: vi.fn(),
  isTabClosing: () => false,
  refreshSessionFromDb: vi.fn(async () => undefined),
  subscribe: () => () => undefined,
}));
const noGlobalTabs: never[] = [];
vi.mock('@/features/right-sidebar/globalTabs', () => ({
  findGlobalTab: vi.fn(),
  isGlobalTabId: () => false,
  removeGlobalTab: vi.fn(),
  useGlobalTabs: () => noGlobalTabs,
  requestRevealSessionTab: vi.fn(),
}));
vi.mock('@/features/right-sidebar/lib/tabHosting', () => ({
  addHostedTabId: vi.fn(),
  setHostedTabIds: vi.fn(),
  useHostedTabIds: () => noGlobalTabs,
}));
vi.mock('@/features/right-sidebar/lib/mergeSidebarWindowBack', () => ({
  mergeSidebarWindowBack: vi.fn(),
}));
vi.mock('@/features/device-link/useDeviceLinkRemoteProjects', () => ({
  useDeviceLinkRemoteProjects: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => ({ ToastContainer: () => null }));
vi.mock('@/components/title-bar/WindowControls', () => ({ WindowControls: () => null }));
vi.mock('@/components/title-bar/ChromeIconButton', () => ({ ChromeIconButton: () => null }));
vi.mock('@/hooks/useAppShortcut', () => ({ useAppShortcut: vi.fn() }));
vi.mock('@/hooks/useCloseWindowShortcut', () => ({ useCloseShortcutShellOwner: vi.fn() }));
vi.mock('@/hooks/useLocale', () => ({
  useLocale: () => ({ effectiveLocale: 'en', setLocale: vi.fn() }),
}));
vi.mock('@/cindy-brain/GhostMediaLightboxHost', () => ({ GhostMediaLightboxHost: () => null }));
vi.mock('@/cindy-brain/ghostPanels', () => ({
  ensureGhostPanelsRegistered: vi.fn(),
  useGhostPanelsSync: vi.fn(),
}));

import { SidebarTabWindowLayout } from '../SidebarTabWindowLayout';

const assignment: SidebarTabWindowAssignmentPayload = {
  windowId: 'w1',
  sessionId: 'session-1',
  tabs: [{ tabId: 'tab-1', sessionId: 'session-1' }],
  context: { workdir: '/tmp/work' },
} as SidebarTabWindowAssignmentPayload;

function installBridge(initialAssignment: SidebarTabWindowAssignmentPayload | null) {
  let deliver: ((next: SidebarTabWindowAssignmentPayload) => void) | null = null;
  const noop = () => () => undefined;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'win32',
    sidebarTabWindow: {
      onAssigned: (cb: (next: SidebarTabWindowAssignmentPayload) => void) => {
        deliver = cb;
        return () => undefined;
      },
      getAssignment: async () => initialAssignment,
      rendererReady: async () => undefined,
      presentationReady: async () => undefined,
      closeForTab: async () => undefined,
      adoptTab: async () => undefined,
      onLocaleChanged: noop,
      onVisibilityChanged: noop,
      onCloseRequested: noop,
    },
  };
  return { assign: (next: SidebarTabWindowAssignmentPayload) => deliver?.(next) };
}

afterEach(() => {
  hoisted.initGlobalListeners.mockClear();
  hoisted.listenerCallsWhenShellRendered.length = 0;
});

describe('SidebarTabWindowLayout chat event subscription', () => {
  it('keeps the prewarmed spare off the chat event stream until a tab is assigned', async () => {
    const bridge = installBridge(null);
    render(<SidebarTabWindowLayout />);
    await act(async () => undefined);
    expect(hoisted.initGlobalListeners).not.toHaveBeenCalled();
    expect(hoisted.listenerCallsWhenShellRendered).toEqual([]);

    await act(async () => bridge.assign(assignment));

    expect(hoisted.initGlobalListeners).toHaveBeenCalledWith({
      ownsRemoteAuthRetry: false,
      ownsRemoteListCache: false,
    });
    // 页签内容挂载时监听必须已经就位,否则内容首拉与监听之间会漏流式事件。
    expect(hoisted.listenerCallsWhenShellRendered.length).toBeGreaterThan(0);
    expect(hoisted.listenerCallsWhenShellRendered.every((count) => count > 0)).toBe(true);
  });

  it('subscribes when a reloaded window recovers its existing assignment', async () => {
    installBridge(assignment);
    render(<SidebarTabWindowLayout />);
    await act(async () => undefined);
    expect(hoisted.initGlobalListeners).toHaveBeenCalled();
    expect(hoisted.listenerCallsWhenShellRendered.every((count) => count > 0)).toBe(true);
  });
});
