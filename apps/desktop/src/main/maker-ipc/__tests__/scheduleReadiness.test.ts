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
    ownerScope: 'owner-a:1',
    boundaryPending: false,
    getAllWindows: vi.fn(() => [
      { isDestroyed: () => false, webContents: { send: webContentsSend } },
    ]),
    tapWindowBroadcast: vi.fn(),
    handleScheduleEvent: vi.fn(),
  };
});

vi.mock('../../appSessionState.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../appSessionState.js')>(),
  activeOwnerScopeKey: () => h.ownerScope,
  isAppSessionBoundaryPending: () => h.boundaryPending,
}));

// Readiness tests do not execute plugin or hook tools; keep their runtime out of this fixture.
vi.mock('../../cindy-brain/index.js', () => ({ getGhostManager: vi.fn() }));

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
  captureDataOwnerBroadcastScope: vi.fn(() => ({
    ownerScopeKey: h.ownerScope,
    ownerStamp: { dataOwnerId: h.ownerScope, ownerGeneration: 1 },
  })),
  isDataOwnerBroadcastScopeCurrent: vi.fn(
    (scope: { ownerScopeKey?: string } | undefined) =>
      !h.boundaryPending && scope?.ownerScopeKey === h.ownerScope,
  ),
  tapWindowBroadcast: h.tapWindowBroadcast,
}));

vi.mock('../../agent-island/service.js', () => ({
  getAgentIslandService: () => ({ handleScheduleEvent: h.handleScheduleEvent }),
}));

import {
  setSchedulerReady,
  resetSchedulerReady,
  awaitReadyWithTimeout,
  awaitAccountSchedulerReady,
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
  h.ownerScope = 'owner-a:1';
  h.boundaryPending = false;
  h.webContentsSend.mockClear();
  h.getAllWindows.mockClear();
  h.tapWindowBroadcast.mockClear();
  h.handleScheduleEvent.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduler readiness holder', () => {
  // 2026-11-10, unit: project/goal calls wait on this existing gate. The
  // original holder tests did not protect calls queued across an owner change.
  it('waits for startup but rejects a continuation into another owner', async () => {
    const waiting = awaitAccountSchedulerReady();
    h.ownerScope = 'owner-b:2';
    setSchedulerReady(scheduler2, storage2);
    await expect(waiting).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(awaitAccountSchedulerReady()).resolves.toBeUndefined();
  });

  it('keeps readiness waiting bounded and does not admit calls during an account boundary', async () => {
    vi.useFakeTimers();
    h.boundaryPending = true;
    await expect(awaitAccountSchedulerReady()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(vi.getTimerCount()).toBe(0);
    h.boundaryPending = false;
    const failure = expect(awaitAccountSchedulerReady()).rejects.toMatchObject({ code: 'INTERNAL' });
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });

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

  // 测试价值
  // - 生产入口与可观察结果：attachSchedulerEventListeners 对新主机 skipped 事件做远端有界合并（10s 静默 / 30s 封顶向 tapWindowBroadcast 补一条带 skippedRunId 与捕获时 ownerStamp 的兼容 changed，本机窗口零额外 changed），并在即时 changed、切账号或账号边界挂起时取消/拒投。
  // - 规则依据：docs/dev-rules/protocol-compatibility.md、docs/dev-rules/server-channel-review.md 与 docs/dev-rules/credentials-and-local-storage.md —— 旧端保留有界 changed 对账，现代端凭 skippedRunId 去重，延时回调严禁跨账号代投递。
  // - 现有覆盖缺口：既有测试未覆盖 skippedRunId 对账标记、安排时 captureDataOwnerBroadcastScope + 发送时校验拦截跨账号投递。
  // - 最小失败输入：连续 skipped 脉冲、skipped 后紧跟 changed、skipped 后 resetSchedulerReady()、skipped 后 ownerScope 切换或 boundaryPending=true。
  // - tier：unit（vi.useFakeTimers）。
  it('coalesces steady-state skipped into owner-scoped remote changed with skippedRunId and drops cross-owner timers', async () => {
    vi.useFakeTimers();
    const handlers = new Map<string, (event: never) => void>();
    const scheduler = {
      on: vi.fn((name: string, handler: (event: never) => void) => {
        handlers.set(name, handler);
      }),
    } as never;

    attachSchedulerEventListeners(scheduler, storage1);
    h.webContentsSend.mockClear();
    h.tapWindowBroadcast.mockClear();

    const emitSkipped = (scheduleId: string, runId: string) =>
      handlers.get('skipped')!({
        type: 'skipped',
        scheduleId,
        runId,
        sessionId: '',
        lastFiredAt: Date.now(),
        lastFinishedAt: Date.now(),
        nextFireAt: Date.now() + 300_000,
        preRunCheckSucceeded: true,
      } as never);

    // 1) Burst of 6 skipped events every 5s (t=0..25s), then +5s to t=30s:
    // capped at 30s max wait -> 1 remote changed carrying latest skippedRunId + captured ownerStamp, 0 local changed.
    for (let i = 0; i < 6; i += 1) {
      emitSkipped('sched-burst', `r-${i}`);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(vi.getTimerCount()).toBe(0);
    const localChanged = h.webContentsSend.mock.calls.filter(
      ([, payload]) => (payload as { type?: string })?.type === 'changed',
    );
    const remoteChangedAfterCap = h.tapWindowBroadcast.mock.calls.filter(
      ([, payload]) => (payload as { type?: string })?.type === 'changed',
    );
    expect(localChanged).toEqual([]);
    expect(remoteChangedAfterCap).toEqual([
      [
        'maker:schedule:event',
        { type: 'changed', scheduleId: 'sched-burst', skippedRunId: 'r-5' },
        { dataOwnerId: 'owner-a:1', ownerGeneration: 1 },
      ],
    ]);

    // 2) Immediate changed (e.g. failure recovery) cancels pending remote coalescer so it does not double-send.
    h.tapWindowBroadcast.mockClear();
    emitSkipped('sched-recover', 'r-rec');
    handlers.get('changed')!({ type: 'changed', scheduleId: 'sched-recover' } as never);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(
      h.tapWindowBroadcast.mock.calls.filter(
        ([, payload]) => (payload as { type?: string })?.type === 'changed',
      ),
    ).toEqual([['maker:schedule:event', { type: 'changed', scheduleId: 'sched-recover' }]]);

    // 3) Logout / resetSchedulerReady clears pending timer immediately.
    emitSkipped('sched-owner-a', 'r-a');
    expect(vi.getTimerCount()).toBe(1);
    h.tapWindowBroadcast.mockClear();
    resetSchedulerReady();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();

    // 4) Even if a timer fires across an owner change or pending account boundary before reset,
    // send-time isDataOwnerBroadcastScopeCurrent drops it so owner-a never broadcasts under owner-b.
    emitSkipped('sched-cross-owner', 'r-cross');
    h.tapWindowBroadcast.mockClear();
    h.ownerScope = 'owner-b:2';
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();

    emitSkipped('sched-boundary', 'r-bound');
    h.tapWindowBroadcast.mockClear();
    h.boundaryPending = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.tapWindowBroadcast).not.toHaveBeenCalled();
  });
});
