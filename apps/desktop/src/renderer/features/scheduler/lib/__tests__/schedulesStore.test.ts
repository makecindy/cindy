/**
 * schedulesStore — renderer 端 schedule 列表 store 的状态机测试。
 *
 * Cover 的关键设计点:
 *
 *   1. ensure() 单 IPC 去重 — 并发两次 ensure() 只触发一次 list 调用。
 *   2. cache 命中后 ensure() noop —— 不再调 IPC。
 *   3. forceRefresh() 不清 cache,拉到新数据再 swap(SWR);刷新在途 / 失败均保留旧
 *      cache,杜绝 CLAUDE.md §12 的空白帧。
 *   4. 'changed' 事件触发 forceRefresh()。
 *   5. **'ready' 事件在 wasReset(relogin)或 lastError(冷启 >30s 超时报错后自愈)时
 *      触发重拉**;正常冷启动两者都 false → no-op,不重复打冗余 IPC。
 *   6. **logout(authState.isAuthenticated=false)清 cache + 标 wasReset
 *      → 下次 'ready' 触发后台预热**(spec worker bug #1 在 renderer 侧的对偶)。
 *   7. ensure() 失败把错写到 lastError + notify subscriber。
 *
 * 测试不模拟 window listener 注册 — 用 handleSchedulerEvent / handleAuthStateChange
 * 直接 import 调用,跟 schedulesStore.ts 模块加载时挂的 listener 是同一个函数。
 *
 * @vitest-environment node
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import type { Schedule } from '@cindy/maker-scheduler';

import {
  schedulesStore,
  handleSchedulerEvent,
  handleAuthStateChange,
  __resetStoreForTest,
} from '../schedulesStore';

// Minimal Schedule stand-ins — store 只持有引用,不读字段。
const schedule1 = { id: 's1', name: 'one' } as unknown as Schedule;
const schedule2 = { id: 's2', name: 'two' } as unknown as Schedule;
const schedule3 = { id: 's3', name: 'three' } as unknown as Schedule;

let listMock: ReturnType<typeof vi.fn>;
let listResponses: Schedule[][];
let listCallCount: number;

function stubElectronAPI(): void {
  listCallCount = 0;
  listMock = vi.fn(async () => {
    const idx = listCallCount;
    listCallCount += 1;
    return listResponses[idx] ?? listResponses[listResponses.length - 1] ?? [];
  });
  vi.stubGlobal('window', {
    electronAPI: {
      maker: {
        schedule: {
          list: listMock,
          // store 模块顶部 wire 时会读 onEvent 注册 listener — 测试里不依赖它(直接
          // 调 handleSchedulerEvent),给个 noop 让 wire 调用不抛错。
          onEvent: () => () => undefined,
        },
      },
      onAuthStateChange: () => () => undefined,
    },
  });
}

beforeEach(() => {
  listResponses = [[schedule1, schedule2]]; // 默认第一次返回 2 条
  stubElectronAPI();
  __resetStoreForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('schedulesStore.ensure()', () => {
  it('first call triggers one IPC and caches the result', async () => {
    const list = await schedulesStore.ensure();
    expect(list).toEqual([schedule1, schedule2]);
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(schedulesStore.getSnapshot()).toEqual([schedule1, schedule2]);
    expect(schedulesStore.getError()).toBeNull();
  });

  it('cache hit: subsequent ensure() is noop (zero extra IPC)', async () => {
    await schedulesStore.ensure();
    await schedulesStore.ensure();
    await schedulesStore.ensure();
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it('concurrent ensure(): dedupes to single IPC', async () => {
    const p1 = schedulesStore.ensure();
    const p2 = schedulesStore.ensure();
    const p3 = schedulesStore.ensure();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toEqual([schedule1, schedule2]);
    expect(r2).toEqual([schedule1, schedule2]);
    expect(r3).toEqual([schedule1, schedule2]);
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it('failure writes lastError, notifies subscribers, and re-throws', async () => {
    listMock = vi.fn(async () => { throw new Error('boom'); });
    vi.stubGlobal('window', {
      electronAPI: {
        maker: { schedule: { list: listMock, onEvent: () => () => undefined } },
        onAuthStateChange: () => () => undefined,
      },
    });
    __resetStoreForTest();

    const notifySpy = vi.fn();
    schedulesStore.subscribe(notifySpy);

    await expect(schedulesStore.ensure()).rejects.toThrow('boom');
    expect(schedulesStore.getError()).toBe('boom');
    expect(schedulesStore.getSnapshot()).toBeNull();
    expect(notifySpy).toHaveBeenCalled();
  });
});

describe('schedulesStore.forceRefresh()', () => {
  it('re-fetches with fresh IPC and swaps in new data', async () => {
    listResponses = [[schedule1], [schedule2, schedule3]];
    stubElectronAPI();
    __resetStoreForTest();

    const first = await schedulesStore.ensure();
    expect(first).toEqual([schedule1]);

    const refreshed = await schedulesStore.forceRefresh();
    expect(refreshed).toEqual([schedule2, schedule3]);
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(schedulesStore.getSnapshot()).toEqual([schedule2, schedule3]);
  });

  it('keeps old snapshot visible during in-flight fetch (no blank frame, CLAUDE.md §12)', async () => {
    // 不变量:forceRefresh 期间 getSnapshot() 必须保持旧数据(非 null),只有 IPC
    // 返回后才 swap。否则 useSyncExternalStore 在刷新窗口里被任意重渲染读到 null,
    // SchedulerPage 会闪一帧空列表(本次重构曾引入的回归,这条测试把它钉死)。

    // 1) 先 seed cache
    listResponses = [[schedule1]];
    stubElectronAPI();
    __resetStoreForTest();
    await schedulesStore.ensure();
    expect(schedulesStore.getSnapshot()).toEqual([schedule1]);

    // 2) 换成可控 deferred list,模拟 IPC 在途未返回
    let resolveList!: (v: Schedule[]) => void;
    const deferred = new Promise<Schedule[]>((res) => {
      resolveList = res;
    });
    const deferredList = vi.fn(() => deferred);
    vi.stubGlobal('window', {
      electronAPI: {
        maker: { schedule: { list: deferredList, onEvent: () => () => undefined } },
        onAuthStateChange: () => () => undefined,
      },
    });

    // 3) forceRefresh 启动但不 await —— in-flight 期间 snapshot 必须仍是旧数据
    const p = schedulesStore.forceRefresh();
    expect(schedulesStore.getSnapshot()).toEqual([schedule1]); // ← 关键:非 null

    // 4) IPC 返回后才 swap
    resolveList([schedule2, schedule3]);
    await p;
    expect(schedulesStore.getSnapshot()).toEqual([schedule2, schedule3]);
  });

  it('keeps old cache on refresh failure (stale-if-error, no blank frame)', async () => {
    listResponses = [[schedule1]];
    stubElectronAPI();
    __resetStoreForTest();
    await schedulesStore.ensure();
    expect(schedulesStore.getSnapshot()).toEqual([schedule1]);

    // 换成失败的 list
    const failingList = vi.fn(async () => {
      throw new Error('refresh boom');
    });
    vi.stubGlobal('window', {
      electronAPI: {
        maker: { schedule: { list: failingList, onEvent: () => () => undefined } },
        onAuthStateChange: () => () => undefined,
      },
    });

    await expect(schedulesStore.forceRefresh()).rejects.toThrow('refresh boom');
    // 刷新失败:lastError 更新,但旧 cache 保留(stale-if-error),不闪空
    expect(schedulesStore.getError()).toBe('refresh boom');
    expect(schedulesStore.getSnapshot()).toEqual([schedule1]);
  });

  it('clears lastError on success', async () => {
    listMock = vi.fn(async () => { throw new Error('first call fails'); });
    vi.stubGlobal('window', {
      electronAPI: {
        maker: { schedule: { list: listMock, onEvent: () => () => undefined } },
        onAuthStateChange: () => () => undefined,
      },
    });
    __resetStoreForTest();

    await expect(schedulesStore.ensure()).rejects.toThrow();
    expect(schedulesStore.getError()).toBe('first call fails');

    // 换成成功版本
    listMock = vi.fn(async () => [schedule1]);
    vi.stubGlobal('window', {
      electronAPI: {
        maker: { schedule: { list: listMock, onEvent: () => () => undefined } },
        onAuthStateChange: () => () => undefined,
      },
    });

    const r = await schedulesStore.forceRefresh();
    expect(r).toEqual([schedule1]);
    expect(schedulesStore.getError()).toBeNull();
  });
});

describe('handleSchedulerEvent', () => {
  it('"changed" triggers forceRefresh (one extra IPC)', async () => {
    listResponses = [[schedule1], [schedule2]];
    stubElectronAPI();
    __resetStoreForTest();

    await schedulesStore.ensure();
    expect(listMock).toHaveBeenCalledTimes(1);

    handleSchedulerEvent({ type: 'changed', scheduleId: 'whatever' });
    // forceRefresh 是 async,等下一个 microtask
    await new Promise((r) => setTimeout(r, 0));
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(schedulesStore.getSnapshot()).toEqual([schedule2]);
  });

  it('"ready" without prior reset is NO-OP (cold-start path)', async () => {
    // 冷启动场景:ensure() 已经把 cache 填好,'ready' 不应该再触发 list
    await schedulesStore.ensure();
    expect(listMock).toHaveBeenCalledTimes(1);

    handleSchedulerEvent({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 0));
    expect(listMock).toHaveBeenCalledTimes(1); // 仍然只有一次
  });

  it('"ready" AFTER reset (logout) triggers background warmup', async () => {
    listResponses = [[schedule1], [schedule2, schedule3]];
    stubElectronAPI();
    __resetStoreForTest();

    // 1) 初始 ensure
    await schedulesStore.ensure();
    expect(listMock).toHaveBeenCalledTimes(1);

    // 2) logout → cache 清掉 + wasReset=true
    handleAuthStateChange({ isAuthenticated: false });
    expect(schedulesStore.getSnapshot()).toBeNull();

    // 3) relogin → main 端发 'ready' → store 后台预热
    handleSchedulerEvent({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 0));
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(schedulesStore.getSnapshot()).toEqual([schedule2, schedule3]);
  });

  it('"ready" after a fetch error triggers self-heal (cold-start >30s timeout recovery)', async () => {
    // 1) 首次 ensure 失败 —— scheduler 启动 >30s,main 端 readiness 超时报错。
    //    没有登出过(wasReset=false),只有 lastError 置位。
    const failingList = vi.fn(async () => { throw new Error('scheduler not ready'); });
    vi.stubGlobal('window', {
      electronAPI: {
        maker: { schedule: { list: failingList, onEvent: () => () => undefined } },
        onAuthStateChange: () => () => undefined,
      },
    });
    __resetStoreForTest();

    await expect(schedulesStore.ensure()).rejects.toThrow('scheduler not ready');
    expect(schedulesStore.getError()).toBe('scheduler not ready');
    expect(schedulesStore.getSnapshot()).toBeNull();

    // 2) scheduler 终于就绪 → main 发 'ready'。wasReset=false 但 lastError 非空,
    //    应该借 'ready' 自愈重拉(而非卡死在错误态)。
    const okList = vi.fn(async () => [schedule1, schedule2]);
    vi.stubGlobal('window', {
      electronAPI: {
        maker: { schedule: { list: okList, onEvent: () => () => undefined } },
        onAuthStateChange: () => () => undefined,
      },
    });

    handleSchedulerEvent({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 0));

    expect(okList).toHaveBeenCalledTimes(1);
    expect(schedulesStore.getSnapshot()).toEqual([schedule1, schedule2]);
    expect(schedulesStore.getError()).toBeNull();
  });

  it('"ready" predicate is one-shot — second "ready" without intervening reset is no-op', async () => {
    listResponses = [[schedule1], [schedule2], [schedule3]];
    stubElectronAPI();
    __resetStoreForTest();

    await schedulesStore.ensure();
    handleAuthStateChange({ isAuthenticated: false });

    handleSchedulerEvent({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 0));
    expect(listMock).toHaveBeenCalledTimes(2);

    // 紧接的第二个 'ready' 不应该再触发预热(wasReset 已被第一次预热清掉)
    handleSchedulerEvent({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 0));
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('unrelated events ("fired"/"completed"/...) do NOT trigger refresh', async () => {
    await schedulesStore.ensure();
    const baseline = listMock.mock.calls.length;

    handleSchedulerEvent({ type: 'fired', scheduleId: 'x', runId: 'r1' });
    handleSchedulerEvent({ type: 'completed', scheduleId: 'x', runId: 'r1', sessionId: 's' });
    handleSchedulerEvent({ type: 'failed', scheduleId: 'x', runId: 'r1', error: 'e' });
    handleSchedulerEvent({ type: 'session-bound', scheduleId: 'x', runId: 'r1', sessionId: 's' });
    handleSchedulerEvent({ type: 'read', scheduleId: 'x' });
    handleSchedulerEvent({ type: 'all-read' });
    await new Promise((r) => setTimeout(r, 0));

    expect(listMock).toHaveBeenCalledTimes(baseline);
  });

  // 测试价值
  // - 生产入口与可观察结果：handleSchedulerEvent 处理周期任务的 skipped 事件时原位更新缓存时间戳且不触发 list IPC。
  // - 规则依据：docs/dev-rules/engineering-conventions.md 高频状态刷新与缓存性能约束。
  // - 现有覆盖缺口：此前周期 skipped 依赖紧随其后的 changed 全表重拉，未覆盖无 IPC 的原位时间戳更新。
  // - 最小失败输入：带 lastFiredAt / lastFinishedAt / nextFireAt 的 skipped 事件。
  // - tier：unit。
  it('"skipped" patches schedule timestamps in-place without extra list IPC', async () => {
    await schedulesStore.ensure();
    const baseline = listMock.mock.calls.length;
    const notifySpy = vi.fn();
    schedulesStore.subscribe(notifySpy);

    handleSchedulerEvent({
      type: 'skipped',
      scheduleId: 's1',
      runId: 'r-skip',
      sessionId: '',
      lastFiredAt: 1000,
      lastFinishedAt: 1050,
      nextFireAt: 301050,
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(listMock).toHaveBeenCalledTimes(baseline);
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(schedulesStore.getSnapshot()?.[0]).toMatchObject({
      id: 's1',
      lastFiredAt: 1000,
      lastFinishedAt: 1050,
      nextFireAt: 301050,
    });
  });
});

describe('handleAuthStateChange', () => {
  it('isAuthenticated=false: clears cache/error, marks wasReset, notifies', async () => {
    await schedulesStore.ensure();
    expect(schedulesStore.getSnapshot()).not.toBeNull();

    const notifySpy = vi.fn();
    schedulesStore.subscribe(notifySpy);

    handleAuthStateChange({ isAuthenticated: false });

    expect(schedulesStore.getSnapshot()).toBeNull();
    expect(schedulesStore.getError()).toBeNull();
    expect(notifySpy).toHaveBeenCalled();
  });

  it('isAuthenticated=true: no-op (login does not clear cache)', async () => {
    await schedulesStore.ensure();
    const before = schedulesStore.getSnapshot();

    const notifySpy = vi.fn();
    schedulesStore.subscribe(notifySpy);

    handleAuthStateChange({ isAuthenticated: true });

    expect(schedulesStore.getSnapshot()).toBe(before);
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('cross-account: 账号 A 的 in-flight list 晚到,绝不能覆盖账号 B 的 cache ([阻断])', async () => {
    // 这是 review bot 标阻断的跨账号串库竞态:logout 只断引用,断不掉已 await 在途
    // 的 promise;A 的 list 在 logout 后才返回,旧实现会把 A 的数据写进 B 的 cache。
    // epoch 机制让晚到的 A 请求在回写时校验失败 → 丢弃。

    // 1) 账号 A 发起 ensure,list 用 deferred 模拟在途未返回
    let resolveA!: (v: Schedule[]) => void;
    const deferredA = new Promise<Schedule[]>((res) => {
      resolveA = res;
    });
    const listA = vi.fn(() => deferredA);
    vi.stubGlobal('window', {
      electronAPI: {
        maker: { schedule: { list: listA, onEvent: () => () => undefined } },
        onAuthStateChange: () => () => undefined,
      },
    });
    __resetStoreForTest();

    const pA = schedulesStore.ensure();
    expect(schedulesStore.getSnapshot()).toBeNull(); // A 的请求还没回来

    // 2) 登出(epoch++,清 cache/inflight,但 pA 仍在途)
    handleAuthStateChange({ isAuthenticated: false });

    // 3) 账号 B 登录 → 'ready' 后台预热 → 拉到 B 自己的数据
    const listB = vi.fn(async () => [schedule2]);
    vi.stubGlobal('window', {
      electronAPI: {
        maker: { schedule: { list: listB, onEvent: () => () => undefined } },
        onAuthStateChange: () => () => undefined,
      },
    });
    handleSchedulerEvent({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 0));
    expect(schedulesStore.getSnapshot()).toEqual([schedule2]); // B 的数据已就位

    // 4) 账号 A 的旧请求**现在才晚到** —— 绝不能覆盖 B 的 cache
    resolveA([schedule1]);
    await pA.catch(() => undefined); // pA 返回 A 数据,但不得回写 cache
    await new Promise((r) => setTimeout(r, 0));
    expect(schedulesStore.getSnapshot()).toEqual([schedule2]); // 仍是 B,不是 A
  });
});

describe('subscribe / unsubscribe', () => {
  it('subscribe returns an unsubscribe function that stops notifications', async () => {
    const notifySpy = vi.fn();
    const unsubscribe = schedulesStore.subscribe(notifySpy);

    await schedulesStore.ensure();
    expect(notifySpy).toHaveBeenCalledTimes(1);

    unsubscribe();
    await schedulesStore.forceRefresh();
    expect(notifySpy).toHaveBeenCalledTimes(1); // 没新增
  });
});
