/**
 * resource-watchdog.test.ts
 * ---------------------------------------------------------------------------
 * 覆盖 BrowserGuestResourceWatchdog 的阶梯策略(全部依赖注入,不碰 Electron):
 *   - 后台内存超限 → 立即 evict
 *   - 后台高 CPU 连击 → evict;发声 / pinned 豁免;中断清零
 *   - 前台内存超限 → kill-notice + forcefullyCrashRenderer
 *   - 前台高 CPU 连击 → cpu-alert + 冷却,不杀进程
 *   - ForegroundTabTracker 的 per-sender 状态语义
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BG_CPU_EVICT_STRIKES,
  BG_CPU_PERCENT,
  BG_MEMORY_EVICT_KB,
  BrowserGuestResourceWatchdog,
  FG_CPU_ALERT_COOLDOWN_TICKS,
  FG_CPU_ALERT_STRIKES,
  FG_CPU_PERCENT,
  FG_MEMORY_KILL_KB,
  ForegroundTabTracker,
  type GuestProcessMetric,
  type GuestWebContentsLike,
  type ResourceWatchdogDeps,
} from '../resource-watchdog';

interface FakeGuest extends GuestWebContentsLike {
  destroyed: boolean;
  audible: boolean;
  crashed: boolean;
}

function makeGuest(pid: number): FakeGuest {
  return {
    destroyed: false,
    audible: false,
    crashed: false,
    isDestroyed() {
      return this.destroyed;
    },
    getOSProcessId() {
      return pid;
    },
    isCurrentlyAudible() {
      return this.audible;
    },
    forcefullyCrashRenderer() {
      this.crashed = true;
    },
  };
}

/** 单 tab harness:metric / 前台 / pin 状态可逐 tick 调整。 */
function makeHarness() {
  const guest = makeGuest(1001);
  const metric: GuestProcessMetric = {
    pid: 1001,
    cpu: { percentCPUUsage: 0 },
    memory: { workingSetSize: 100_000 },
  };
  const flags = { foreground: false, pinned: false, registered: true };
  const notifyEvict = vi.fn();
  const notifyKillNotice = vi.fn();
  const notifyCpuAlert = vi.fn();
  const deps: ResourceWatchdogDeps = {
    listTabs: () => (flags.registered ? [{ tabId: 't1', webContentsId: 7 }] : []),
    isPinned: () => flags.pinned,
    isForeground: () => flags.foreground,
    lookupWebContents: (id) => (id === 7 ? guest : null),
    getMetrics: () => [metric],
    notifyEvict,
    notifyKillNotice,
    notifyCpuAlert,
    logger: { info: vi.fn(), warn: vi.fn() },
  };
  return {
    watchdog: new BrowserGuestResourceWatchdog(deps),
    guest,
    metric,
    flags,
    notifyEvict,
    notifyKillNotice,
    notifyCpuAlert,
  };
}

