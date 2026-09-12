import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type IpcHandler = (event: unknown, sessionId: unknown, intent?: unknown) => Promise<void> | void;

const registeredHandlers = new Map<string, IpcHandler>();
const setBadgeCount = vi.fn();
const dockSetBadge = vi.fn();
const flashFrame = vi.fn();
const setOverlayIcon = vi.fn();
const warn = vi.fn();
const onSessionAttentionMarked = vi.fn();
const onSessionAttentionCleared = vi.fn();
const webContentsSend = vi.fn();
const originalPlatform = process.platform;
const mainWebContents = {};
const assertTrustedAppRendererEvent = vi.fn();
const overlayIcon = {};
const createWindowsBadgeIcon = vi.fn((count: number) => (count > 0 ? overlayIcon : null));

vi.mock('../windowsBadgeIcon', () => ({ createWindowsBadgeIcon }));
vi.mock('../i18n', () => ({ t: () => 'Tasks needing attention: {{count}}' }));

vi.mock('../security/trustedAppRenderer', () => ({ assertTrustedAppRendererEvent }));

vi.mock('electron', () => ({
  app: {
    setBadgeCount,
    dock: { setBadge: dockSetBadge },
  },
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => {
      registeredHandlers.set(channel, handler);
    },
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: { send: webContentsSend },
      },
    ],
  },
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ warn }),
}));

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

async function freshService(platform: NodeJS.Platform = 'darwin') {
  vi.resetModules();
  registeredHandlers.clear();
  setPlatform(platform);
  const service = await import('../appBadgeService');
  service.initAppBadgeService({
    getWindow: () =>
      ({
        isDestroyed: () => false,
        webContents: mainWebContents,
        flashFrame,
        setOverlayIcon,
      }) as never,
    onSessionAttentionMarked,
    onSessionAttentionCleared,
  });
  setBadgeCount.mockClear();
  dockSetBadge.mockClear();
  flashFrame.mockClear();
  setOverlayIcon.mockClear();
  onSessionAttentionMarked.mockClear();
  onSessionAttentionCleared.mockClear();
  return service;
}

beforeEach(() => {
  createWindowsBadgeIcon.mockClear();
  assertTrustedAppRendererEvent.mockReset();
  setBadgeCount.mockClear();
  dockSetBadge.mockClear();
  flashFrame.mockClear();
  setOverlayIcon.mockClear();
  warn.mockClear();
  onSessionAttentionMarked.mockClear();
  onSessionAttentionCleared.mockClear();
  webContentsSend.mockClear();
});

afterEach(() => {
  setPlatform(originalPlatform);
});

