/**
 * 「本机常驻」IPC：归属推进的后台循环（工程规范 §8.2 / §8.3）。
 *
 * 规则依据：list 是读路径，不写台账；归属推进由 main 自己的后台任务驱动，有独立
 * 生命周期与停止条件 —— 面板可见时订阅、不可见或窗口销毁即停，不借用 UI 轮询。
 * 现有覆盖缺口：服务层只测 refresh()，这里测谁在什么时候调用它、通知发给谁。
 * 走真实的 IPC 处理器；服务是替身，时间是假的。单文件本机 5 秒内。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';

const mocks = vi.hoisted(() => ({
  ipcHandle: vi.fn(),
  ipcRemoveHandler: vi.fn(),
  assertTrustedAppRendererEvent: vi.fn(),
  isTrustedAppRendererWindow: vi.fn().mockReturnValue(true),
  fromWebContents: vi.fn().mockReturnValue({}),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.ipcHandle, removeHandler: mocks.ipcRemoveHandler },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
}));

vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: mocks.assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow: mocks.isTrustedAppRendererWindow,
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));

import {
  HOST_DAEMONS_CHANGED_EVENT,
  HOST_DAEMONS_LIST_CHANNEL,
  HOST_DAEMONS_SUBSCRIBE_CHANNEL,
  HOST_DAEMONS_UNSUBSCRIBE_CHANNEL,
  type HostDaemonsRefreshResult,
  type HostDaemonsSnapshot,
} from '../../../shared/hostDaemons.js';
import { _resetHostDaemonsIpcForTests, registerHostDaemonsIpc } from '../ipc.js';
import type { HostDaemonsService } from '../service.js';

const EMPTY: HostDaemonsSnapshot = {
  capturedAtMs: 1,
  entries: [],
  unrelatedCount: 0,
  pendingCount: 0,
  incomplete: false,
  supported: true,
};

function handlerFor(channel: string) {
  const call = mocks.ipcHandle.mock.calls.find(([ch]) => ch === channel);
  expect(call, `handler for ${channel}`).toBeDefined();
  return call![1] as (...args: unknown[]) => unknown;
}

function fakeSender() {
  let destroyed = false;
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    send: vi.fn(),
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
      emitter.emit('destroyed');
    },
  });
}

const pending: HostDaemonsRefreshResult = { pendingCount: 1, retryAfterMs: 1_500 };
const settled: HostDaemonsRefreshResult = { pendingCount: 0, retryAfterMs: null };

function register(
  refresh: () => Promise<HostDaemonsRefreshResult>,
  overrides: { allowsRefresh?: (sender: WebContents) => boolean; list?: () => Promise<HostDaemonsSnapshot> } = {},
) {
  const service = {
    list: overrides.list ?? (async () => EMPTY),
    refresh,
    stop: async () => {},
    run: async () => {},
    remove: async () => {},
  } as unknown as HostDaemonsService;
  registerHostDaemonsIpc({ getService: () => service, refresh, allowsRefresh: overrides.allowsRefresh });
}

/** 让已排队的 promise 回调跑完。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  _resetHostDaemonsIpcForTests();
  mocks.ipcHandle.mockClear();
  mocks.isTrustedAppRendererWindow.mockReset().mockReturnValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('host daemons IPC：归属推进的后台循环', () => {
  it('订阅先推进一轮再返回，之后按服务给的间隔续排，退订即停', async () => {
    const refresh = vi.fn(async () => pending);
    const sender = fakeSender();
    register(refresh);

    await handlerFor(HOST_DAEMONS_SUBSCRIBE_CHANNEL)({ sender });
    // list 只读：首屏清单要等到这一轮的归属结果，所以订阅返回前先推进一轮。
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledExactlyOnceWith(HOST_DAEMONS_CHANGED_EVENT);

    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(sender.send).toHaveBeenCalledTimes(3);

    handlerFor(HOST_DAEMONS_UNSUBSCRIBE_CHANNEL)({ sender });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(sender.send).toHaveBeenCalledTimes(3);
  });

  it('没有待核对的条目就不再续排', async () => {
    const refresh = vi.fn(async () => settled);
    const sender = fakeSender();
    register(refresh);

    await handlerFor(HOST_DAEMONS_SUBSCRIBE_CHANNEL)({ sender });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('上一轮没做完时不叠加；做完后，途中新来的订阅者也收到结束通知', async () => {
    let release = () => {};
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }).then(() => pending),
    );
    const first = fakeSender();
    const late = fakeSender();
    register(refresh);

    const inflight = handlerFor(HOST_DAEMONS_SUBSCRIBE_CHANNEL)({ sender: first });
    await flush();
    await handlerFor(HOST_DAEMONS_SUBSCRIBE_CHANNEL)({ sender: late });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(late.send).not.toHaveBeenCalled();

    release();
    await inflight;
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(late.send).toHaveBeenCalledTimes(1);
  });

  it('推进途中全部退订就不再续排', async () => {
    let release = () => {};
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }).then(() => pending),
    );
    const sender = fakeSender();
    register(refresh);

    const inflight = handlerFor(HOST_DAEMONS_SUBSCRIBE_CHANNEL)({ sender });
    await flush();
    handlerFor(HOST_DAEMONS_UNSUBSCRIBE_CHANNEL)({ sender });
    release();
    await inflight;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('推进失败不推变化通知，稍后重试', async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error('database is busy')).mockResolvedValue(settled);
    const sender = fakeSender();
    register(refresh);

    await handlerFor(HOST_DAEMONS_SUBSCRIBE_CHANNEL)({ sender });
    expect(sender.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it('预热窗口不推进、不收通知，转正后照常', async () => {
    let live = false;
    const refresh = vi.fn(async () => pending);
    const sender = fakeSender();
    register(refresh, { allowsRefresh: () => live });
    const subscribe = handlerFor(HOST_DAEMONS_SUBSCRIBE_CHANNEL);

    await subscribe({ sender });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();

    // 窗口转正：渲染侧可见性翻转后重新订阅，从这里起照常推进。
    live = true;
    await subscribe({ sender });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it('窗口销毁后不再推进', async () => {
    const refresh = vi.fn(async () => pending);
    const sender = fakeSender();
    register(refresh);

    await handlerFor(HOST_DAEMONS_SUBSCRIBE_CHANNEL)({ sender });
    sender.destroy();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it('窗口导航离开 Cindy 页面后不再推送清单', async () => {
    const refresh = vi.fn(async () => pending);
    const sender = fakeSender();
    register(refresh);

    await handlerFor(HOST_DAEMONS_SUBSCRIBE_CHANNEL)({ sender });
    mocks.isTrustedAppRendererWindow.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it('list 处理器只读清单，不触发推进', async () => {
    const list = vi.fn(async () => EMPTY);
    const refresh = vi.fn(async () => pending);
    register(refresh, { list });

    expect(await handlerFor(HOST_DAEMONS_LIST_CHANNEL)({ sender: fakeSender() })).toBe(EMPTY);
    expect(refresh).not.toHaveBeenCalled();
  });
});
