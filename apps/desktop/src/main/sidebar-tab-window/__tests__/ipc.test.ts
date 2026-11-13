// 测试价值
// - 生产入口与可观察结果:registerSidebarTabWindowIpc 注册的 handler;可观察的是
//   非主窗 sender 的弹出请求被拒(PERMISSION_DENIED)、坏 payload 被拒(INVALID_PARAMS)、
//   只有页签窗口自己或主窗能对它发 close-for-tab,合法请求原样交给 controller。
// - Bug / 规则依据:electron-security-and-process-boundaries.md「所有 open / close / ready
//   IPC 都校验真实 sender」;弹出请求带 handoff(不可持久化会话内存态)不能被任意 renderer 伪造。
// - 现有覆盖缺口:controller 单测注入 deps,不经过 IPC 边界。
// - 最小失败输入:副窗 sender 调 open;缺 tabId 的 payload;无关 sender 调 close-for-tab。
// - tier:unit(electron ipcMain 以内存 map 桩替)。
// - 实测耗时:< 1s。

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => {
  const ipcMainHandlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, fn: (e: unknown, ...args: unknown[]) => unknown) => {
        ipcMainHandlers.set(channel, fn);
      }),
      on: vi.fn(),
      __handlers: ipcMainHandlers,
    },
  };
});
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));

import { ipcMain, type BrowserWindow } from 'electron';

import { MAKER_INVOKE } from '../../maker-ipc/channels.js';
import {
  SIDEBAR_TAB_WINDOW_ADOPT_TAB_CHANNEL,
  SIDEBAR_TAB_WINDOW_MERGE_BACK_CHANNEL,
} from '../../../shared/sidebarTabWindow.js';
import { registerSidebarTabWindowIpc } from '../ipc.js';
import type { SidebarTabWindowsController } from '../controller.js';

/** handler 内同步 throw 与异步 reject 统一成 rejected promise,便于用 rejects 断言。 */
function call(fn: (e: unknown, ...args: unknown[]) => unknown, event: unknown, ...args: unknown[]) {
  return Promise.resolve().then(() => fn(event, ...args));
}

function handlers() {
  return (
    ipcMain as unknown as {
      __handlers: Map<string, (e: unknown, ...args: unknown[]) => unknown>;
    }
  ).__handlers;
}

function makeController() {
  return {
    getState: vi.fn(() => ({})),
    open: vi.fn(() => true),
    focus: vi.fn(),
    closeForTab: vi.fn(),
    mergeBack: vi.fn(),
    getAssignment: vi.fn(() => null),
    markRendererReady: vi.fn(),
    markPresentationReady: vi.fn(),
    slotForSender: vi.fn<(sender: unknown) => { assignment: { tabs: { tabId: string }[] } } | null>(
      () => null,
    ),
    slotOwnsTab: (slot: { assignment: { tabs: { tabId: string }[] } }, tabId: string) =>
      slot.assignment.tabs.some((tab) => tab.tabId === tabId),
    adoptTab: vi.fn(),
    returnGlobalTab: vi.fn(() => true),
  };
}

const mainSender = { id: 1 };
const otherSender = { id: 2 };
const validRequest = {
  tabId: 'tab-a',
  sessionId: 's1',
  context: { workdir: '/repo', remoteHostId: null, deviceLinkDeviceId: null },
};

beforeEach(() => {
  handlers().clear();
});

function register(controller: ReturnType<typeof makeController>) {
  registerSidebarTabWindowIpc({
    controller: controller as unknown as SidebarTabWindowsController,
    getMainWindow: () =>
      ({ isDestroyed: () => false, webContents: mainSender }) as unknown as BrowserWindow,
  });
}

