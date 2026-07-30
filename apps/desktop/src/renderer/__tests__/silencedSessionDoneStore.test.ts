import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearCompletedSchedulerOwnedRunForNewActivity,
  clearSchedulerOwnedRun,
  clearCompletedSilencedRunForNewActivity,
  clearSilencedRun,
  getScheduleRunSessionAttentionBaseline,
  getSilencedRunSessionIdForAttentionFallback,
  isSessionTerminalNotificationOwnedByScheduler,
  isSessionDoneSilenced,
  markNextSessionTerminalNotificationOwnedByScheduler,
  markNextSessionDoneSilenced,
  MARKER_TERMINAL_LINGER_MS,
  reconcileRunMarkers,
  rememberScheduleRunSessionAttentionBaseline,
  resetSilencedSessionDoneStoreForTests,
  scheduleClearSchedulerOwnedRun,
  scheduleClearSilencedRun,
} from '@/lib/silencedSessionDoneStore';

describe('silencedSessionDoneStore', () => {
  beforeEach(() => {
    resetSilencedSessionDoneStoreForTests();
  });

  it('suppresses every done transition while the run is still in flight', () => {
    markNextSessionDoneSilenced('run-1', 'session-1');

    expect(isSessionDoneSilenced('session-1')).toBe(true);
    clearSilencedRun('run-1');
    expect(isSessionDoneSilenced('session-1')).toBe(false);
  });

  it('clears a silenced run after failure/defer without suppressing a later done', () => {
    markNextSessionDoneSilenced('run-1', 'session-1');

    expect(clearSilencedRun('run-1')).toBe('session-1');
    expect(isSessionDoneSilenced('session-1')).toBe(false);
  });

  it('replaces older pending silence for the same session', () => {
    markNextSessionDoneSilenced('run-1', 'session-1');
    markNextSessionDoneSilenced('run-2', 'session-1');

    expect(clearSilencedRun('run-1')).toBeUndefined();
    expect(getSilencedRunSessionIdForAttentionFallback('run-1')).toBeUndefined();
    expect(isSessionDoneSilenced('session-1')).toBe(true);
    expect(clearSilencedRun('run-2')).toBe('session-1');
  });

  it('lets multiple hook instances observe the same silenced done before cleanup', () => {
    markNextSessionDoneSilenced('run-1', 'session-1');

    expect(isSessionDoneSilenced('session-1')).toBe(true);
    expect(isSessionDoneSilenced('session-1')).toBe(true);
    clearSilencedRun('run-1');
    expect(isSessionDoneSilenced('session-1')).toBe(false);
  });

  it('allows attention fallback only when the session had no prior attention', () => {
    markNextSessionDoneSilenced('run-1', 'session-1', false);
    markNextSessionDoneSilenced('run-2', 'session-2', true);

    expect(getSilencedRunSessionIdForAttentionFallback('run-1')).toBe('session-1');
    expect(getSilencedRunSessionIdForAttentionFallback('run-2')).toBeUndefined();
  });

  it('clears completed silenced markers when later activity starts', () => {
    markNextSessionDoneSilenced('run-1', 'session-1');
    scheduleClearSilencedRun('run-1', 2000);

    clearCompletedSilencedRunForNewActivity('session-1');

    expect(isSessionDoneSilenced('session-1')).toBe(false);
  });

  it('does not clear an in-flight silenced run before completed linger starts', () => {
    markNextSessionDoneSilenced('run-1', 'session-1');

    clearCompletedSilencedRunForNewActivity('session-1');

    expect(isSessionDoneSilenced('session-1')).toBe(true);
  });

  it('tracks and clears run attention baselines', () => {
    rememberScheduleRunSessionAttentionBaseline('run-1', 'session-1', true);

    expect(getScheduleRunSessionAttentionBaseline('run-1')).toEqual({
      sessionId: 'session-1',
      hadSessionAttention: true,
    });
    expect(clearSilencedRun('run-1')).toBeUndefined();
    expect(getScheduleRunSessionAttentionBaseline('run-1')).toBeUndefined();
  });

  it('tracks scheduler notification ownership separately from full silence', () => {
    markNextSessionTerminalNotificationOwnedByScheduler('run-owned', 'session-owned');

    expect(isSessionDoneSilenced('session-owned')).toBe(false);
    expect(isSessionTerminalNotificationOwnedByScheduler('session-owned')).toBe(true);
    expect(clearSchedulerOwnedRun('run-owned')).toBe('session-owned');
    expect(isSessionTerminalNotificationOwnedByScheduler('session-owned')).toBe(false);
  });

  it('clears completed scheduler ownership before a later ordinary turn', () => {
    markNextSessionTerminalNotificationOwnedByScheduler('run-owned', 'session-owned');
    scheduleClearSchedulerOwnedRun('run-owned', 2000);

    clearCompletedSchedulerOwnedRunForNewActivity('session-owned');

    expect(isSessionTerminalNotificationOwnedByScheduler('session-owned')).toBe(false);
  });

  it('clears the attention baseline of a run replaced by a newer one', () => {
    // 被顶替的 run 之后不会再有人调 clearSilencedRun(scheduleClearSilencedRun 的
    // has 检查会直接 return),baseline 必须在顶替时就清掉,否则随 session 复用无界增长。
    rememberScheduleRunSessionAttentionBaseline('run-1', 'session-1', true);
    markNextSessionDoneSilenced('run-1', 'session-1', true);

    markNextSessionDoneSilenced('run-2', 'session-1', false);

    expect(getScheduleRunSessionAttentionBaseline('run-1')).toBeUndefined();
  });

  /**
   * 回归:一个 run 内 running→done 会翻转多次(后台 subagent 完成后续 turn、
   * silent-stop 守卫自动续跑)。标记以前被第一次中间 done 消费掉,最终那次真 done
   * 就走了普通完成路径,把 macOS toast / 飞书 / 手机推送全发一遍。
   */
  describe('multi-turn run (regression: silenced automation leaked a system push)', () => {
    it('keeps suppressing after an intermediate done and a resumed turn', () => {
      markNextSessionDoneSilenced('run-1', 'session-1');

      // 主 turn done —— 只是中间态,runner 仍在等在途 subagent。
      expect(isSessionDoneSilenced('session-1')).toBe(true);
      // subagent 完成 → SDK 自动续 turn。
      clearCompletedSilencedRunForNewActivity('session-1');
      // 最终 done 必须仍然静默。
      expect(isSessionDoneSilenced('session-1')).toBe(true);
    });

    it('keeps scheduler notification ownership across the same multi-turn shape', () => {
      markNextSessionTerminalNotificationOwnedByScheduler('run-1', 'session-1');

      expect(isSessionTerminalNotificationOwnedByScheduler('session-1')).toBe(true);
      clearCompletedSchedulerOwnedRunForNewActivity('session-1');
      // 漏了这条会变成 renderer + scheduler notifier 各发一条,用户收到两次通知。
      expect(isSessionTerminalNotificationOwnedByScheduler('session-1')).toBe(true);
    });
  });

  /**
   * 事件丢失的自愈:靠 scheduler 落库的权威 run 状态对账,而不是任何定时器。
   * 三种「猜 run 还在不在飞行」的判据(事件序 / renderer running 快照 / 固定时长)
   * 都被证明会误判,详见 store 的文件头注释。
   */
  describe('reconciliation against authoritative run status', () => {
    /**
     * 回归(codex review P1):对账清除必须走同一段 linger,不能立即删。终态事件丢了的
     * 标记从未排过 linger,而 DB 可能已报终态、React 却还没处理该 session 的
     * running→done —— 立刻删会让那次 transition 看不到标记、发出不该发的通知。
     */
    it('lets terminal markers linger so a pending done transition still sees them', () => {
      vi.useFakeTimers();
      try {
        markNextSessionDoneSilenced('run-s', 'session-silenced');
        markNextSessionTerminalNotificationOwnedByScheduler('run-o', 'session-owned');

        reconcileRunMarkers(
          new Map([
            ['run-s', 'terminal' as const],
            ['run-o', 'terminal' as const],
          ]),
          new Set(),
        );

        // 对账当拍不删:还在 linger 窗口内,pending 的 done transition 仍看得到标记。
        expect(isSessionDoneSilenced('session-silenced')).toBe(true);
        expect(isSessionTerminalNotificationOwnedByScheduler('session-owned')).toBe(true);

        vi.advanceTimersByTime(MARKER_TERMINAL_LINGER_MS + 1);

        expect(isSessionDoneSilenced('session-silenced')).toBe(false);
        expect(isSessionTerminalNotificationOwnedByScheduler('session-owned')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * 关键:run 仍在飞行时绝不能清。这覆盖了 renderer running 快照不可信的那些
     * 情形 —— remote_agent / local_bash / 未知 task_type 的后台任务在跑时快照
     * 刻意为 false,device-link 远程会话整体豁免;runner 的 10 分钟兜底也只是事件
     * 静默超时、不是最大 run 时长,所以 run 可以合法飞行任意长。
     */
    it('keeps markers whose run is still in flight, however long it runs', () => {
      markNextSessionDoneSilenced('run-s', 'session-silenced');
      markNextSessionTerminalNotificationOwnedByScheduler('run-o', 'session-owned');

      reconcileRunMarkers(
        new Map([
          ['run-s', 'running' as const],
          ['run-o', 'running' as const],
        ]),
        new Set(['run-s', 'run-o']),
      );

      expect(isSessionDoneSilenced('session-silenced')).toBe(true);
      expect(isSessionTerminalNotificationOwnedByScheduler('session-owned')).toBe(true);
    });

    /**
     * 回归(codex review P1):run 被删除而不是落终态时,它永远不会出现在权威快照里
     * —— 删除 schedule 会级联删掉 schedule_runs 行,deferred run 也会被显式删除。
     * 若对应的 failed / deferred 事件正好丢了(对账要治的正是事件丢失),「不在快照里
     * 就保持」会让标记永久残留。
     */
    /**
     * 回归(codex review P1):自删除场景 —— agent 在任务 run 内调 schedule_delete 删掉
     * 自己的 schedule,引擎用 exemptRunId 豁免 caller run 不 abort,它的 run 行随 schedule
     * 级联删除后仍继续跑到底(通常还要产出最终回复)。此时「不在 DB 快照里」不等于
     * 「跑完了」,调用方会把引擎的 in-flight 快照覆盖成 running,标记必须保住 —— 否则
     * 最终 done 又会漏出通知。这正是心跳类任务的标准收口路径。
     */
    it('keeps a marker for a self-deleting run that is gone from the DB but still in flight', () => {
      vi.useFakeTimers();
      try {
        markNextSessionDoneSilenced('run-self-delete', 'session-1');

        // DB 里已无此 run(行随 schedule 级联删除),但引擎报它仍 in-flight。
        reconcileRunMarkers(new Map(), new Set(['run-self-delete']));
        vi.advanceTimersByTime(MARKER_TERMINAL_LINGER_MS * 3);

        expect(isSessionDoneSilenced('session-1')).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * 回归(codex review P1):两份读之间隔着 DB 查询的 await,run 恰好在那个窗口内结束时
     * DB 行还是 running、controller 已注销。本轮只能保守保持标记(无法区分它是否真的还在
     * 跑),但必须报告 needsRecheck —— 否则若该 run 的终态事件正是丢掉的那个,就再没有信号
     * 来清这个标记,自愈保证被打破。
     */
    it('reports needsRecheck when the DB says running but the engine does not', () => {
      vi.useFakeTimers();
      try {
        markNextSessionDoneSilenced('run-racing', 'session-1');

        const result = reconcileRunMarkers(
          new Map([['run-racing', 'running' as const]]),
          new Set(),
        );

        expect(result.needsRecheck).toBe(true);
        // 保守保持,不清。
        vi.advanceTimersByTime(MARKER_TERMINAL_LINGER_MS * 3);
        expect(isSessionDoneSilenced('session-1')).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not report needsRecheck when both reads agree', () => {
      markNextSessionDoneSilenced('run-live', 'session-1');
      markNextSessionTerminalNotificationOwnedByScheduler('run-done', 'session-2');

      const result = reconcileRunMarkers(
        new Map([
          ['run-live', 'running' as const],
          ['run-done', 'terminal' as const],
        ]),
        new Set(['run-live']),
      );

      expect(result.needsRecheck).toBe(false);
    });

    it('clears markers whose run no longer exists in the snapshot', () => {
      vi.useFakeTimers();
      try {
        markNextSessionDoneSilenced('run-deleted', 'session-silenced');
        markNextSessionTerminalNotificationOwnedByScheduler('run-gone', 'session-owned');

        // 快照非空,但完全不含这两个 run —— 它们已经被删掉了。
        reconcileRunMarkers(
          new Map([['some-live-run', 'running' as const]]),
          new Set(['some-live-run']),
        );
        vi.advanceTimersByTime(MARKER_TERMINAL_LINGER_MS + 1);

        expect(isSessionDoneSilenced('session-silenced')).toBe(false);
        expect(isSessionTerminalNotificationOwnedByScheduler('session-owned')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * 回归(codex + greptile review P1):权威查询在库里没有匹配行时**合法**返回空数组
     * (删掉最后一个 schedule、或唯一的 run 被 defer 后删除),查询失败走的是 reject +
     * 调用方 catch,不会以空映射到这里。早先那个「空映射当异常整体跳过」的守卫会把这种
     * 情况下的标记永久留住。
     */
    it('reconciles absent runs even when the snapshot is legitimately empty', () => {
      vi.useFakeTimers();
      try {
        markNextSessionDoneSilenced('run-deleted', 'session-silenced');
        markNextSessionTerminalNotificationOwnedByScheduler('run-gone', 'session-owned');

        reconcileRunMarkers(new Map(), new Set());
        vi.advanceTimersByTime(MARKER_TERMINAL_LINGER_MS + 1);

        expect(isSessionDoneSilenced('session-silenced')).toBe(false);
        expect(isSessionTerminalNotificationOwnedByScheduler('session-owned')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * completed 已到达并排了 linger 时,对账不能抢在 linger 前面清 —— 那段 linger
     * 正是留给 renderer 的 done transition 消费标记用的,提前清掉这次终态又会走
     * 普通通知路径。
     */
    it('defers to a pending completed linger instead of clearing early', () => {
      vi.useFakeTimers();
      try {
        markNextSessionDoneSilenced('run-s', 'session-silenced');
        markNextSessionTerminalNotificationOwnedByScheduler('run-o', 'session-owned');
        scheduleClearSilencedRun('run-s', 2000);
        scheduleClearSchedulerOwnedRun('run-o', 2000);

        // run 确实已终态,但 linger 在跑 → 本轮对账必须放过。
        reconcileRunMarkers(
          new Map([
            ['run-s', 'terminal' as const],
            ['run-o', 'terminal' as const],
          ]),
          new Set(),
        );
        expect(isSessionDoneSilenced('session-silenced')).toBe(true);
        expect(isSessionTerminalNotificationOwnedByScheduler('session-owned')).toBe(true);

        vi.advanceTimersByTime(2001);
        expect(isSessionDoneSilenced('session-silenced')).toBe(false);
        expect(isSessionTerminalNotificationOwnedByScheduler('session-owned')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves an unrelated session untouched', () => {
      markNextSessionDoneSilenced('run-a', 'session-a');
      markNextSessionDoneSilenced('run-b', 'session-b');

      vi.useFakeTimers();
      try {
        reconcileRunMarkers(
          new Map([
            ['run-a', 'terminal' as const],
            ['run-b', 'running' as const],
          ]),
          new Set(['run-b']),
        );
        vi.advanceTimersByTime(MARKER_TERMINAL_LINGER_MS + 1);

        expect(isSessionDoneSilenced('session-a')).toBe(false);
        expect(isSessionDoneSilenced('session-b')).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
