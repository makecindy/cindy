/**
 * foregroundRecoveryDiagnostics.test.ts
 * ---------------------------------------------------------------------------
 * focus / visibility 前台恢复诊断的纯函数测试。
 * 浏览器事件接线保持很薄,这里锁住可观察的快照和清理行为,
 * 不需要挂载完整 Electron renderer。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  captureForegroundRecoverySnapshot,
  clearPerformanceTimeline,
  disposeForegroundRecoveryDiagnostics,
  installForegroundRecoveryDiagnostics,
  installPerformanceTimelineCleanupInterval,
  shouldRunForegroundRecoveryCleanup,
  type PerformanceLike,
} from '../lib/foregroundRecoveryDiagnostics';

const rendererIndexSource = readFileSync(resolve(__dirname, '..', 'main-entry.tsx'), 'utf8').replace(/\r\n?/g, '\n');

describe('前台恢复诊断', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('清理性能时间线前会捕获 measure / mark 数量', () => {
    const perf: PerformanceLike = {
      now: () => 1234,
      getEntriesByType: (type) => (
        type === 'measure'
          ? [{ name: 'm1' }, { name: 'm2' }]
          : type === 'mark'
            ? [{ name: 'k1' }]
            : []
      ),
      clearMeasures: vi.fn(),
      clearMarks: vi.fn(),
    };

    expect(captureForegroundRecoverySnapshot(perf)).toEqual({
      nowMs: 1234,
      measureCount: 2,
      markCount: 1,
    });
  });

  it('会同时清理 mark 和 measure', () => {
    const perf: PerformanceLike = {
      now: () => 0,
      getEntriesByType: () => [],
      clearMeasures: vi.fn(),
      clearMarks: vi.fn(),
    };

    clearPerformanceTimeline(perf);

    expect(perf.clearMeasures).toHaveBeenCalledTimes(1);
    expect(perf.clearMarks).toHaveBeenCalledTimes(1);
  });

  it('普通 focus 不会触发恢复清理', () => {
    expect(
      shouldRunForegroundRecoveryCleanup(
        {
          nowMs: 100,
          measureCount: 2,
          markCount: 1,
        },
        false,
      ),
    ).toBe(false);
  });

  it('从隐藏状态恢复或时间线膨胀时才触发清理', () => {
    expect(
      shouldRunForegroundRecoveryCleanup(
        {
          nowMs: 100,
          measureCount: 2,
          markCount: 1,
        },
        true,
      ),
    ).toBe(true);

    expect(
      shouldRunForegroundRecoveryCleanup(
        {
          nowMs: 100,
          measureCount: 1_000,
          markCount: 0,
        },
        false,
      ),
    ).toBe(true);

    expect(
      shouldRunForegroundRecoveryCleanup(
        {
          nowMs: 100,
          measureCount: 0,
          markCount: 1_000,
        },
        false,
      ),
    ).toBe(true);
  });

  it('dev-only 性能时间线定时清理会防重并返回 HMR disposer', () => {
    const handlers = new Map<number, () => void>();
    const target = {
      __xdtPerformanceTimelineCleanupIntervalId: 7,
      setInterval: vi.fn((handler: () => void, timeout: number) => {
        expect(timeout).toBe(5_000);
        handlers.set(8, handler);
        return 8;
      }),
      clearInterval: vi.fn(),
    };
    const cleanup = vi.fn();

    const dispose = installPerformanceTimelineCleanupInterval(target, cleanup);

    expect(target.clearInterval).toHaveBeenCalledWith(7);
    expect(target.__xdtPerformanceTimelineCleanupIntervalId).toBe(8);

    handlers.get(8)?.();
    expect(cleanup).toHaveBeenCalledTimes(1);

    dispose();
    expect(target.clearInterval).toHaveBeenCalledWith(8);
    expect(target.__xdtPerformanceTimelineCleanupIntervalId).toBeUndefined();
  });

  it('renderer 入口会把前台恢复和性能时间线清理接到 HMR dispose', () => {
    expect(rendererIndexSource).toContain('installPerformanceTimelineCleanupInterval()');
    expect(rendererIndexSource).toContain('import.meta.hot?.dispose');
    expect(rendererIndexSource).toContain('disposeForegroundRecoveryDiagnostics();');
    expect(rendererIndexSource).toContain('disposePerformanceTimelineCleanupInterval();');
  });

  it('从隐藏状态恢复时会在清理前记录 performance timeline 数量', () => {
    let visibilityState: Document['visibilityState'] = 'visible';
    let nowMs = 0;
    let measureEntries: unknown[] = [{ name: 'm1' }, { name: 'm2' }];
    let markEntries: unknown[] = [{ name: 'k1' }];
    const documentListeners = new Map<string, EventListenerOrEventListenerObject>();
    const target = {
      document: {
        get visibilityState() {
          return visibilityState;
        },
        addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
          documentListeners.set(type, listener);
        }),
        removeEventListener: vi.fn(),
      },
      window: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      performance: {
        now: vi.fn(() => nowMs),
        getEntriesByType: vi.fn((type: string) => {
          if (type === 'measure') return measureEntries;
          if (type === 'mark') return markEntries;
          return [];
        }),
        clearMeasures: vi.fn(() => {
          measureEntries = [];
        }),
        clearMarks: vi.fn(() => {
          markEntries = [];
        }),
      },
    };

    const dispose = installForegroundRecoveryDiagnostics(target);
    visibilityState = 'hidden';
    nowMs = 100;
    callListener(documentListeners.get('visibilitychange'));

    visibilityState = 'visible';
    nowMs = 6_100;
    callListener(documentListeners.get('visibilitychange'));

    expect(target.performance.clearMeasures).toHaveBeenCalledTimes(1);
    expect(target.performance.clearMarks).toHaveBeenCalledTimes(1);
    expect(target.performance.getEntriesByType.mock.invocationCallOrder[0])
      .toBeLessThan(target.performance.clearMeasures.mock.invocationCallOrder[0]);
    expect(target.performance.clearMarks.mock.invocationCallOrder[0])
      .toBeLessThan(target.performance.getEntriesByType.mock.invocationCallOrder[2]);
    expect(loggerMock.info).toHaveBeenCalledWith('前台恢复清理', {
      reason: 'visible',
      hiddenDurationMs: 6_000,
      measureCountBefore: 2,
      markCountBefore: 1,
      measureCountAfter: 0,
      markCountAfter: 0,
    });

    dispose();
  });

  it('前台恢复事件监听会在重复 install 和 dispose 时清理', () => {
    const target = createForegroundRecoveryTarget();

    const firstDispose = installForegroundRecoveryDiagnostics(target);
    expect(target.document.addEventListener).toHaveBeenCalledTimes(1);
    expect(target.window.addEventListener).toHaveBeenCalledTimes(1);

    const secondDispose = installForegroundRecoveryDiagnostics(target);
    expect(target.document.removeEventListener).toHaveBeenCalledTimes(1);
    expect(target.window.removeEventListener).toHaveBeenCalledTimes(1);
    expect(target.document.addEventListener).toHaveBeenCalledTimes(2);
    expect(target.window.addEventListener).toHaveBeenCalledTimes(2);

    firstDispose();
    expect(target.document.removeEventListener).toHaveBeenCalledTimes(1);
    expect(target.window.removeEventListener).toHaveBeenCalledTimes(1);

    disposeForegroundRecoveryDiagnostics(target);
    expect(target.document.removeEventListener).toHaveBeenCalledTimes(2);
    expect(target.window.removeEventListener).toHaveBeenCalledTimes(2);

    secondDispose();
    expect(target.document.removeEventListener).toHaveBeenCalledTimes(2);
    expect(target.window.removeEventListener).toHaveBeenCalledTimes(2);
  });
});

function createForegroundRecoveryTarget() {
  return {
    document: {
      visibilityState: 'visible' as Document['visibilityState'],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    window: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    performance: {
      now: vi.fn(() => 0),
      getEntriesByType: vi.fn(() => []),
      clearMeasures: vi.fn(),
      clearMarks: vi.fn(),
    },
  };
}

function callListener(listener: EventListenerOrEventListenerObject | undefined): void {
  if (typeof listener === 'function') {
    listener(new Event('test'));
    return;
  }
  listener?.handleEvent(new Event('test'));
}