describe('sidebar-tab-window IPC', () => {
  // 扩展已有 focus 请求时保留旧调用默认，并拒绝不合法的后台手势标记。
  it('validates optional focus intent and preserves legacy foreground requests', async () => {
    const controller = makeController();
    register(controller);
    const focus = handlers().get(MAKER_INVOKE.SIDEBAR_TAB_WINDOW_FOCUS)!;
    await call(focus, { sender: mainSender }, 'tab-a');
    expect(controller.focus).toHaveBeenLastCalledWith('tab-a', { userInitiated: true });
    await call(focus, { sender: mainSender }, 'tab-a', { userInitiated: false });
    expect(controller.focus).toHaveBeenLastCalledWith('tab-a', { userInitiated: false });
    await expect(call(focus, { sender: mainSender }, 'tab-a', { userInitiated: 'false' })).rejects.toThrow(/INVALID_PARAMS/);
    expect(controller.focus).toHaveBeenCalledTimes(2);
  });
  it('only the main window may pop a tab out, and the payload must be well-formed', async () => {
    const controller = makeController();
    register(controller);
    const open = handlers().get(MAKER_INVOKE.SIDEBAR_TAB_WINDOW_OPEN)!;

    await expect(call(open, { sender: otherSender }, validRequest)).rejects.toThrow(
      /PERMISSION_DENIED/,
    );
    await expect(
      call(open, { sender: mainSender }, { ...validRequest, tabId: '' }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    await expect(
      call(
        open,
        { sender: mainSender },
        { ...validRequest, context: { subagentsAvailable: 'yes' } },
      ),
    ).rejects.toThrow(/INVALID_PARAMS/);
    await expect(
      call(
        open,
        { sender: mainSender },
        {
          ...validRequest,
          handoff: { sessionId: 's1', tabs: [], activeTabId: null, persistable: true },
        },
      ),
    ).rejects.toThrow(/INVALID_PARAMS/);
    await expect(
      call(open, { sender: mainSender }, { ...validRequest, position: { x: 'left', y: 2 } }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    expect(controller.open).not.toHaveBeenCalled();

    await call(open, { sender: mainSender }, { ...validRequest, position: { x: 640, y: 480 } });
    expect(controller.open).toHaveBeenLastCalledWith(
      expect.objectContaining({ tabId: 'tab-a', position: { x: 640, y: 480 } }),
    );

    await call(
      open,
      { sender: mainSender },
      {
        ...validRequest,
        handoff: {
          sessionId: 's1',
          tabs: [{ id: 'tab-a', kind: 'web-browser', state: { url: 'https://x' } }],
          activeTabId: 'tab-a',
          persistable: false,
        },
      },
    );
    expect(controller.open).toHaveBeenCalledWith({
      tabId: 'tab-a',
      sessionId: 's1',
      context: { workdir: '/repo', remoteHostId: null, deviceLinkDeviceId: null },
      handoff: {
        sessionId: 's1',
        tabs: [{ id: 'tab-a', kind: 'web-browser', state: { url: 'https://x' } }],
        activeTabId: 'tab-a',
        persistable: false,
      },
    });

    // 控制器没开出窗口:调用方必须收到拒绝,不能当成功。
    controller.open.mockReturnValueOnce(false);
    await expect(call(open, { sender: mainSender }, validRequest)).rejects.toThrow(/INTERNAL/);
  });

  it('lets the main window or the owning tab window close a window for a closed tab, nobody else', async () => {
    const controller = makeController();
    controller.slotForSender.mockImplementation((sender: unknown) =>
      sender === otherSender ? { assignment: { tabs: [{ tabId: 'tab-a' }] } } : null,
    );
    register(controller);
    const close = handlers().get(MAKER_INVOKE.SIDEBAR_TAB_WINDOW_CLOSE_FOR_TAB)!;

    await call(close, { sender: mainSender }, 'tab-a');
    await call(close, { sender: otherSender }, 'tab-a');
    expect(controller.closeForTab).toHaveBeenCalledTimes(2);
    await expect(call(close, { sender: otherSender }, 'tab-b')).rejects.toThrow(
      /PERMISSION_DENIED/,
    );
    await expect(call(close, { sender: { id: 3 } }, 'tab-a')).rejects.toThrow(/PERMISSION_DENIED/);
    expect(controller.closeForTab).toHaveBeenCalledTimes(2);
  });

  it('lets only the main window hand a global tab back from a window', async () => {
    const controller = makeController();
    register(controller);
    const back = handlers().get(MAKER_INVOKE.SIDEBAR_TAB_WINDOW_RETURN_TAB)!;
    await expect(call(back, { sender: otherSender }, 'g_plugin')).rejects.toThrow(
      /PERMISSION_DENIED/,
    );
    expect(controller.returnGlobalTab).not.toHaveBeenCalled();
    await expect(call(back, { sender: mainSender }, '')).rejects.toThrow(/INVALID_PARAMS/);
    await call(back, { sender: mainSender }, 'g_plugin');
    expect(controller.returnGlobalTab).toHaveBeenCalledWith('g_plugin');
  });

  it('accepts merge-back only from the owning tab window and validates the snapshot', async () => {
    const controller = makeController();
    controller.slotForSender.mockImplementation((sender: unknown) =>
      sender === otherSender ? { assignment: { tabs: [{ tabId: 'tab-a' }] } } : null,
    );
    register(controller);
    const merge = handlers().get(SIDEBAR_TAB_WINDOW_MERGE_BACK_CHANNEL)!;

    await call(merge, { sender: mainSender }, { tabId: 'tab-a', snapshot: null });
    // 别人的页签也不行。
    await call(merge, { sender: otherSender }, { tabId: 'tab-b', snapshot: null });
    expect(controller.mergeBack).not.toHaveBeenCalled();
    await expect(
      call(merge, { sender: otherSender }, { tabId: 'tab-a', snapshot: { sessionId: 's1' } }),
    ).rejects.toThrow(/INVALID_PARAMS/);
    await call(
      merge,
      { sender: otherSender },
      {
        tabId: 'tab-a',
        snapshot: {
          sessionId: 's1',
          tab: { id: 'tab-a', kind: 'terminal', state: { created: true } },
        },
      },
    );
    expect(controller.mergeBack).toHaveBeenCalledWith(otherSender, 'tab-a', {
      sessionId: 's1',
      tab: { id: 'tab-a', kind: 'terminal', state: { created: true } },
    });

    // 收编新建页签:只认弹出窗口自身。
    const adopt = handlers().get(SIDEBAR_TAB_WINDOW_ADOPT_TAB_CHANNEL)!;
    await call(adopt, { sender: mainSender }, { tabId: 'tab-n', sessionId: 's1' });
    expect(controller.adoptTab).not.toHaveBeenCalled();
    await call(adopt, { sender: otherSender }, { tabId: 'tab-n', sessionId: null });
    expect(controller.adoptTab).toHaveBeenCalledWith(otherSender, 'tab-n', null, null);
  });
});
