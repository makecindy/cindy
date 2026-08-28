// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SchedulerEvent } from '@cindy/maker-scheduler';

import { useAutomationScheduleSessionIndex } from '@/features/cc-agent/hooks/useAutomationScheduleSessionIndex';
import {
  addSessionAttention,
  clearSessionAttentionMany,
  hasSessionAttention,
} from '@/lib/sessionAttentionStore';
import {
  isSessionTerminalNotificationOwnedByScheduler,
  isSessionDoneSilenced,
  MARKER_TERMINAL_LINGER_MS,
  markNextSessionDoneSilenced,
  markNextSessionTerminalNotificationOwnedByScheduler,
  resetSilencedSessionDoneStoreForTests,
} from '@/lib/silencedSessionDoneStore';

let scheduleEventListener: ((event: SchedulerEvent) => void) | null = null;

beforeEach(() => {
  scheduleEventListener = null;
  resetSilencedSessionDoneStoreForTests();
  vi.stubGlobal('electronAPI', {
    maker: {
      schedule: {
        listSidebarIndexRuns: vi.fn().mockReturnValue(new Promise(() => undefined)),
        onEvent: vi.fn((listener: (event: SchedulerEvent) => void) => {
          scheduleEventListener = listener;
          return () => {
            scheduleEventListener = null;
          };
        }),
      },
    },
    notificationMarkSessionAttention: vi.fn().mockResolvedValue(undefined),
    notificationClearSessionAttention: vi.fn().mockResolvedValue(undefined),
  });
});

afterEach(() => {
  clearSessionAttentionMany(['session-1']);
  resetSilencedSessionDoneStoreForTests();
  vi.unstubAllGlobals();
});

describe('useAutomationScheduleSessionIndex silence events', () => {
  it('marks a bound scheduler session as owning its terminal notification', () => {
    renderHook(() => useAutomationScheduleSessionIndex());

    act(() => {
      scheduleEventListener?.({
        type: 'session-bound',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
      });
    });

    expect(isSessionTerminalNotificationOwnedByScheduler('session-1')).toBe(true);
  });

  it('registers silenced runs without clearing older session attention', () => {
    addSessionAttention('session-1');
    renderHook(() => useAutomationScheduleSessionIndex());

    act(() => {
      scheduleEventListener?.({
        type: 'session-bound',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
      });
      scheduleEventListener?.({
        type: 'silenced',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
      });
      scheduleEventListener?.({
        type: 'completed',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
        silenced: true,
      });
    });

    expect(hasSessionAttention('session-1')).toBe(true);
    expect(isSessionDoneSilenced('session-1')).toBe(true);
  });

  it('clears silenced done suppression when the run requests notification', () => {
    renderHook(() => useAutomationScheduleSessionIndex());

    act(() => {
      scheduleEventListener?.({
        type: 'session-bound',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
      });
      scheduleEventListener?.({
        type: 'silenced',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
      });
      scheduleEventListener?.({
        type: 'notified',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
      });
    });

    expect(isSessionDoneSilenced('session-1')).toBe(false);
    expect(isSessionTerminalNotificationOwnedByScheduler('session-1')).toBe(true);
  });

  it('clears only attention that could have been created by the silenced run fallback', () => {
    renderHook(() => useAutomationScheduleSessionIndex());

    act(() => {
      scheduleEventListener?.({
        type: 'session-bound',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
      });
      scheduleEventListener?.({
        type: 'silenced',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
      });
      addSessionAttention('session-1');
      scheduleEventListener?.({
        type: 'completed',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
        silenced: true,
      });
    });

    expect(hasSessionAttention('session-1')).toBe(false);
  });

  it('uses completed sessionId when explicit runId silence had no early silenced event', () => {
    renderHook(() => useAutomationScheduleSessionIndex());

    act(() => {
      scheduleEventListener?.({
        type: 'session-bound',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
      });
      scheduleEventListener?.({
        type: 'completed',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
        silenced: true,
      });
    });

    expect(isSessionDoneSilenced('session-1')).toBe(true);
  });

  it('does not clear older attention when completed supplies the first silenced sessionId', () => {
    addSessionAttention('session-1');
    renderHook(() => useAutomationScheduleSessionIndex());

    act(() => {
      scheduleEventListener?.({
        type: 'session-bound',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
      });
      scheduleEventListener?.({
        type: 'completed',
        scheduleId: 'schedule-1',
        runId: 'run-1',
        sessionId: 'session-1',
        silenced: true,
      });
    });

    expect(hasSessionAttention('session-1')).toBe(true);
    expect(isSessionDoneSilenced('session-1')).toBe(true);
  });
});

