/**
 * scheduleReadiness — main 端 scheduler readiness holder 的状态机测试。
 *
 * Cover 的关键设计点(spec 评审里 worker 反复强调,绝对不能破坏的边界):
 *
 *   1. Cold-start: handler 在 setSchedulerReady 之前 awaitReady → pending
 *      → setSchedulerReady 一调,所有在途 await 立刻 resolve 同一实例。
 *   2. **Relogin / 切账号:resetSchedulerReady 清 _current 但不清 _pending,
 *      下一次 setSchedulerReady(新实例) 会让在途 await resolve 新实例**
 *      —— 这是把"模块级单 promise 锁死旧实例"bug 拒之门外的核心保证。
 *   3. Timeout: 30s 内 setSchedulerReady 不到 → awaitReadyWithTimeout reject。
 *   4. clearTimeout: setSchedulerReady 先到时 timer 必须被清,否则高频 IPC 下
 *      会泄露 N 个 timer。用 vi.useFakeTimers() 推时间确认 timer 没残留。
 *
 * 测试不模拟 electron ipcMain — 直接 import 模块 export 的 holder API。
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const webContentsSend = vi.fn();
  return {
    webContentsSend,
    getAllWindows: vi.fn(() => [
      { isDestroyed: () => false, webContents: { send: webContentsSend } },
    ]),
    tapWindowBroadcast: vi.fn(),
    handleScheduleEvent: vi.fn(),
  };
});

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: h.getAllWindows },
  // 停用轴接线让本测试的 import 链带上 model-disable-store / auth-adapters →
  // runtime-configs:模块加载期会读 app.getPath('userData')(userDataPath 字段)。
  // ripgrep 探测已惰性化(issue #1956),import 不再需要 getAppPath / isPackaged。
  app: {
    getPath: vi.fn(() => '/tmp/cindy-test-user-data'),
  },
}));

vi.mock('../../device-link/broadcast-tap.js', () => ({
  getSafeDataOwnerPushStamp: vi.fn(() => undefined),
  tapWindowBroadcast: h.tapWindowBroadcast,
}));

vi.mock('../../agent-island/service.js', () => ({
  getAgentIslandService: () => ({ handleScheduleEvent: h.handleScheduleEvent }),
}));

import {
  setSchedulerReady,
  resetSchedulerReady,
  awaitReadyWithTimeout,
  attachSchedulerEventListeners,
  __resetReadinessForTest,
} from '../schedule';

// Minimal stand-ins — holder 只持有引用并 resolve 出去,不调任何方法。
const scheduler1 = { id: 'scheduler-1' } as never;
const storage1 = { id: 'storage-1' } as never;
const scheduler2 = { id: 'scheduler-2' } as never;
const storage2 = { id: 'storage-2' } as never;

beforeEach(() => {
  __resetReadinessForTest();
  h.webContentsSend.mockClear();
  h.getAllWindows.mockClear();
  h.tapWindowBroadcast.mockClear();
  h.handleScheduleEvent.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduler readiness holder', () => {
  it('cold-start: setSchedulerReady drains in-flight awaits with that instance', async () => {
    const p1 = awaitReadyWithTimeout();
    const p2 = awaitReadyWithTimeout();

    // 还未 setReady,两个 await 应该都 pending
    let resolved1 = false;
    let resolved2 = false;
    void p1.then(() => { resolved1 = true; });
    void p2.then(() => { resolved2 = true; });
    await Promise.resolve();
    expect(resolved1).toBe(false);
    expect(resolved2).toBe(false);

    setSchedulerReady(scheduler1, storage1);

    const r1 = await p1;
    const r2 = await p2;
    expect(r1.scheduler).toBe(scheduler1);
    expect(r1.storage).toBe(storage1);
    expect(r2.scheduler).toBe(scheduler1);
    expect(r2.storage).toBe(storage1);
  });

  it('post-ready: subsequent awaits resolve immediately with current instance', async () => {
    setSchedulerReady(scheduler1, storage1);

    const r = await awaitReadyWithTimeout();
    expect(r.scheduler).toBe(scheduler1);
    expect(r.storage).toBe(storage1);
  });

  it('relogin: reset clears current but next setReady(new) resolves pending with NEW instance', async () => {
    // 先 ready,模拟 user A 已登录
    setSchedulerReady(scheduler1, storage1);
    const r0 = await awaitReadyWithTimeout();
    expect(r0.scheduler).toBe(scheduler1);

    // user logout → resetSchedulerReady
    resetSchedulerReady();

    // 在 relogin 的间隙,某个 IPC 触发了 awaitReady — 应该 pending,**绝对不能**
    // 命中已 stopped 的 scheduler1
    const pPending = awaitReadyWithTimeout();
    let resolvedEarly = false;
    void pPending.then(() => { resolvedEarly = true; });
    await Promise.resolve();
    expect(resolvedEarly).toBe(false);

    // user B login → setSchedulerReady(新实例)
    setSchedulerReady(scheduler2, storage2);

    const r = await pPending;
    expect(r.scheduler).toBe(scheduler2);
    expect(r.storage).toBe(storage2);
    // 关键断言:绝对不能是 scheduler1(spec 评审 worker bug #1)
    expect(r.scheduler).not.toBe(scheduler1);
  });

  it('relogin 后再 await: 拿到 NEW instance,不会回归 scheduler1', async () => {
    setSchedulerReady(scheduler1, storage1);
    resetSchedulerReady();
    setSchedulerReady(scheduler2, storage2);

    const r = await awaitReadyWithTimeout();
    expect(r.scheduler).toBe(scheduler2);
    expect(r.storage).toBe(storage2);
  });

  it('teardown window: reset 后立即 await 必须 pending,绝不 resolve 到刚 reset 的旧实例', async () => {
    // 对应 bootstrap auth:logout 把 resetSchedulerReady() 提到 await resetScheduler()
    // 之前的修复:teardown 窗口里(旧 scheduler 正在 stop)新到的 withScheduler
    // 调用必须 pending,而不是立刻拿到正在停的旧实例。
    setSchedulerReady(scheduler1, storage1);
    // 确认此刻能立刻拿到 scheduler1
    expect((await awaitReadyWithTimeout()).scheduler).toBe(scheduler1);

    // logout:先清 holder(模拟修复后的顺序)
    resetSchedulerReady();

    // 紧接着的 await 必须 pending —— 不能再 resolve 到 scheduler1
    const pDuringTeardown = awaitReadyWithTimeout();
    let resolved = false;
    void pDuringTeardown.then(() => { resolved = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    // relogin 喂入新实例后才 resolve,且是新实例
    setSchedulerReady(scheduler2, storage2);
    const r = await pDuringTeardown;
    expect(r.scheduler).toBe(scheduler2);
    expect(r.scheduler).not.toBe(scheduler1);
  });

  it('timeout: 30s 内不 setReady,awaitReadyWithTimeout reject 出 readiness timeout error', async () => {
    vi.useFakeTimers();

    const p = awaitReadyWithTimeout();
    // 静默 unhandled rejection — 我们随后会 expect.rejects
    p.catch(() => undefined);

    // 推时间到 30s
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(p).rejects.toThrow(/readiness timeout/);
  });

  it('clearTimeout: setSchedulerReady 先到时 timer 被释放,不会在 30s 后泄漏', async () => {
    vi.useFakeTimers();

    const p = awaitReadyWithTimeout();
    setSchedulerReady(scheduler1, storage1);
    const r = await p;
    expect(r.scheduler).toBe(scheduler1);

    // 推时间到 30s 之后 — 没有 timer 应该 fire(若 fire 会导致 unhandled rejection,
    // vitest 会失败)。这里只是确认推时间不抛错。
    await vi.advanceTimersByTimeAsync(60_000);
    // 顺便确认推时间后 holder 状态没被任何 stale callback 改坏
    const r2 = await awaitReadyWithTimeout();
    expect(r2.scheduler).toBe(scheduler1);
  });

  it('multiple resolvers fire in registration order, all see same deps', async () => {
    const order: number[] = [];
    const p1 = awaitReadyWithTimeout().then((d) => { order.push(1); return d; });
    const p2 = awaitReadyWithTimeout().then((d) => { order.push(2); return d; });
    const p3 = awaitReadyWithTimeout().then((d) => { order.push(3); return d; });

    setSchedulerReady(scheduler1, storage1);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.scheduler).toBe(scheduler1);
    expect(r2.scheduler).toBe(scheduler1);
    expect(r3.scheduler).toBe(scheduler1);
    expect(order).toEqual([1, 2, 3]);
  });

  it('resetSchedulerReady is idempotent — calling twice doesn\'t break next setReady', async () => {
    setSchedulerReady(scheduler1, storage1);
    resetSchedulerReady();
    resetSchedulerReady();
    setSchedulerReady(scheduler2, storage2);

    const r = await awaitReadyWithTimeout();
    expect(r.scheduler).toBe(scheduler2);
  });

  it('broadcasts scheduler events before isolated Agent Island updates', () => {
    const handlers = new Map<string, (event: never) => void>();
    const scheduler = {
      on: vi.fn((name: string, handler: (event: never) => void) => {
        handlers.set(name, handler);
      }),
    } as never;

    attachSchedulerEventListeners(scheduler, storage1);
    h.webContentsSend.mockClear();
    h.tapWindowBroadcast.mockClear();
    h.handleScheduleEvent.mockClear();
    h.handleScheduleEvent.mockImplementationOnce(() => {
      throw new Error('agent island unavailable');
    });

    const event = { type: 'completed', scheduleId: 'schedule-1', runId: 'run-1' } as never;
    expect(() => handlers.get('completed')!(event)).not.toThrow();

    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('maker:schedule:event', event);
    expect(h.webContentsSend).toHaveBeenCalledWith('maker:schedule:event', event);
    expect(h.handleScheduleEvent).toHaveBeenCalledWith(event);
    expect(h.webContentsSend.mock.invocationCallOrder[0]).toBeLessThan(
      h.handleScheduleEvent.mock.invocationCallOrder[0],
    );
  });
});
