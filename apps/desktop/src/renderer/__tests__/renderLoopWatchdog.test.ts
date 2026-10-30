/**
 * renderLoopWatchdog.test.ts
 * ---------------------------------------------------------------------------
 * 渲染循环看门狗(睡醒白屏取证)的行为测试。全部通过注入面用假 timer / 假 rAF /
 * 假 visibilityState 驱动,不需要真实 DOM 帧管线。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => loggerMock,
}));

import {
  installRenderLoopWatchdog,
  type RenderLoopWatchdogTarget,
} from '../lib/renderLoopWatchdog';

/** 手动推进的假环境:timer 按注册顺序显式触发,rAF 回调显式派发。 */
function createHarness(initialVisibility: DocumentVisibilityState = 'visible') {
  let nowMs = 0;
  let visibility: DocumentVisibilityState = initialVisibility;

  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, () => void>();
  const rafs = new Map<number, FrameRequestCallback>();
  const visibilityListeners = new Set<() => void>();
  const nativeHiddenListeners = new Set<(hidden: boolean) => void>();
  let nextHandle = 1;

  const target: RenderLoopWatchdogTarget = {
    document: {
      addEventListener: (type: string, cb: EventListenerOrEventListenerObject) => {
        if (type === 'visibilitychange') visibilityListeners.add(cb as () => void);
      },
      removeEventListener: (type: string, cb: EventListenerOrEventListenerObject) => {
        if (type === 'visibilitychange') visibilityListeners.delete(cb as () => void);
      },
      get visibilityState() {
        return visibility;
      },
    },
    window: {
      electronAPI: {
        onWindowHiddenChange: (cb) => {
          nativeHiddenListeners.add(cb);
          return () => nativeHiddenListeners.delete(cb);
        },
      },
      setInterval: ((cb: () => void) => {
        const id = nextHandle++;
        intervals.set(id, cb);
        return id;
      }) as unknown as Window['setInterval'],
      clearInterval: ((id: number) => {
        intervals.delete(id);
      }) as unknown as Window['clearInterval'],
      setTimeout: ((cb: () => void) => {
        const id = nextHandle++;
        timeouts.set(id, cb);
        return id;
      }) as unknown as Window['setTimeout'],
      clearTimeout: ((id: number) => {
        timeouts.delete(id);
      }) as unknown as Window['clearTimeout'],
      requestAnimationFrame: (cb: FrameRequestCallback) => {
        const id = nextHandle++;
        rafs.set(id, cb);
        return id;
      },
      cancelAnimationFrame: (id: number) => {
        rafs.delete(id);
      },
    },
    now: () => nowMs,
  };

  return {
    target,
    advance(ms: number) {
      nowMs += ms;
    },
    setVisibility(v: DocumentVisibilityState) {
      visibility = v;
      for (const cb of [...visibilityListeners]) cb();
    },
    setNativeHidden(hidden: boolean) {
      for (const cb of nativeHiddenListeners) cb(hidden);
    },
    nativeListenerCount: () => nativeHiddenListeners.size,
    fireInterval() {
      for (const cb of [...intervals.values()]) cb();
    },
    /** 派发所有 pending rAF 回调(模拟合成器出帧)。 */
    flushFrames() {
      const cbs = [...rafs.values()];
      rafs.clear();
      for (const cb of cbs) cb(nowMs);
    },
    /** 触发所有 pending timeout(模拟探针超时到点)。 */
    flushTimeouts() {
      const cbs = [...timeouts.values()];
      timeouts.clear();
      for (const cb of cbs) cb();
    },
    pendingRafCount: () => rafs.size,
    pendingTimeoutCount: () => timeouts.size,
    pendingIntervalCount: () => intervals.size,
  };
}

