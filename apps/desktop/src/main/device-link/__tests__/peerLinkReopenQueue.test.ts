/**
 * peerLinkReopenQueue.test.ts —— before-link 重开队列的行为锁。
 *
 * 这条队列是「对端仍按可靠流发帧但本端 link 未就绪」的自愈出口(#1418 与 #1449
 * 曾各自实现一条,已收敛为一条)。锁三件事:
 *   1. 授权判据:方向(出站订阅)+ 本地控制开关。反向建链与必然失败的空转都要挡住。
 *   2. per-peer 隔离:一个 peer 的 reopen 反复失败,不得影响其它 peer(不重复重开、
 *      不牵连其在途请求 —— 队列只对失败的那个 peer 重排)。
 *   3. 生命周期:成功出队、失败按固定间隔重排、cancel/dispose 立即停。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createPeerLinkReopenQueue,
  shouldEnqueuePeerLinkReopen,
} from '../peerLinkReopenQueue';

type Timer = ReturnType<typeof setTimeout>;

/** 可控计时器:记录排期,手动 fire,便于断言「只为失败的 peer 重排」。 */
function fakeTimers() {
  const scheduled: Array<{ id: number; fn: () => void; ms: number }> = [];
  let nextId = 1;
  return {
    scheduled,
    setTimer: ((fn: () => void, ms: number) => {
      const id = nextId++;
      scheduled.push({ id, fn, ms });
      return id as unknown as Timer;
    }) as (fn: () => void, ms: number) => Timer,
    clearTimer: ((timer: Timer) => {
      const idx = scheduled.findIndex((s) => s.id === (timer as unknown as number));
      if (idx >= 0) scheduled.splice(idx, 1);
    }) as (timer: Timer) => void,
    /** 触发全部已排期回调(模拟到点)。 */
    async fireAll(): Promise<void> {
      const due = scheduled.splice(0, scheduled.length);
      for (const s of due) s.fn();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function harness(over?: {
  reopen?: (deviceId: string) => Promise<unknown>;
  canEnqueue?: (deviceId: string) => boolean;
  canRun?: () => boolean;
}) {
  const timers = fakeTimers();
  const reopen = vi.fn(over?.reopen ?? (async () => undefined));
  const queue = createPeerLinkReopenQueue({
    reopen,
    canEnqueue: over?.canEnqueue ?? (() => true),
    canRun: over?.canRun ?? (() => true),
    retryMs: 5_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { queue, reopen, timers };
}

/** 等待队列内部 promise 链落定。 */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('shouldEnqueuePeerLinkReopen —— 授权判据', () => {
  it('持有出站订阅且本地未关闭控制才入队', () => {
    expect(shouldEnqueuePeerLinkReopen({
      hasOutboundSubscriptions: true,
      controlDisabledLocally: false,
    })).toBe(true);
  });

  it('无出站订阅(纯被控端方向)不入队 —— 入站帧不得触发反向建链', () => {
    expect(shouldEnqueuePeerLinkReopen({
      hasOutboundSubscriptions: false,
      controlDisabledLocally: false,
    })).toBe(false);
  });

  it('本机已关闭对该设备的控制不入队 —— 避免在必然失败的 reopen 上空转', () => {
    expect(shouldEnqueuePeerLinkReopen({
      hasOutboundSubscriptions: true,
      controlDisabledLocally: true,
    })).toBe(false);
  });
});

describe('createPeerLinkReopenQueue', () => {
  it('trigger 立即重开一次;成功即出队,不再重排', async () => {
    const h = harness();
    h.queue.trigger('dev-a');
    expect(h.reopen).toHaveBeenCalledExactlyOnceWith('dev-a');
    await settle();
    expect(h.queue.isPending('dev-a')).toBe(false);
    expect(h.timers.scheduled).toHaveLength(0);
  });

  it('门禁不通过时不重开、不入队', () => {
    const h = harness({ canEnqueue: () => false });
    h.queue.trigger('dev-a');
    expect(h.reopen).not.toHaveBeenCalled();
    expect(h.queue.pendingCount()).toBe(0);
  });

  it('reopen 失败 → 留在队列并按固定间隔重排,成功后出队', async () => {
    let attempt = 0;
    const h = harness({
      reopen: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('peer busy');
        return undefined;
      },
    });
    h.queue.trigger('dev-a');
    await settle();
    expect(h.queue.isPending('dev-a')).toBe(true);
    expect(h.timers.scheduled).toHaveLength(1);
    expect(h.timers.scheduled[0]!.ms).toBe(5_000);

    await h.timers.fireAll();
    await settle();
    expect(h.reopen).toHaveBeenCalledTimes(2);
    expect(h.queue.isPending('dev-a')).toBe(false);
    expect(h.timers.scheduled).toHaveLength(0);
  });

  it('per-peer 隔离:一个 peer 持续失败,不牵连成功的邻居 —— 邻居只重开一次且不在重排里', async () => {
    const h = harness({
      reopen: async (deviceId) => {
        if (deviceId === 'dev-bad') throw new Error('always fails');
        return undefined;
      },
    });
    h.queue.trigger('dev-good');
    h.queue.trigger('dev-bad');
    await settle();
    // 邻居成功出队,坏 peer 留队重排
    expect(h.queue.isPending('dev-good')).toBe(false);
    expect(h.queue.isPending('dev-bad')).toBe(true);
    const goodCalls = () => h.reopen.mock.calls.filter(([id]) => id === 'dev-good').length;
    expect(goodCalls()).toBe(1);

    // 连续多轮重排:只重试坏 peer,邻居不被重复重开(其 link 与在途请求零感知)
    for (let round = 0; round < 3; round++) {
      await h.timers.fireAll();
      await settle();
    }
    expect(goodCalls()).toBe(1);
    expect(h.reopen.mock.calls.filter(([id]) => id === 'dev-bad').length).toBeGreaterThan(1);
    h.queue.dispose();
  });

  it('canRun=false(待命 / teardown):跳过执行但保留 pending,恢复后继续', async () => {
    let running = true;
    const h = harness({
      reopen: async () => {
        throw new Error('fail once');
      },
      canRun: () => running,
    });
    h.queue.trigger('dev-a');
    await settle();
    expect(h.queue.isPending('dev-a')).toBe(true);
    const callsBefore = h.reopen.mock.calls.length;

    // 失去持有权:排期到点也不执行,pending 不丢
    running = false;
    await h.timers.fireAll();
    await settle();
    expect(h.reopen.mock.calls.length).toBe(callsBefore);
    expect(h.queue.isPending('dev-a')).toBe(true);

    // 恢复持有权后新触发继续推进
    running = true;
    h.queue.trigger('dev-a');
    expect(h.reopen.mock.calls.length).toBeGreaterThan(callsBefore);
    h.queue.dispose();
  });

  it('canRun=false 时 trigger 不入队(teardown 后迟到的帧不复活队列)', () => {
    const h = harness({ canRun: () => false });
    h.queue.trigger('dev-a');
    expect(h.reopen).not.toHaveBeenCalled();
    expect(h.queue.pendingCount()).toBe(0);
  });

  it('retryPending:ownership 接管后补发一次,只推进已排队项、不新增设备', async () => {
    let running = false;
    const h = harness({ canRun: () => running });
    // 待命期间的触发不入队(canRun=false)——接管补发不该无端建链
    h.queue.trigger('dev-a');
    expect(h.queue.pendingCount()).toBe(0);
    running = true;
    h.queue.retryPending();
    expect(h.reopen).not.toHaveBeenCalled();

    // 已排队项才会被补发推进
    h.queue.trigger('dev-b');
    await settle();
    expect(h.reopen).toHaveBeenCalledExactlyOnceWith('dev-b');
    h.queue.dispose();
  });

  it('cancel / dispose 立即出队并清掉重排', async () => {
    const h = harness({ reopen: async () => { throw new Error('fail'); } });
    h.queue.trigger('dev-a');
    h.queue.trigger('dev-b');
    await settle();
    expect(h.queue.pendingCount()).toBe(2);

    h.queue.cancel('dev-a');
    expect(h.queue.isPending('dev-a')).toBe(false);
    expect(h.queue.isPending('dev-b')).toBe(true);

    h.queue.dispose();
    expect(h.queue.pendingCount()).toBe(0);
    expect(h.timers.scheduled).toHaveLength(0);
  });
});
