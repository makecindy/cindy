/**
 * 「本机常驻」IPC：更新循环（工程规范 §8.2 / §8.3 / §8.6）。
 *
 * 规则依据：清单只有一个来源 —— 一轮更新。归属推进与写台账只在 main 自己的后台任务里
 * 发生，有独立生命周期与停止条件：面板可见时订阅、不可见或窗口销毁即停；循环停下后
 * 用户点刷新能重新拉起一轮。renderer 没有单独的「读清单」接口。
 * 现有覆盖缺口：服务层只测 refresh() 本身，这里测谁在什么时候调用它、清单发给谁。
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
  HOST_DAEMONS_REFRESH_CHANNEL,
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

/** 回执说还有下一轮（1.5 秒后再推进）。 */
const again: HostDaemonsRefreshResult = { snapshot: EMPTY, retryAfterMs: 1_500 };
/** 回执说没有下一轮。 */
const settled: HostDaemonsRefreshResult = { snapshot: EMPTY, retryAfterMs: null };

function register(
  refresh: () => Promise<HostDaemonsRefreshResult>,
  overrides: { allowsRefresh?: (sender: WebContents) => boolean } = {},
) {
  const service = {
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

/** 一轮做不完的 refresh：由测试决定何时放行，回执里带上是第几轮。 */
function gatedRounds(result: (round: number) => HostDaemonsRefreshResult) {
  let release = () => {};
  let round = 0;
  const refresh = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => result(++round)),
  );
  return { refresh, release: () => release() };
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

describe('host daemons IPC：更新循环', () => {
  it('订阅先做一轮再返回，之后按回执给的间隔续排，退订即停', async () => {
    const refresh = vi.fn(async () => again);
    const sender = fakeSender();
    register(refresh);

    await handlerFor(HOST_DAEMONS_SUBSCRIBE_CHANNEL)({ sender });
    // 订阅的回执就是这一轮的清单；订阅者同时收到一次推送。
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledExactlyOnceWith(HOST_DAEMONS_CHANGED_EVENT, {
      ok: true,
      snapshot: EMPTY,
    });

    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(sender.send).toHaveBeenCalledTimes(3);

    handlerFor(HOST_DAEMONS_UNSUBSCRIBE_CHANNEL)({ sender });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(sender.send).toHaveBeenCalledTimes(3);
  });

  it('没有待核对的条目、来源也都读全就不再续排', async () => {
    const refresh = vi.fn(async () => settled);
    const sender = fakeSender();
    register(refresh);

    await handlerFor(HOST_DAEMONS_SUBSCRIBE_CHANNEL)({ sender });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('上一轮没做完时不叠加；做完后，途中新来的订阅者也收到这一轮的清单', async () => {
    const { refresh, release } = gatedRounds(() => again);
    const first = fakeSender();
    const late = fakeSender();
    register(refresh);

    const inflight = handlerFor(HOST_DAEMONS_SUBSCRIBE_CHANNEL)({ sender: first });
    await flush();
    const lateSubscribe = handlerFor(HOST_DAEMONS_SUBSCRIBE_CHANNEL)({ sender: late });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(late.send).not.toHaveBeenCalled();

    release();
    await inflight;
    await lateSubscribe;
    expect(first.send).toHaveBeenCalledTimes(1);
    expect(late.send).toHaveBeenCalledTimes(1);
  });

  it('推进途中全部退订就不再续排', async () => {
    const { refresh, release } = gatedRounds(() => again);
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

  it('推进失败时回执说明失败；不向订阅者推送，稍后重试', async () => {
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('database is busy'))
      .mockResolvedValue(settled);
    const sender = fakeSender();
    register(refresh);

    expect(await handlerFor(HOST_DAEMONS_SUBSCRIBE_CHANNEL)({ sender })).toMatchObject({
      ok: false,
      reason: 'internal',
    });
    expect(sender.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it('手动刷新：面板在订阅着、循环已经停下（没有待核对的条目）时也能重新拉起一轮，回执就是这一轮的清单', async () => {
    const refresh = vi.fn(async () => settled);
    const sender = fakeSender();
    register(refresh);

    // 还没有订阅者：没人等这份清单，不扫描、不读历史。
    expect(await handlerFor(HOST_DAEMONS_REFRESH_CHANNEL)({ sender })).toMatchObject({
      ok: false,
      reason: 'no-listener',
    });
    expect(refresh).not.toHaveBeenCalled();

    // 订阅着的一轮说没有下一轮：循环停下。用户点刷新仍然能重新拉起一轮，
    // 拉起的那一轮若说还有下一轮，循环自己接着推进。
    await handlerFor(HOST_DAEMONS_SUBSCRIBE_CHANNEL)({ sender });
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    refresh.mockResolvedValue(again);
    expect(await handlerFor(HOST_DAEMONS_REFRESH_CHANNEL)({ sender })).toEqual({
      ok: true,
      snapshot: EMPTY,
    });
    expect(refresh).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('面板退订之后手动刷新不再扫描本机、不读历史', async () => {
    const refresh = vi.fn(async () => settled);
    const sender = fakeSender();
    register(refresh);
    await handlerFor(HOST_DAEMONS_SUBSCRIBE_CHANNEL)({ sender });
    expect(refresh).toHaveBeenCalledTimes(1);
    await handlerFor(HOST_DAEMONS_UNSUBSCRIBE_CHANNEL)({ sender });

    // 组件已经卸载并退订：不再发起新的读取（工程规范 §8.2 / §8.3）。
    expect(await handlerFor(HOST_DAEMONS_REFRESH_CHANNEL)({ sender })).toMatchObject({
      ok: false,
      reason: 'no-listener',
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('手动刷新这一轮发现还有待核对时，循环自己接着推进，不等界面再来请求', async () => {
    // 循环已停（上一轮回执说没有下一轮）。用户手动刷新时恰好有新的常驻项在核对：
    // 这一轮之后必须续排，否则它停在「核对中」，直到用户再点一次刷新。
    const refresh = vi.fn().mockResolvedValueOnce(settled).mockResolvedValue(again);
    const sender = fakeSender();
    register(refresh);
    await handlerFor(HOST_DAEMONS_SUBSCRIBE_CHANNEL)({ sender });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    expect(await handlerFor(HOST_DAEMONS_REFRESH_CHANNEL)({ sender })).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it('手动刷新撞上在途的一轮：等它做完再补一轮，回执反映请求之后的情况', async () => {
    const { refresh, release } = gatedRounds(
      (round) => ({ ...settled, snapshot: { ...EMPTY, capturedAtMs: round } }) as HostDaemonsRefreshResult,
    );
    const sender = fakeSender();
    register(refresh);

    const inflight = handlerFor(HOST_DAEMONS_SUBSCRIBE_CHANNEL)({ sender });
    await flush();
    const manual = handlerFor(HOST_DAEMONS_REFRESH_CHANNEL)({ sender });
    expect(refresh).toHaveBeenCalledTimes(1);

    release();
    await inflight;
    // 手动刷新接在后面发起第二轮：放行它，回执反映的是请求之后的情况。
    await flush();
    release();
    expect(await manual).toMatchObject({ ok: true, snapshot: { capturedAtMs: 2 } });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(sender.send).toHaveBeenCalledTimes(2);
  });

  it('预热窗口不能请求推进：回执说明原因，也不做这一轮', async () => {
    const refresh = vi.fn(async () => settled);
    register(refresh, { allowsRefresh: () => false });

    expect(await handlerFor(HOST_DAEMONS_REFRESH_CHANNEL)({ sender: fakeSender() })).toMatchObject({
      ok: false,
      reason: 'warming',
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('预热窗口订阅后不推进、不收清单；窗口转正后照常', async () => {
    let live = false;
    const refresh = vi.fn(async () => again);
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
    const refresh = vi.fn(async () => again);
    const sender = fakeSender();
    register(refresh);

    await handlerFor(HOST_DAEMONS_SUBSCRIBE_CHANNEL)({ sender });
    sender.destroy();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it('窗口导航离开 Cindy 页面后不再推送清单', async () => {
    const refresh = vi.fn(async () => again);
    const sender = fakeSender();
    register(refresh);

    await handlerFor(HOST_DAEMONS_SUBSCRIBE_CHANNEL)({ sender });
    mocks.isTrustedAppRendererWindow.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(sender.send).toHaveBeenCalledTimes(1);
  });
});