describe('renderLoopWatchdog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('正常出帧时不产生任何日志', () => {
    const h = createHarness();
    const dispose = installRenderLoopWatchdog(h.target);

    h.advance(5_000);
    h.fireInterval();
    h.flushFrames();
    h.advance(5_000);
    h.fireInterval();
    h.flushFrames();

    expect(loggerMock.warn).not.toHaveBeenCalled();
    dispose();
  });

  it('可见状态下定时器漂移超阈值时记主线程阻塞日志', () => {
    const h = createHarness();
    const dispose = installRenderLoopWatchdog(h.target);

    // 期望 5s 一 tick,实际 12s 才触发 → 漂移 7s
    h.advance(12_000);
    h.fireInterval();

    expect(loggerMock.warn).toHaveBeenCalledWith(
      'renderer 定时器漂移(主线程曾阻塞或系统睡眠)',
      expect.objectContaining({ driftMs: 7_000 }),
    );
    dispose();
  });

  it('隐藏期漂移不告警(后台节流是预期行为)', () => {
    const h = createHarness('hidden');
    const dispose = installRenderLoopWatchdog(h.target);

    h.advance(60_000); // 模拟 intensive throttling 下 1 分钟才 tick 一次
    h.fireInterval();

    expect(loggerMock.warn).not.toHaveBeenCalled();
    dispose();
  });

  it('转入可见后的第一个 tick 不判漂移,第二个 tick 起恢复判定', () => {
    const h = createHarness('hidden');
    const dispose = installRenderLoopWatchdog(h.target);

    h.advance(60_000);
    h.setVisibility('visible'); // 重置漂移基准 + 跳过下个 tick
    h.flushFrames(); // 可见探针正常出帧,不产生停摆告警
    h.advance(55_000); // 节流期排下的 tick 姗姗来迟
    h.fireInterval();
    expect(loggerMock.warn).not.toHaveBeenCalled();

    // 下一个 tick 恢复正常判定:再卡 10s 应告警
    h.advance(15_000);
    h.fireInterval();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'renderer 定时器漂移(主线程曾阻塞或系统睡眠)',
      expect.objectContaining({ driftMs: 10_000 }),
    );
    dispose();
  });

  it('可见状态下探针超时记「无帧输出」,恢复出帧时记恢复及停摆时长', () => {
    const h = createHarness();
    const dispose = installRenderLoopWatchdog(h.target);

    h.advance(5_000);
    h.fireInterval(); // 发出探针
    h.advance(2_000);
    h.flushTimeouts(); // 探针超时,帧一直没来

    expect(loggerMock.warn).toHaveBeenCalledWith(
      '可见状态下动画帧探针超时',
      expect.objectContaining({ probeTimeoutMs: 2_000 }),
    );

    // 停摆期间再 tick 不重复报警(episode 去重)
    loggerMock.warn.mockClear();
    h.advance(5_000);
    h.fireInterval();
    expect(loggerMock.warn).not.toHaveBeenCalled();

    // 帧恢复 → 记恢复,带停摆时长(从探针发出时刻起算)
    h.advance(3_000);
    h.flushFrames();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      '动画帧回调恢复',
      expect.objectContaining({ stalledDurationMs: expect.any(Number) }),
    );
    dispose();
  });

  it('探针悬空期间页面转入隐藏则不报警', () => {
    const h = createHarness();
    const dispose = installRenderLoopWatchdog(h.target);

    h.advance(5_000);
    h.fireInterval(); // 发出探针
    h.setVisibility('hidden'); // 隐藏会取消探针
    h.advance(2_000);
    h.flushTimeouts();

    expect(loggerMock.warn).not.toHaveBeenCalled();
    dispose();
  });

  it('切回可见时立即发探针,不等下个 tick', () => {
    const h = createHarness('hidden');
    const dispose = installRenderLoopWatchdog(h.target);

    expect(h.pendingRafCount()).toBe(0);
    h.setVisibility('visible');
    expect(h.pendingRafCount()).toBe(1);
    dispose();
  });

  it('dispose 清理 interval、探针与事件监听', () => {
    const h = createHarness();
    const dispose = installRenderLoopWatchdog(h.target);
    h.advance(5_000);
    h.fireInterval(); // 留下悬空探针

    dispose();
    expect(h.pendingIntervalCount()).toBe(0);
    expect(h.pendingRafCount()).toBe(0);
    expect(h.pendingTimeoutCount()).toBe(0);
    expect(h.nativeListenerCount()).toBe(0);
  });

  it('重复 install 会先卸载旧实例(disposer key 幂等)', () => {
    const h = createHarness();
    installRenderLoopWatchdog(h.target);
    installRenderLoopWatchdog(h.target);
    expect(h.pendingIntervalCount()).toBe(1);
    (
      h.target.window as { __xdtRenderLoopWatchdogDisposer?: () => void }
    ).__xdtRenderLoopWatchdogDisposer?.();
    expect(h.pendingIntervalCount()).toBe(0);
  });

  it('原生隐藏但网页仍 visible 时取消探针,隐藏期漂移不告警', () => {
    const h = createHarness();
    const dispose = installRenderLoopWatchdog(h.target);
    h.fireInterval();
    h.setNativeHidden(true);
    h.advance(60_000);
    h.flushTimeouts();
    h.fireInterval();
    expect(h.pendingRafCount()).toBe(0);
    expect(loggerMock.warn).not.toHaveBeenCalled();
    dispose();
  });

  it('原生恢复而网页没有 visibilitychange 时立即探测,跳过隐藏期漂移', () => {
    const h = createHarness();
    const dispose = installRenderLoopWatchdog(h.target);
    h.setNativeHidden(true);
    h.advance(60_000);
    h.setNativeHidden(false);
    expect(h.pendingRafCount()).toBe(1);
    h.advance(2_000);
    h.flushTimeouts();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      '可见状态下动画帧探针超时',
      expect.objectContaining({
        observedAt: 62_000,
        probeStartedAt: 60_000,
        documentVisibility: 'visible',
        nativeHidden: false,
        nativeStateReceivedAt: 60_000,
      }),
    );
    loggerMock.warn.mockClear();
    h.advance(55_000);
    h.fireInterval();
    expect(loggerMock.warn).not.toHaveBeenCalled();
    dispose();
  });

  it('原生显示不覆盖页面隐藏,页面显示也不覆盖原生隐藏', () => {
    const h = createHarness('hidden');
    const dispose = installRenderLoopWatchdog(h.target);
    h.setNativeHidden(false);
    expect(h.pendingRafCount()).toBe(0);
    h.setNativeHidden(true);
    h.setVisibility('visible');
    expect(h.pendingRafCount()).toBe(0);
    h.setNativeHidden(false);
    expect(h.pendingRafCount()).toBe(1);
    dispose();
  });

  it('停顿后原生隐藏终止旧 episode,恢复后不会误报旧探针恢复', () => {
    const h = createHarness();
    const dispose = installRenderLoopWatchdog(h.target);
    h.fireInterval();
    h.advance(2_000);
    h.flushTimeouts();
    loggerMock.warn.mockClear();
    h.setNativeHidden(true);
    h.setNativeHidden(false);
    h.flushFrames();
    expect(loggerMock.warn).not.toHaveBeenCalled();
    dispose();
  });

  it('隐藏时 HMR 重装保留原生状态且只保留一个监听', () => {
    const h = createHarness();
    installRenderLoopWatchdog(h.target);
    h.setNativeHidden(true);
    const dispose = installRenderLoopWatchdog(h.target);
    h.advance(60_000);
    h.fireInterval();
    expect(h.nativeListenerCount()).toBe(1);
    expect(h.pendingRafCount()).toBe(0);
    expect(loggerMock.warn).not.toHaveBeenCalled();
    dispose();
  });
});
