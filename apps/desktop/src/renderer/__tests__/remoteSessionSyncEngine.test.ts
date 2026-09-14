/**
 * remoteSessionSyncEngine.test.ts —— device-link 远程会话同步编排纯核(behavioral)。
 *
 * 锁住「控制端丢消息」修复的核心逻辑(不依赖 React,注入 spy + fake timers):
 *  - WS 重连 / 被控端回在线 → 重订阅重 topic + 对账
 *  - presence 仅对「本会话设备 + online」生效;别的设备 / 离线忽略
 *  - turn 结束(isRunning true→false)边沿触发对账;primeRunning 防 mount-mid-run 误判
 *  - 窗口聚焦 → 对账;多触发源在去抖窗口内合并成一次
 *  - resync → 重订阅 + 对账 + 重拉列表
 *  - dispose → 退订 + 清 pending 定时器(之后不再对账)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  createRemoteSessionSyncEngine,
  type RemoteSyncEngineDeps,
  type RemoteSyncTarget,
} from '@/features/cc-agent/hooks/useRemoteSessionSync';

const DEBOUNCE = 100;
const SID = 's1';
const DEV = 'dev-A';

function setup(target: RemoteSyncTarget = { sessionId: SID, deviceId: DEV }) {
  const deps = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    reconcile: vi.fn(),
    refreshList: vi.fn(),
    debounceMs: DEBOUNCE,
  } satisfies RemoteSyncEngineDeps;
  const engine = createRemoteSessionSyncEngine(() => target, deps);
  return { engine, deps };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createRemoteSessionSyncEngine', () => {
  it('keeps an offline running view quiet and resumes using the existing recovery path', async () => {
    let available = false;
    const deps = { canRead: () => available, subscribe: vi.fn(), unsubscribe: vi.fn(), reconcile: vi.fn(),
      refreshList: vi.fn(), getLastEventAt: () => 0, isRunningNow: () => true,
      queryTurnRunning: vi.fn(async () => true), finalize: vi.fn(), reconcileForce: vi.fn(),
      onSuspectStall: vi.fn(), stallThresholdMs: 1, watchdogIntervalMs: 10 };
    const engine = createRemoteSessionSyncEngine(() => ({ sessionId: SID, deviceId: DEV }), deps);
    engine.subscribeHeavy(); engine.reconcileOnMount(); engine.startWatchdog();
    engine.handleFocus(); engine.resync();
    await vi.advanceTimersByTimeAsync(2_000);
    for (const call of [deps.subscribe, deps.reconcile, deps.queryTurnRunning, deps.refreshList, deps.onSuspectStall]) {
      expect(call).not.toHaveBeenCalled();
    }
    available = true;
    engine.handleOnline();
    await vi.advanceTimersByTimeAsync(200);
    expect(deps.subscribe).toHaveBeenCalled();
    expect(deps.reconcile).toHaveBeenCalled();
    engine.dispose();
  });
  it('subscribeHeavy 订阅正确重 topic;无 device/session → no-op', () => {
    const { engine, deps } = setup();
    engine.subscribeHeavy();
    expect(deps.subscribe).toHaveBeenCalledWith(DEV, ['session:s1']);

    const local = setup({ sessionId: SID, deviceId: undefined });
    local.engine.subscribeHeavy();
    expect(local.deps.subscribe).not.toHaveBeenCalled();
  });

  it('handleOnline(WS 重连):重订阅 + 去抖后对账', () => {
    const { engine, deps } = setup();
    engine.handleOnline();
    expect(deps.subscribe).toHaveBeenCalledWith(DEV, ['session:s1']);
    expect(deps.reconcile).not.toHaveBeenCalled(); // 去抖中
    vi.advanceTimersByTime(DEBOUNCE);
    expect(deps.reconcile).toHaveBeenCalledWith('s1');
  });

  it('handlePresence:仅本会话设备 + online 生效', () => {
    const { engine, deps } = setup();
    engine.handlePresence('dev-OTHER', true); // 别的设备
    engine.handlePresence(DEV, false); // 本设备但离线
    vi.advanceTimersByTime(DEBOUNCE);
    expect(deps.subscribe).not.toHaveBeenCalled();
    expect(deps.reconcile).not.toHaveBeenCalled();

    engine.handlePresence(DEV, true); // 本设备回在线
    expect(deps.subscribe).toHaveBeenCalledWith(DEV, ['session:s1']);
    vi.advanceTimersByTime(DEBOUNCE);
    expect(deps.reconcile).toHaveBeenCalledTimes(1);
  });

  it('turn 结束(true→false)边沿对账;false→false / false→true 不触发', () => {
    const { engine, deps } = setup();
    engine.handleRunningChange(true); // 进 turn
    engine.handleRunningChange(false); // turn 结束 → 对账
    vi.advanceTimersByTime(DEBOUNCE);
    expect(deps.reconcile).toHaveBeenCalledTimes(1);

    deps.reconcile.mockClear();
    engine.handleRunningChange(false); // false→false
    engine.handleRunningChange(true); // false→true
    vi.advanceTimersByTime(DEBOUNCE);
    expect(deps.reconcile).not.toHaveBeenCalled();
  });

  it('primeRunning:mount-mid-run(初始 running=true)后第一次 false 才算 turn 结束', () => {
    const { engine, deps } = setup();
    engine.primeRunning(true); // 挂载时已在 turn 中
    engine.handleRunningChange(false); // 真·turn 结束
    vi.advanceTimersByTime(DEBOUNCE);
    expect(deps.reconcile).toHaveBeenCalledTimes(1);
  });

  it('handleFocus → 对账', () => {
    const { engine, deps } = setup();
    engine.handleFocus();
    vi.advanceTimersByTime(DEBOUNCE);
    expect(deps.reconcile).toHaveBeenCalledTimes(1);
  });

  it('去抖:窗口内多触发源合并成一次对账', () => {
    const { engine, deps } = setup();
    engine.handleOnline();
    engine.handleFocus();
    engine.handlePresence(DEV, true);
    engine.handleRunningChange(true);
    engine.handleRunningChange(false);
    vi.advanceTimersByTime(DEBOUNCE);
    expect(deps.reconcile).toHaveBeenCalledTimes(1); // 合并

    // 窗口过后再触发 → 新一次
    engine.handleFocus();
    vi.advanceTimersByTime(DEBOUNCE);
    expect(deps.reconcile).toHaveBeenCalledTimes(2);
  });

  it('resync:重订阅 + 对账 + 重拉列表', () => {
    const { engine, deps } = setup();
    engine.resync();
    expect(deps.subscribe).toHaveBeenCalledWith(DEV, ['session:s1']);
    expect(deps.refreshList).toHaveBeenCalledWith(DEV);
    vi.advanceTimersByTime(DEBOUNCE);
    expect(deps.reconcile).toHaveBeenCalledWith('s1');
  });

  it('dispose:退订 + 清 pending 定时器(之后不再对账)', () => {
    const { engine, deps } = setup();
    engine.handleFocus(); // 排了一次待对账
    engine.dispose();
    expect(deps.unsubscribe).toHaveBeenCalledWith(DEV, ['session:s1']);
    vi.advanceTimersByTime(DEBOUNCE * 5);
    expect(deps.reconcile).not.toHaveBeenCalled(); // pending 被清,不再触发
  });

  it('无看门狗 deps → startWatchdog 是 dormant no-op', async () => {
    const { engine, deps } = setup(); // 不含看门狗 deps
    engine.startWatchdog();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.reconcile).not.toHaveBeenCalled(); // 没有 timer 在跑
  });
});

// ─── stall 看门狗 ───────────────────────────────────────────────────────────
const STALL_MS = 1000;
const TICK_MS = 100;

/**
 * 注入可控时钟(now)+ running 旗标(finalize 与真实系统一样把它翻 false)+ 全套看门狗 spy。
 * 时钟(staleness 判定)与 fake timer(tick 触发)解耦:setNow 控静默时长,advanceTimersByTimeAsync 驱 tick。
 */