describe('appBadgeService', () => {
  it('uses the current total without treating a snapshot as an acknowledgement', async () => {
    const service = await freshService();
    const publish = registeredHandlers.get('notification:set-app-attention-count')!;
    const event = { sender: mainWebContents };
    await publish(event, 3);
    expect(service.getAttentionCount()).toBe(3);
    expect(dockSetBadge).toHaveBeenLastCalledWith('3');
    expect(onSessionAttentionMarked).not.toHaveBeenCalled();
    expect(onSessionAttentionCleared).not.toHaveBeenCalled();
    expect(webContentsSend).not.toHaveBeenCalled();

    // 单次通知/回执不能覆盖总数；等待实际任务状态的新投影。
    service.markSessionNeedsAttention('late-notification');
    service.clearSessionAttention('late-notification');
    expect(service.getAttentionCount()).toBe(3);
    await publish(event, 2);
    expect(dockSetBadge).toHaveBeenLastCalledWith('2');
    await publish(event, 0);
    expect(dockSetBadge).toHaveBeenLastCalledWith('');
  });

  it('rejects secondary windows, untrusted frames and invalid totals', async () => {
    await freshService();
    const publish = registeredHandlers.get('notification:set-app-attention-count')!;
    await expect(publish({ sender: {} }, 4)).rejects.toThrow('main window');
    for (const count of [-1, 1.5, NaN, Infinity, '3', Number.MAX_SAFE_INTEGER + 1]) {
      await expect(publish({ sender: mainWebContents }, count)).rejects.toThrow('safe integer');
    }
    assertTrustedAppRendererEvent.mockImplementationOnce(() => {
      throw new Error('untrusted frame');
    });
    await expect(publish({ sender: mainWebContents }, 4)).rejects.toThrow('untrusted frame');
    expect(setBadgeCount).not.toHaveBeenCalled();
  });

  it('clears a projected total on shutdown even without event-based attention', async () => {
    const service = await freshService();
    await registeredHandlers.get('notification:set-app-attention-count')!(
      { sender: mainWebContents },
      3,
    );
    service.clearAllSessionAttention();
    expect(service.getAttentionCount()).toBe(0);
    expect(dockSetBadge).toHaveBeenLastCalledWith('');
    expect(onSessionAttentionCleared).not.toHaveBeenCalled();
  });

  it('macOS uses numeric Dock badge count and deduplicates sessions', async () => {
    const service = await freshService('darwin');

    service.markSessionNeedsAttention('s1');
    service.markSessionNeedsAttention('s1');
    service.markSessionNeedsAttention('s2');

    expect(service.getAttentionCount()).toBe(2);
    expect(service.hasSessionAttention('s1')).toBe(true);
    expect(service.hasSessionAttention('missing')).toBe(false);
    expect(setBadgeCount).toHaveBeenLastCalledWith(2);
    expect(dockSetBadge).toHaveBeenLastCalledWith('2');
    expect(onSessionAttentionMarked).toHaveBeenCalledTimes(2);
    expect(onSessionAttentionMarked).toHaveBeenNthCalledWith(1, 's1');
    expect(onSessionAttentionMarked).toHaveBeenNthCalledWith(2, 's2');
  });

  it('clears macOS badge when all sessions are read', async () => {
    const service = await freshService('darwin');

    service.markSessionNeedsAttention('s1');
    service.clearSessionAttention('s1');

    expect(service.getAttentionCount()).toBe(0);
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);
    expect(dockSetBadge).toHaveBeenLastCalledWith('');
  });

  it('clears app-level badges on shutdown without acknowledging tasks', async () => {
    const service = await freshService('darwin');
    service.markSessionNeedsAttention('s1');
    service.markSessionNeedsAttention('s2');

    service.clearAllSessionAttention();

    expect(service.getAttentionCount()).toBe(0);
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);
    expect(dockSetBadge).toHaveBeenLastCalledWith('');
    expect(onSessionAttentionCleared).not.toHaveBeenCalled();
  });

  it('still reports an explicit session read after app-level badges were reset', async () => {
    const service = await freshService('darwin');
    service.markSessionNeedsAttention('s1');
    service.clearAllSessionAttention();
    onSessionAttentionCleared.mockClear();

    service.clearSessionAttention('s1');

    expect(service.getAttentionCount()).toBe(0);
    expect(onSessionAttentionCleared).toHaveBeenCalledTimes(1);
    // 未声明 intent 的清除按 passive 桥接(fail-safe):被动信号不允许吞未读报错。
    expect(onSessionAttentionCleared).toHaveBeenCalledWith('s1', 'passive');
  });

  it('Windows flashes taskbar while sessions need attention and stops after clear', async () => {
    const service = await freshService('win32');

    service.markSessionNeedsAttention('s1');
    service.clearSessionAttention('s1');

    expect(flashFrame).toHaveBeenNthCalledWith(1, true);
    expect(setOverlayIcon).toHaveBeenNthCalledWith(1, overlayIcon, 'Tasks needing attention: 1');
    expect(flashFrame).toHaveBeenLastCalledWith(false);
    expect(setOverlayIcon).toHaveBeenLastCalledWith(null, '');
  });

  it('Windows uses the projected total and keeps exact counts in the description', async () => {
    await freshService('win32');
    const publish = registeredHandlers.get('notification:set-app-attention-count')!;
    await publish({ sender: mainWebContents }, 123);
    expect(createWindowsBadgeIcon).toHaveBeenLastCalledWith(123);
    expect(setOverlayIcon).toHaveBeenLastCalledWith(overlayIcon, 'Tasks needing attention: 123');
    await publish({ sender: mainWebContents }, 0);
    expect(setOverlayIcon).toHaveBeenLastCalledWith(null, '');
  });

  it('clear IPC removes a session attention badge', async () => {
    const service = await freshService('darwin');
    service.markSessionNeedsAttention('s1');

    await registeredHandlers.get('notification:clear-session-attention')?.({}, 's1');

    expect(service.getAttentionCount()).toBe(0);
    expect(setBadgeCount).toHaveBeenLastCalledWith(0);
    expect(onSessionAttentionCleared).toHaveBeenCalledWith('s1', 'passive');
  });

  it('clear IPC reports explicit read acknowledgement even when the app badge is already clear', async () => {
    const service = await freshService('darwin');

    await registeredHandlers.get('notification:clear-session-attention')?.({}, 's1');

    expect(service.getAttentionCount()).toBe(0);
    expect(setBadgeCount).not.toHaveBeenCalled();
    expect(onSessionAttentionCleared).toHaveBeenCalledWith('s1', 'passive');
  });

  it('clear IPC forwards an explicit intent to the attention bridge', async () => {
    const service = await freshService('darwin');
    service.markSessionNeedsAttention('s1');

    await registeredHandlers.get('notification:clear-session-attention')?.({}, 's1', 'explicit');

    expect(service.getAttentionCount()).toBe(0);
    expect(onSessionAttentionCleared).toHaveBeenCalledWith('s1', 'explicit');
  });

  it('broadcasts session-attention-cleared to windows on every clear (remote-originated included)', async () => {
    const service = await freshService('darwin');
    service.markSessionNeedsAttention('s1');
    webContentsSend.mockClear();

    // 远程控制端经 device-link dispatch 打进同一个 clear handler:本机 renderer 的
    // sessionAttentionStore 靠这条广播同步清侧栏红绿点。
    await registeredHandlers.get('notification:clear-session-attention')?.({}, 's1', 'explicit');

    expect(webContentsSend).toHaveBeenCalledWith(service.SESSION_ATTENTION_CLEARED_CHANNEL, {
      sessionId: 's1',
      intent: 'explicit',
    });
  });

  it('broadcasts even when the badge set has no entry (island may still hold unread)', async () => {
    const service = await freshService('darwin');
    webContentsSend.mockClear();

    service.clearSessionAttention('s1');

    expect(webContentsSend).toHaveBeenCalledWith(service.SESSION_ATTENTION_CLEARED_CHANNEL, {
      sessionId: 's1',
      intent: 'passive',
    });
  });

  it('mark IPC adds a session attention badge', async () => {
    const service = await freshService('darwin');

    await registeredHandlers.get('notification:mark-session-attention')?.({}, 's1');

    expect(service.getAttentionCount()).toBe(1);
    expect(setBadgeCount).toHaveBeenLastCalledWith(1);
    expect(dockSetBadge).toHaveBeenLastCalledWith('1');
  });
});