/**
 * 事件丢失的自愈:refresh 拉到的 sidebar run 列表就是 scheduler 落库的权威状态
 * (且包含所有 running run),据它对账标记。
 * 刻意不用定时器猜 run 是否还在飞行 —— 三种判据(事件序 / renderer running 快照 /
 * 固定时长)都被证明会误判,见 silencedSessionDoneStore 的文件头注释。
 */
describe('useAutomationScheduleSessionIndex marker reconciliation', () => {
  function stubApiWithRuns(runs: unknown[], inflightRunIds: string[] = []): void {
    vi.stubGlobal('electronAPI', {
      maker: {
        schedule: {
          listSidebarIndexRuns: vi.fn().mockResolvedValue({ runs, inflightRunIds }),
          onEvent: vi.fn(() => () => undefined),
        },
      },
      notificationMarkSessionAttention: vi.fn().mockResolvedValue(undefined),
      notificationClearSessionAttention: vi.fn().mockResolvedValue(undefined),
    });
  }

  function indexRun(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      runId: 'run-x',
      scheduleId: 'schedule-1',
      scheduleName: '定时任务',
      scheduleStatus: 'active',
      sessionId: 'session-1',
      status: 'running',
      readAt: 1,
      ...overrides,
    };
  }

  it('keeps old unread ids while the latest row wins session ownership', async () => {
    stubApiWithRuns([
      indexRun({
        runId: 'run-old-unread',
        scheduleId: 'schedule-old',
        scheduleName: '旧自动化',
        status: 'failed',
        readAt: undefined,
        firedAt: 10,
      }),
      indexRun({
        runId: 'run-latest',
        scheduleId: 'schedule-latest',
        scheduleName: '最新自动化',
        status: 'success',
        readAt: 20,
        firedAt: 20,
      }),
    ]);

    const { result } = renderHook(() => useAutomationScheduleSessionIndex());
    await waitFor(() => {
      expect(result.current.get('session-1')).toMatchObject({
        scheduleId: 'schedule-latest',
        scheduleName: '最新自动化',
        unreadRunIds: ['run-old-unread'],
        unreadFailedRunIds: ['run-old-unread'],
        latestUnreadFailedRunId: 'run-old-unread',
      });
    });
  });

  it('clears markers whose run already reached a terminal status', async () => {
    vi.useFakeTimers();
    try {
      stubApiWithRuns([
        indexRun({ runId: 'run-lost', status: 'success' }),
      ]);
      // 标记建立后 completed / failed 事件都没送到(广播断链、或事件早于消费方挂载)。
      markNextSessionDoneSilenced('run-lost', 'session-1');
      markNextSessionTerminalNotificationOwnedByScheduler('run-lost', 'session-1');
      expect(isSessionDoneSilenced('session-1')).toBe(true);

      renderHook(() => useAutomationScheduleSessionIndex());
      await act(async () => {
        await Promise.resolve();
      });
      // 对账只排下 linger,窗口内标记仍在 —— 留给可能尚未处理的 done transition。
      expect(isSessionDoneSilenced('session-1')).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(MARKER_TERMINAL_LINGER_MS + 1);
      });

      expect(isSessionDoneSilenced('session-1')).toBe(false);
      expect(isSessionTerminalNotificationOwnedByScheduler('session-1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 回归(greptile review P1):这次拉取同时是标记对账的载体,失败路径原本只 log。
   * 「卸载期间丢终态事件 + 重新挂载时首次拉取 reject(scheduler 未 ready / 临时 IPC 或
   * DB 错误)+ 此后再无任何 scheduler / read-sync 事件」这条链上,标记会永久残留。
   */
  it('retries the reconciliation after a failed refresh', async () => {
    vi.useFakeTimers();
    try {
      const listSidebarIndexRuns = vi
        .fn()
        .mockRejectedValueOnce(new Error('scheduler not ready'))
        .mockResolvedValue({ runs: [indexRun({ runId: 'run-lost', status: 'success' })], inflightRunIds: [] });
      vi.stubGlobal('electronAPI', {
        maker: { schedule: { listSidebarIndexRuns, onEvent: vi.fn(() => () => undefined) } },
        notificationMarkSessionAttention: vi.fn().mockResolvedValue(undefined),
        notificationClearSessionAttention: vi.fn().mockResolvedValue(undefined),
      });
      markNextSessionDoneSilenced('run-lost', 'session-1');

      renderHook(() => useAutomationScheduleSessionIndex());
      // 首次拉取 reject —— 此时标记还留着，且不会再有 scheduler 事件来触发第二次。
      await act(async () => {
        await Promise.resolve();
      });
      expect(isSessionDoneSilenced('session-1')).toBe(true);

      // 退避重试到来，对账排下 linger；再等 linger 到点标记才真正退场。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MARKER_TERMINAL_LINGER_MS + 1);
      });

      expect(listSidebarIndexRuns).toHaveBeenCalledTimes(2);
      expect(isSessionDoneSilenced('session-1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 回归(greptile review P1):退避档位用尽后如果彻底停手,「scheduler / IPC / DB 连续
   * 不可用超过三档窗口 + 此后再无事件」就会让标记永久残留。仍有标记待对账时按最后一档
   * 持续重试。
   */
  it('keeps retrying past the backoff table while markers still await reconciliation', async () => {
    vi.useFakeTimers();
    try {
      const listSidebarIndexRuns = vi
        .fn()
        .mockRejectedValueOnce(new Error('e1'))
        .mockRejectedValueOnce(new Error('e2'))
        .mockRejectedValueOnce(new Error('e3'))
        .mockRejectedValueOnce(new Error('e4'))
        .mockResolvedValue({ runs: [indexRun({ runId: 'run-lost', status: 'success' })], inflightRunIds: [] });
      vi.stubGlobal('electronAPI', {
        maker: { schedule: { listSidebarIndexRuns, onEvent: vi.fn(() => () => undefined) } },
        notificationMarkSessionAttention: vi.fn().mockResolvedValue(undefined),
        notificationClearSessionAttention: vi.fn().mockResolvedValue(undefined),
      });
      markNextSessionDoneSilenced('run-lost', 'session-1');

      renderHook(() => useAutomationScheduleSessionIndex());
      await act(async () => {
        await Promise.resolve();
      });

      // 2s / 8s / 30s 三档全部失败后，第四次失败仍应排下一次（降频持续）。
      for (const delay of [2_000, 8_000, 30_000, 30_000]) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(delay);
        });
      }

      await act(async () => {
        await vi.advanceTimersByTimeAsync(MARKER_TERMINAL_LINGER_MS + 1);
      });

      expect(listSidebarIndexRuns).toHaveBeenCalledTimes(5);
      expect(isSessionDoneSilenced('session-1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 回归(codex review P1):自删除 run 的行已随 schedule 级联删除,DB 快照里查不到它,
   * 但引擎的 in-flight 快照说它还在跑 —— 标记必须保住。
   */
  it('keeps markers for a self-deleting run reported in-flight though absent from runs', async () => {
    vi.useFakeTimers();
    try {
      stubApiWithRuns([], ['run-self-delete']);
      markNextSessionDoneSilenced('run-self-delete', 'session-1');

      renderHook(() => useAutomationScheduleSessionIndex());
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MARKER_TERMINAL_LINGER_MS * 3);
      });

      expect(isSessionDoneSilenced('session-1')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 回归(codex review P1):DB 说 running、引擎的 in-flight 快照里却没有 —— 两份读之间那个
   * await 窗口里 run 刚好结束了。本轮保守保持标记,但必须自己排一次重查,否则若该 run 的
   * 终态事件正是丢掉的那个就再没信号来清它。下一轮 DB 已落终态,标记正常退场。
   */
  it('rechecks by itself when the two reads disagree, then clears on the next round', async () => {
    vi.useFakeTimers();
    try {
      const listSidebarIndexRuns = vi
        .fn()
        // 第一轮:行还是 running,但 controller 已注销 → 不一致。
        .mockResolvedValueOnce({
          runs: [indexRun({ runId: 'run-racing', status: 'running' })],
          inflightRunIds: [],
        })
        // 重查:DB 已落终态。
        .mockResolvedValue({
          runs: [indexRun({ runId: 'run-racing', status: 'success' })],
          inflightRunIds: [],
        });
      vi.stubGlobal('electronAPI', {
        maker: { schedule: { listSidebarIndexRuns, onEvent: vi.fn(() => () => undefined) } },
        notificationMarkSessionAttention: vi.fn().mockResolvedValue(undefined),
        notificationClearSessionAttention: vi.fn().mockResolvedValue(undefined),
      });
      markNextSessionDoneSilenced('run-racing', 'session-1');

      renderHook(() => useAutomationScheduleSessionIndex());
      await act(async () => {
        await Promise.resolve();
      });
      // 第一轮不清 —— 无法区分它是否真的还在跑。
      expect(isSessionDoneSilenced('session-1')).toBe(true);

      // 重查 + 退场 linger。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MARKER_TERMINAL_LINGER_MS + 1);
      });

      expect(listSidebarIndexRuns.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(isSessionDoneSilenced('session-1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * 回归(codex review P1):卸载时拉取仍 pending,它之后 reject(如撞上 scheduler readiness
   * 的 30s 超时)会走 catch 再排新定时器 —— cleanup 只清得掉「那一刻已存在」的定时器。有
   * 标记时退避耗尽后会每 30s 无限重试,拖着已卸载的 hook 持续发无用 IPC/DB 读。
   */
  it('does not schedule any retry after the hook unmounts', async () => {
    vi.useFakeTimers();
    try {
      let rejectPending!: (err: Error) => void;
      const listSidebarIndexRuns = vi.fn(
        () =>
          new Promise((_resolve, reject) => {
            rejectPending = reject;
          }),
      );
      vi.stubGlobal('electronAPI', {
        maker: { schedule: { listSidebarIndexRuns, onEvent: vi.fn(() => () => undefined) } },
        notificationMarkSessionAttention: vi.fn().mockResolvedValue(undefined),
        notificationClearSessionAttention: vi.fn().mockResolvedValue(undefined),
      });
      // 留一个标记：否则退避耗尽后本来就会停手，测不出问题。
      markNextSessionDoneSilenced('run-x', 'session-1');

      const { unmount } = renderHook(() => useAutomationScheduleSessionIndex());
      unmount();

      // 卸载之后 pending 的那次拉取才失败。
      await act(async () => {
        rejectPending(new Error('scheduler not ready'));
        await Promise.resolve();
      });
      // 远超所有退避档位：不该再有任何一次拉取。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });

      expect(listSidebarIndexRuns).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps markers whose run is still in flight', async () => {
    stubApiWithRuns([indexRun({ runId: 'run-live', status: 'running' })], ['run-live']);
    markNextSessionDoneSilenced('run-live', 'session-1');

    renderHook(() => useAutomationScheduleSessionIndex());
    // 等 refresh 落地后再断言，否则可能在对账发生前就通过。
    await waitFor(() => {
      expect(
        vi.mocked(window.electronAPI.maker.schedule.listSidebarIndexRuns),
      ).toHaveBeenCalled();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(isSessionDoneSilenced('session-1')).toBe(true);
  });
});