function setupWatchdog(overrides: Partial<RemoteSyncEngineDeps> = {}) {
  let nowMs = 0;
  let running = true;
  const deps = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    reconcile: vi.fn(),
    refreshList: vi.fn(),
    debounceMs: DEBOUNCE,
    now: () => nowMs,
    getLastEventAt: vi.fn((): number | undefined => undefined),
    isRunningNow: vi.fn(() => running),
    queryTurnRunning: vi.fn(async (): Promise<boolean> => false),
    finalize: vi.fn(() => {
      running = false; // 真实耦合:收尾后控制端 isRunning 转 false
    }),
    reconcileForce: vi.fn(),
    onSuspectStall: vi.fn(),
    onRecovered: vi.fn(),
    stallThresholdMs: STALL_MS,
    watchdogIntervalMs: TICK_MS,
    ...overrides,
  } satisfies RemoteSyncEngineDeps;
  const target: RemoteSyncTarget = { sessionId: SID, deviceId: DEV };
  const engine = createRemoteSessionSyncEngine(() => target, deps);
  return {
    engine,
    deps,
    setNow: (n: number) => {
      nowMs = n;
    },
    setRunning: (r: boolean) => {
      running = r;
    },
  };
}

describe('createRemoteSessionSyncEngine — stall 看门狗', () => {
  it('lastEventAt 新鲜(静默 < 阈值)→ 不触发恢复', async () => {
    const { engine, deps, setNow } = setupWatchdog();
    engine.startWatchdog(); // watchdogStartedAt = 0
    setNow(STALL_MS - 1); // 静默不足阈值
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(deps.queryTurnRunning).not.toHaveBeenCalled();
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it('isRunning + 静默 ≥ 阈值 → 重订阅 → 查询 →(not-running)→ finalize + 强制对账(按序)', async () => {
    const { engine, deps, setNow } = setupWatchdog(); // 默认 query=false → not-running
    engine.startWatchdog();
    setNow(STALL_MS * 2);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(deps.subscribe).toHaveBeenCalledWith(DEV, ['session:s1']);
    expect(deps.queryTurnRunning).toHaveBeenCalledWith(SID);
    expect(deps.reconcileForce).toHaveBeenCalledWith(SID);
    // 顺序:subscribe → queryTurnRunning →(确认 not-running 后)→ reconcileForce
    // force 绝不在 query 之前 —— 仍在跑的 live stream 不能被强行合并(Codex P2)。
    const order = (f: unknown): number =>
      (f as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];
    expect(order(deps.subscribe)).toBeLessThan(order(deps.queryTurnRunning));
    expect(order(deps.queryTurnRunning)).toBeLessThan(order(deps.reconcileForce));
  });

  it('被控端 not-running → finalize 恰一次(收尾后 isRunning=false,后续 tick 不再触发)', async () => {
    const { engine, deps, setNow } = setupWatchdog(); // queryTurnRunning 默认 false
    engine.startWatchdog();
    setNow(STALL_MS * 2);
    await vi.advanceTimersByTimeAsync(TICK_MS); // tick1:确认卡死 → finalize
    expect(deps.finalize).toHaveBeenCalledTimes(1);
    expect(deps.reconcileForce).toHaveBeenCalledWith(SID); // 收尾后 force 对账补回最终消息(host 已停)
    await vi.advanceTimersByTimeAsync(TICK_MS * 5); // 后续 tick:isRunning 已 false
    expect(deps.finalize).toHaveBeenCalledTimes(1); // 不重复收尾
  });

  it('被控端仍在跑 → 不 finalize,backoff 后再核', async () => {
    const { engine, deps, setNow } = setupWatchdog({
      queryTurnRunning: vi.fn(async (): Promise<boolean> => true),
    });
    engine.startWatchdog();
    setNow(STALL_MS * 2);
    await vi.advanceTimersByTimeAsync(TICK_MS); // tick1:查到仍在跑 → 不收尾,backoff→2
    await vi.advanceTimersByTimeAsync(TICK_MS * 2); // backoff 后 tick2(间隔 200ms)
    expect(deps.finalize).not.toHaveBeenCalled();
    expect(deps.reconcileForce).not.toHaveBeenCalled(); // 仍在跑 → 绝不在 live stream 上 force 对账(Codex P2)
    expect((deps.queryTurnRunning as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('恢复(查询成功连上被控端)→ onRecovered 清残留兜底态,不 finalize(仍在跑)', async () => {
    // Codex P2:transient 查询失败设了 suspectStall 后,流恢复 / 查询成功必须清兜底,
    // 否则活着的 turn 一直挂「可能已断流 / 结束本轮」。
    const { engine, deps, setNow } = setupWatchdog({
      queryTurnRunning: vi.fn(async (): Promise<boolean> => true),
    });
    engine.startWatchdog();
    setNow(STALL_MS * 2);
    await vi.advanceTimersByTimeAsync(TICK_MS); // 查询成功且仍在跑 → onRecovered,不 finalize
    expect(deps.onRecovered).toHaveBeenCalledWith(SID);
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it('恢复(新事件到达,静默重置)→ onRecovered 清残留兜底态', async () => {
    const { engine, deps, setNow } = setupWatchdog();
    engine.startWatchdog();
    // isRunning 仍 true,但 lastEventAt 新鲜(静默 < 阈值)→ not-stalled 分支 → onRecovered
    (deps.getLastEventAt as ReturnType<typeof vi.fn>).mockReturnValue(STALL_MS * 2 - 1);
    setNow(STALL_MS * 2);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(deps.onRecovered).toHaveBeenCalledWith(SID);
    expect(deps.queryTurnRunning).not.toHaveBeenCalled(); // 没进恢复序列
  });

  it('查询失败(不可达/旧端/超时)→ onSuspectStall,不 auto-finalize', async () => {
    const { engine, deps, setNow } = setupWatchdog({
      queryTurnRunning: vi.fn(async (): Promise<boolean> => {
        throw new Error('[DEVICE_LINK_DEVICE_OFFLINE] unreachable');
      }),
    });
    engine.startWatchdog();
    setNow(STALL_MS * 2);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(deps.onSuspectStall).toHaveBeenCalledWith(SID);
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it('dispose 后看门狗停止(不再查询 / finalize)', async () => {
    const { engine, deps, setNow } = setupWatchdog();
    engine.startWatchdog();
    setNow(STALL_MS * 2);
    engine.dispose(); // tick 前就 dispose
    await vi.advanceTimersByTimeAsync(TICK_MS * 5);
    expect(deps.queryTurnRunning).not.toHaveBeenCalled();
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it('查询 await 期间 dispose → 迟到结果丢弃(不 finalize / 不弹兜底,防错挂到新会话)', async () => {
    // Codex/Greptile P2:dispose 只停未来 tick,在途 query 的 post-await 副作用必须靠 watchdogStopped 挡。
    let resolveQuery!: (v: boolean) => void;
    const deferred = new Promise<boolean>((res) => {
      resolveQuery = res;
    });
    const { engine, deps, setNow } = setupWatchdog({
      queryTurnRunning: vi.fn(() => deferred),
    });
    engine.startWatchdog();
    setNow(STALL_MS * 2);
    await vi.advanceTimersByTimeAsync(TICK_MS); // tick 触发 → 卡在 await query
    expect(deps.queryTurnRunning).toHaveBeenCalledTimes(1);
    engine.dispose(); // 切会话 / 卸载:watchdogStopped=true
    resolveQuery(false); // 迟到的"被控端 not-running"结果回来
    await vi.advanceTimersByTimeAsync(1); // flush await 续延
    expect(deps.finalize).not.toHaveBeenCalled(); // 不在已停看门狗上收尾
    expect(deps.onSuspectStall).not.toHaveBeenCalled();
  });
});

// ─── reconcileOnMount ─────────────────────────────────────────────────────────
const MOUNT_DELAY = 1000; // 与实现中 MOUNT_RECONCILE_DELAY_MS 对齐

describe('createRemoteSessionSyncEngine — reconcileOnMount', () => {
  it('isRunning=true + 延迟后仍 running → 查询被控端 → not-running → finalize + 强制对账', async () => {
    const { engine, deps } = setupWatchdog();
    engine.primeRunning(true);
    engine.startWatchdog();
    engine.reconcileOnMount();
    // 1s 延迟前不应查询
    await vi.advanceTimersByTimeAsync(MOUNT_DELAY - 1);
    expect(deps.queryTurnRunning).not.toHaveBeenCalled();
    // 延迟到期 → 查询
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.queryTurnRunning).toHaveBeenCalledTimes(1);
    expect(deps.finalize).toHaveBeenCalledTimes(1);
    expect(deps.reconcileForce).toHaveBeenCalledTimes(1);
  });

  it('延迟期间 isRunning 变 false(正常 done 到达)→ 不查询', async () => {
    const { engine, deps, setRunning } = setupWatchdog();
    engine.primeRunning(true);
    engine.startWatchdog();
    engine.reconcileOnMount();
    // 500ms 后 done 正常到达
    await vi.advanceTimersByTimeAsync(500);
    setRunning(false);
    // 延迟到期 → isRunning=false → 跳过
    await vi.advanceTimersByTimeAsync(500);
    expect(deps.queryTurnRunning).not.toHaveBeenCalled();
    expect(deps.finalize).not.toHaveBeenCalled();
  });

  it('isRunning=false → reconcileOnMount 立即 no-op', async () => {
    const { engine, deps, setRunning } = setupWatchdog();
    setRunning(false);
    engine.primeRunning(false);
    engine.startWatchdog();
    engine.reconcileOnMount();
    await vi.advanceTimersByTimeAsync(MOUNT_DELAY * 2);
    expect(deps.queryTurnRunning).not.toHaveBeenCalled();
  });

  it('dispose 后 mount reconcile 定时器被清(不再查询)', async () => {
    const { engine, deps } = setupWatchdog();
    engine.primeRunning(true);
    engine.startWatchdog();
    engine.reconcileOnMount();
    engine.dispose();
    await vi.advanceTimersByTimeAsync(MOUNT_DELAY * 2);
    expect(deps.queryTurnRunning).not.toHaveBeenCalled();
  });

  it('无看门狗 deps → reconcileOnMount 是 no-op', async () => {
    const { engine, deps } = setup(); // 不含看门狗 deps
    engine.primeRunning(true);
    engine.reconcileOnMount();
    await vi.advanceTimersByTimeAsync(MOUNT_DELAY * 2);
    expect(deps.reconcile).not.toHaveBeenCalled();
  });
});
