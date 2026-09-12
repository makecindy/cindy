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
let windowReady = true;
const assertTrustedAppRendererEvent = vi.fn();
const overlayIcon = {};
const createWindowsBadgeIcon = vi.fn((count: number) => (count > 0 ? overlayIcon : null));
let badgeDescription = 'Tasks needing attention: {{count}}';
let owner = { dataOwnerId: 'owner-a' as string | null, generation: 1 };
vi.mock('../appSessionState', () => ({ getActiveAppSession: () => owner }));

function publish(
  event: unknown,
  count: unknown,
  sessionIds = ['late-notification'],
  stamp = owner,
) {
  return registeredHandlers.get('notification:set-app-attention-count')!(event, {
    count,
    sessionIds,
    dataOwnerId: stamp.dataOwnerId,
    ownerGeneration: stamp.generation,
  });
}

vi.mock('../windowsBadgeIcon', () => ({ createWindowsBadgeIcon }));
vi.mock('../i18n', () => ({ t: () => badgeDescription }));

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
      windowReady
        ? ({
            isDestroyed: () => false,
            webContents: mainWebContents,
            flashFrame,
            setOverlayIcon,
          } as never)
        : null,
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
  windowReady = true;
  badgeDescription = 'Tasks needing attention: {{count}}';
  owner = { dataOwnerId: 'owner-a', generation: 1 };
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
  it.each([
    [false, 0],
    [false, 1],
    [true, 0],
    [true, 1],
  ] as const)(
    'replays Windows attention on window readiness without a projection after reset=%s count=%s',
    async (reset, count) => {
      windowReady = false;
      const service = await freshService('win32');
      if (reset) service.clearAllSessionAttention();
      if (count) service.markSessionNeedsAttention('early-task');
      expect(service.getAttentionCount()).toBe(count);
      expect(setOverlayIcon).not.toHaveBeenCalled();
      windowReady = true;
      service.refreshWindowsAppBadge();
      expect(setOverlayIcon).toHaveBeenCalledTimes(1);
      expect(setOverlayIcon).toHaveBeenLastCalledWith(
        count ? overlayIcon : null,
        count ? 'Tasks needing attention: 1' : '',
      );
      await publish({ sender: mainWebContents }, count, ['early-task']);
      expect(setOverlayIcon).toHaveBeenCalledTimes(1);
    },
  );

  it('uses the current total without treating a snapshot as an acknowledgement', async () => {
    const service = await freshService();
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

  it('preserves Bot attention outside the catalog and deduplicates IDs entering it', async () => {
    const service = await freshService();
    const event = { sender: mainWebContents };
    await publish(event, 3, ['a', 'b', 'c']);
    service.markSessionNeedsAttention('bot-task');
    service.markSessionNeedsAttention('bot-task');
    expect(service.getAttentionCount()).toBe(4);
    await publish(event, 2, ['a', 'b', 'c']);
    expect(service.getAttentionCount()).toBe(3);
    service.clearSessionAttention('bot-task');
    expect(service.getAttentionCount()).toBe(2);
    service.markSessionNeedsAttention('bot-task');
    await publish(event, 3, ['a', 'b', 'c', 'bot-task']);
    expect(service.getAttentionCount()).toBe(3);
    await publish(event, 0, []);
    expect(service.getAttentionCount()).toBe(0);
    service.clearAllSessionAttention();
    expect(service.getAttentionCount()).toBe(0);
  });

  it('rejects secondary windows, untrusted frames and invalid totals', async () => {
    await freshService();
    await expect(publish({ sender: {} }, 4)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    for (const count of [-1, 1.5, NaN, Infinity, '3', Number.MAX_SAFE_INTEGER + 1]) {
      await expect(publish({ sender: mainWebContents }, count)).rejects.toMatchObject({
        code: 'INVALID_PARAMS',
      });
    }
    const handler = registeredHandlers.get('notification:set-app-attention-count')!;
    for (const snapshot of [
      3,
      { count: 3 },
      { count: 3, sessionIds: [null], dataOwnerId: 'owner-a', ownerGeneration: 1 },
    ]) {
      await expect(handler({ sender: mainWebContents }, snapshot)).rejects.toMatchObject({
        code: 'INVALID_PARAMS',
      });
    }
    assertTrustedAppRendererEvent.mockImplementationOnce(() => {
      throw new Error('untrusted frame');
    });
    await expect(publish({ sender: mainWebContents }, 4)).rejects.toThrow('untrusted frame');
    expect(setBadgeCount).not.toHaveBeenCalled();
  });

  it('rejects oversized snapshots atomically and bounds repeated batches', async () => {
    const service = await freshService();
    const event = { sender: mainWebContents };
    await publish(event, 3, []);
    for (const ids of [Array(10_001).fill('id'), ['x'.repeat(513)]]) {
      await expect(publish(event, 99, ids)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      expect(service.getAttentionCount()).toBe(3);
    }
    const ids = Array.from({ length: 10_000 }, (_, index) => `id-${index}`);
    for (let batch = 0; batch < 10; batch++) {
      await publish(
        event,
        3,
        ids.map((id) => `${batch}-${id}`),
      );
    }
    // 重复 ID 不占额外累计预算；满额后仍可刷新已有目录和总数。
    await publish(event, 4, ['0-id-0', '0-id-0']);
    await expect(publish(event, 99, ['new-id'])).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(service.getAttentionCount()).toBe(4);
    service.markSessionNeedsAttention('new-id');
    expect(service.getAttentionCount()).toBe(5); // 被拒投影没有部分写入目录。
    service.clearAllSessionAttention();
    await publish(event, 1, ['x'.repeat(512)]);
    expect(service.getAttentionCount()).toBe(1);
  });

  it.each(['darwin', 'win32'] as const)(
    'bounds projected totals before mutation on %s',
    async (platform) => {
      const service = await freshService(platform);
      const event = { sender: mainWebContents };
      await publish(event, 10_000);
      setBadgeCount.mockClear();
      setOverlayIcon.mockClear();
      for (const count of [10_001, Number.MAX_SAFE_INTEGER]) {
        await expect(publish(event, count, ['rejected-id'])).rejects.toMatchObject({
          code: 'INVALID_PARAMS',
        });
        expect(service.getAttentionCount()).toBe(10_000);
      }
      expect(setBadgeCount).not.toHaveBeenCalled();
      expect(setOverlayIcon).not.toHaveBeenCalled();
      service.markSessionNeedsAttention('rejected-id');
      expect(service.getAttentionCount()).toBe(10_001); // Rejected snapshots cannot retain catalog IDs.
      await publish(event, 0, []);
      expect(service.getAttentionCount()).toBe(1); // Directory-external attention remains independent.
    },
  );

  it('clears the previous owner total until the new owner publishes its inventory', async () => {
    const service = await freshService();
    await publish({ sender: mainWebContents }, 3);
    service.clearAllSessionAttention();
    expect(service.getAttentionCount()).toBe(0);
    expect(dockSetBadge).toHaveBeenLastCalledWith('');
    expect(onSessionAttentionCleared).not.toHaveBeenCalled();
    const previousOwner = owner;
    owner = { dataOwnerId: null, generation: 2 };
    service.markSessionNeedsAttention('late-signed-out-event');
    await publish({ sender: mainWebContents }, 3, [], previousOwner);
    expect(service.getAttentionCount()).toBe(0);
    owner = { dataOwnerId: 'owner-b', generation: 3 };
    await publish({ sender: mainWebContents }, 3, [], previousOwner);
    expect(service.getAttentionCount()).toBe(0);
    await publish({ sender: mainWebContents }, 1);
    expect(service.getAttentionCount()).toBe(1);
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

  it('refreshes Windows descriptions without changing attention or flashing again', async () => {
    const service = await freshService('win32');
    await publish({ sender: mainWebContents }, 3);
    flashFrame.mockClear();
    badgeDescription = '需要关注的任务：{{count}}';
    service.refreshWindowsAppBadge();
    expect(setOverlayIcon).toHaveBeenLastCalledWith(overlayIcon, '需要关注的任务：3');
    expect(service.getAttentionCount()).toBe(3);
    expect(flashFrame).not.toHaveBeenCalled();
    await publish({ sender: mainWebContents }, 0);
    flashFrame.mockClear();
    service.refreshWindowsAppBadge();
    expect(setOverlayIcon).toHaveBeenLastCalledWith(null, '');
    expect(flashFrame).not.toHaveBeenCalled();
  });

  it('Windows uses the projected total and keeps exact counts in the description', async () => {
    await freshService('win32');
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