describe('BrowserGuestResourceWatchdog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('evicts a background guest immediately when memory exceeds the threshold', () => {
    const h = makeHarness();
    h.metric.memory.workingSetSize = BG_MEMORY_EVICT_KB;
    h.watchdog.tick();
    expect(h.notifyEvict).toHaveBeenCalledTimes(1);
    expect(h.notifyEvict).toHaveBeenCalledWith('t1');
    expect(h.guest.crashed).toBe(false);
  });

  it('evicts a background guest only after sustained high CPU strikes', () => {
    const h = makeHarness();
    h.metric.cpu.percentCPUUsage = BG_CPU_PERCENT + 10;
    for (let i = 0; i < BG_CPU_EVICT_STRIKES - 1; i += 1) {
      h.watchdog.tick();
    }
    expect(h.notifyEvict).not.toHaveBeenCalled();
    h.watchdog.tick();
    expect(h.notifyEvict).toHaveBeenCalledTimes(1);
  });

  it('a low-CPU sample resets the background strike counter', () => {
    const h = makeHarness();
    h.metric.cpu.percentCPUUsage = BG_CPU_PERCENT + 10;
    for (let i = 0; i < BG_CPU_EVICT_STRIKES - 1; i += 1) {
      h.watchdog.tick();
    }
    h.metric.cpu.percentCPUUsage = 5;
    h.watchdog.tick(); // 清零
    h.metric.cpu.percentCPUUsage = BG_CPU_PERCENT + 10;
    for (let i = 0; i < BG_CPU_EVICT_STRIKES - 1; i += 1) {
      h.watchdog.tick();
    }
    expect(h.notifyEvict).not.toHaveBeenCalled();
  });

  it('spares an audible background guest from CPU eviction but not memory eviction', () => {
    const h = makeHarness();
    h.guest.audible = true;
    h.metric.cpu.percentCPUUsage = 100;
    for (let i = 0; i < BG_CPU_EVICT_STRIKES * 2; i += 1) {
      h.watchdog.tick();
    }
    expect(h.notifyEvict).not.toHaveBeenCalled();
    h.metric.memory.workingSetSize = BG_MEMORY_EVICT_KB + 1;
    h.watchdog.tick();
    expect(h.notifyEvict).toHaveBeenCalledTimes(1);
  });

  it('exempts automation-pinned tabs from every action', () => {
    const h = makeHarness();
    h.flags.pinned = true;
    h.metric.cpu.percentCPUUsage = 100;
    h.metric.memory.workingSetSize = FG_MEMORY_KILL_KB * 2;
    for (let i = 0; i < BG_CPU_EVICT_STRIKES * 2; i += 1) {
      h.watchdog.tick();
    }
    expect(h.notifyEvict).not.toHaveBeenCalled();
    expect(h.notifyKillNotice).not.toHaveBeenCalled();
    expect(h.guest.crashed).toBe(false);
  });

  it('kills a foreground guest over the memory hard limit, notice first', () => {
    const h = makeHarness();
    h.flags.foreground = true;
    h.metric.memory.workingSetSize = FG_MEMORY_KILL_KB;
    h.watchdog.tick();
    expect(h.notifyKillNotice).toHaveBeenCalledWith('t1');
    expect(h.guest.crashed).toBe(true);
    expect(h.notifyEvict).not.toHaveBeenCalled();
  });

  it('does NOT kill a foreground guest below the memory hard limit', () => {
    const h = makeHarness();
    h.flags.foreground = true;
    // 后台早就该淘汰的量,前台必须容忍。
    h.metric.memory.workingSetSize = BG_MEMORY_EVICT_KB + 1;
    h.watchdog.tick();
    expect(h.guest.crashed).toBe(false);
    expect(h.notifyEvict).not.toHaveBeenCalled();
  });

  it('alerts (not kills) on sustained foreground CPU, then cools down', () => {
    const h = makeHarness();
    h.flags.foreground = true;
    h.metric.cpu.percentCPUUsage = FG_CPU_PERCENT + 5;
    for (let i = 0; i < FG_CPU_ALERT_STRIKES; i += 1) {
      h.watchdog.tick();
    }
    expect(h.notifyCpuAlert).toHaveBeenCalledTimes(1);
    expect(h.notifyCpuAlert).toHaveBeenCalledWith('t1', FG_CPU_PERCENT + 5);
    expect(h.guest.crashed).toBe(false);

    // 冷却期内即便持续高 CPU 也不重复告警。
    for (let i = 0; i < FG_CPU_ALERT_COOLDOWN_TICKS - 1; i += 1) {
      h.watchdog.tick();
    }
    expect(h.notifyCpuAlert).toHaveBeenCalledTimes(1);

    // 冷却结束 + 再次连击 → 第二次告警。
    for (let i = 0; i < FG_CPU_ALERT_STRIKES + 1; i += 1) {
      h.watchdog.tick();
    }
    expect(h.notifyCpuAlert).toHaveBeenCalledTimes(2);
  });

  it('foreground/background transition resets the other side strike counter', () => {
    const h = makeHarness();
    // 后台攒 strikes 差一次就淘汰,切前台后回到后台需要重新累计。
    h.metric.cpu.percentCPUUsage = BG_CPU_PERCENT + 10;
    for (let i = 0; i < BG_CPU_EVICT_STRIKES - 1; i += 1) {
      h.watchdog.tick();
    }
    h.flags.foreground = true;
    h.watchdog.tick();
    h.flags.foreground = false;
    for (let i = 0; i < BG_CPU_EVICT_STRIKES - 1; i += 1) {
      h.watchdog.tick();
    }
    expect(h.notifyEvict).not.toHaveBeenCalled();
    h.watchdog.tick();
    expect(h.notifyEvict).toHaveBeenCalledTimes(1);
  });

  it('drops stale per-tab state when the tab is no longer registered', () => {
    const h = makeHarness();
    h.metric.cpu.percentCPUUsage = BG_CPU_PERCENT + 10;
    h.watchdog.tick();
    h.flags.registered = false;
    h.watchdog.tick(); // listTabs 为空 → states 清空,不抛
    h.flags.registered = true;
    for (let i = 0; i < BG_CPU_EVICT_STRIKES - 1; i += 1) {
      h.watchdog.tick();
    }
    expect(h.notifyEvict).not.toHaveBeenCalled();
  });

  it('skips destroyed guests and survives metrics collection failure', () => {
    const h = makeHarness();
    h.guest.destroyed = true;
    h.metric.memory.workingSetSize = FG_MEMORY_KILL_KB * 2;
    expect(() => h.watchdog.tick()).not.toThrow();
    expect(h.notifyEvict).not.toHaveBeenCalled();

    const throwingDeps: ResourceWatchdogDeps = {
      listTabs: () => [{ tabId: 't1', webContentsId: 7 }],
      isPinned: () => false,
      isForeground: () => false,
      lookupWebContents: () => makeGuest(1),
      getMetrics: () => {
        throw new Error('metrics boom');
      },
      notifyEvict: vi.fn(),
      notifyKillNotice: vi.fn(),
      notifyCpuAlert: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
    };
    expect(() => new BrowserGuestResourceWatchdog(throwingDeps).tick()).not.toThrow();
  });
});

describe('ForegroundTabTracker', () => {
  it('tracks per-sender foreground claims and clears on null / drop', () => {
    const tracker = new ForegroundTabTracker();
    expect(tracker.isForeground('a')).toBe(false);

    tracker.set(1, 'a');
    tracker.set(2, 'b');
    expect(tracker.isForeground('a')).toBe(true);
    expect(tracker.isForeground('b')).toBe(true);

    // 同一 sender 的新声明覆盖旧声明。
    tracker.set(1, 'c');
    expect(tracker.isForeground('a')).toBe(false);
    expect(tracker.isForeground('c')).toBe(true);

    tracker.set(2, null);
    expect(tracker.isForeground('b')).toBe(false);

    tracker.drop(1);
    expect(tracker.isForeground('c')).toBe(false);
  });
});
