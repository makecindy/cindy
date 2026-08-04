// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionStatusInfo } from '@/lib/makerChatStore';
import {
  isSessionDoneSilenced,
  markNextSessionTerminalNotificationOwnedByScheduler,
  markNextSessionDoneSilenced,
  resetSilencedSessionDoneStoreForTests,
  scheduleClearSchedulerOwnedRun,
  scheduleClearSilencedRun,
} from '@/lib/silencedSessionDoneStore';
import { useSessionRunningStatus } from '@/hooks/useSessionRunningStatus';
import { addSessionAttention, clearSessionAttention, getSessionAttentionKind } from '@/lib/sessionAttentionStore';

const storeMock = vi.hoisted(() => ({
  snapshot: new Map<string, SessionStatusInfo>(),
  listeners: new Set<() => void>(),
  terminalErrorSessions: new Set<string>(),
  sideTaskStopSessions: new Set<string>(),
}));

vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    subscribeAll: (listener: () => void) => {
      storeMock.listeners.add(listener);
      return () => {
        storeMock.listeners.delete(listener);
      };
    },
    getRunningSnapshot: () => storeMock.snapshot,
    hasSessionTerminalError: (sessionId: string) => storeMock.terminalErrorSessions.has(sessionId),
    wasLastStopSideTask: (sessionId: string) => storeMock.sideTaskStopSessions.has(sessionId),
  },
}));

vi.mock('@/lib/sessionAttentionStore', () => ({
  addSessionAttention: vi.fn(),
  clearSessionAttention: vi.fn(),
  getSessionAttentionKind: vi.fn(() => undefined),
  hasSessionAttention: vi.fn(() => false),
  useSessionAttentionSnapshot: () => new Set<string>(),
}));

function status(isRunning: boolean, hasError = false, sideTask?: boolean): SessionStatusInfo {
  return {
    isRunning,
    hasError,
    ...(sideTask !== undefined ? { sideTask } : {}),
    hasPendingAskUser: false,
    hasPendingPermission: false,
    hasPendingPlanReview: false,
    hasPendingPluginSetup: false,
  };
}

async function emitSnapshot(snapshot: ReadonlyMap<string, SessionStatusInfo>): Promise<void> {
  await act(async () => {
    storeMock.snapshot = new Map(snapshot);
    for (const listener of storeMock.listeners) listener();
  });
}

describe('useSessionRunningStatus silenced completion handling', () => {
  afterEach(() => {
    storeMock.snapshot = new Map();
    storeMock.listeners.clear();
    storeMock.terminalErrorSessions.clear();
    storeMock.sideTaskStopSessions.clear();
    resetSilencedSessionDoneStoreForTests();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does not mute a normal follow-up that starts during silenced completion linger', async () => {
    vi.useFakeTimers();
    const onSessionDone = vi.fn();
    markNextSessionDoneSilenced('run-1', 'session-1');
    scheduleClearSilencedRun('run-1', 2000);

    renderHook(() => useSessionRunningStatus(undefined, { onSessionDone }));

    await emitSnapshot(new Map([['session-1', status(true)]]));
    await emitSnapshot(new Map([['session-1', status(false)]]));
    // done 走 debounce,推进 500ms 让定时器 fire
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(onSessionDone).toHaveBeenCalledWith('session-1');
    vi.useRealTimers();
  });

  it('fires the error callback instead of the done callback when a running turn ends with error', async () => {
    const onSessionDone = vi.fn();
    const onSessionError = vi.fn();

    renderHook(() => useSessionRunningStatus(undefined, { onSessionDone, onSessionError }));

    await emitSnapshot(new Map([['session-err', status(true)]]));
    // error 是终态,立刻触发(不走 debounce)
    await emitSnapshot(new Map([['session-err', status(false, true)]]));

    expect(onSessionDone).not.toHaveBeenCalled();
    expect(onSessionError).toHaveBeenCalledWith('session-err');
  });

  it('keeps done attention but suppresses a scheduler-owned completion callback', async () => {
    vi.useFakeTimers();
    const onSessionDone = vi.fn();
    markNextSessionTerminalNotificationOwnedByScheduler('run-owned', 'session-owned');

    renderHook(() => useSessionRunningStatus(undefined, { onSessionDone }));

    await emitSnapshot(new Map([['session-owned', status(true)]]));
    await emitSnapshot(new Map([['session-owned', status(false)]]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(vi.mocked(addSessionAttention)).toHaveBeenCalledWith('session-owned', 'done');
    expect(onSessionDone).not.toHaveBeenCalled();
  });

  it('does not suppress a later ordinary turn once the scheduler run has completed', async () => {
    // run 终态之后同 session 的 turn 属于用户手动对话,照常通知。
    //
    // `completed` 是这条断言的**必要前提**,不是可省略的布景:run 仍在飞行时,
    // 「用户插话的 turn」和「后台 subagent 续 turn」在 renderer 侧是同一个信号
    // (running=true → done),无从区分。标记因此在 run 飞行期间对每次 done 都有效
    // (见文件末尾的 multi-turn 回归),run 终态后才交回普通通知路径 —— 判据就是
    // scheduler 的 completed/failed 事件排下的 linger 定时器。
    vi.useFakeTimers();
    const onSessionDone = vi.fn();
    markNextSessionTerminalNotificationOwnedByScheduler('run-owned', 'session-reused');

    renderHook(() => useSessionRunningStatus(undefined, { onSessionDone }));

    await emitSnapshot(new Map([['session-reused', status(true)]]));
    await emitSnapshot(new Map([['session-reused', status(false)]]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(onSessionDone).not.toHaveBeenCalled();

    // scheduler 发出 completed → 排 linger,标记进入「run 已终态」。
    scheduleClearSchedulerOwnedRun('run-owned', 2000);

    await emitSnapshot(new Map([['session-reused', status(true)]]));
    await emitSnapshot(new Map([['session-reused', status(false)]]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(onSessionDone).toHaveBeenCalledOnce();
    expect(onSessionDone).toHaveBeenCalledWith('session-reused');
  });

  it('keeps error attention but suppresses a scheduler-owned error callback', async () => {
    const onSessionError = vi.fn();
    markNextSessionTerminalNotificationOwnedByScheduler('run-owned-error', 'session-owned-error');

    renderHook(() => useSessionRunningStatus(undefined, { onSessionError }));

    await emitSnapshot(new Map([['session-owned-error', status(true)]]));
    await emitSnapshot(new Map([['session-owned-error', status(false, true)]]));

    expect(vi.mocked(addSessionAttention)).toHaveBeenCalledWith('session-owned-error', 'error');
    expect(onSessionError).not.toHaveBeenCalled();
  });

  it('fires the error callback even when a silenced completion is pending for the session', async () => {
    const onSessionDone = vi.fn();
    const onSessionError = vi.fn();
    markNextSessionDoneSilenced('run-err', 'session-silenced-err');
    scheduleClearSilencedRun('run-err', 2000);

    renderHook(() => useSessionRunningStatus(undefined, { onSessionDone, onSessionError }));

    await emitSnapshot(new Map([['session-silenced-err', status(true)]]));
    await emitSnapshot(new Map([['session-silenced-err', status(false, true)]]));

    expect(onSessionDone).not.toHaveBeenCalled();
    expect(onSessionError).toHaveBeenCalledWith('session-silenced-err');
  });

  // 回归:过渡条目只存活一代 snapshot,可能被另一个 useSyncExternalStore 订阅者
  // 抢先消费 —— 本 hook 观察到的 snapshot 里条目已消失(info=undefined)。此时
  // hasError 不能兜底成 false(原 bug:失败被通知成"已完成"),必须回查 store 的
  // 权威 error 状态。error 立刻触发,不走 debounce。
  it('resolves errors via the authoritative store when the transition entry was consumed by another subscriber', async () => {
    const onSessionDone = vi.fn();
    const onSessionError = vi.fn();
    storeMock.terminalErrorSessions.add('session-raced');

    renderHook(() => useSessionRunningStatus(undefined, { onSessionDone, onSessionError }));

    await emitSnapshot(new Map([['session-raced', status(true)]]));
    // 过渡代已被其它订阅者消费:条目直接消失,而不是出现 isRunning:false 的一代。
    await emitSnapshot(new Map());

    expect(onSessionDone).not.toHaveBeenCalled();
    expect(onSessionError).toHaveBeenCalledWith('session-raced');
  });

  it('suppresses both callbacks for side-task stop transitions (mivo skipTurnReset)', async () => {
    const onSessionDone = vi.fn();
    const onSessionError = vi.fn();
    renderHook(() => useSessionRunningStatus(undefined, { onSessionDone, onSessionError }));

    await emitSnapshot(new Map([['s-side', status(true)]]));
    // side-task 结束: transition 标记 sideTask → done/error 都不触发,也不进 debounce。
    await emitSnapshot(new Map([['s-side', status(false, true, true)]]));

    expect(onSessionDone).not.toHaveBeenCalled();
    expect(onSessionError).not.toHaveBeenCalled();
  });

  it('suppresses callbacks via the store fallback when a side-task transition entry was consumed', async () => {
    const onSessionDone = vi.fn();
    const onSessionError = vi.fn();
    storeMock.terminalErrorSessions.add('s-side2');
    storeMock.sideTaskStopSessions.add('s-side2');
    renderHook(() => useSessionRunningStatus(undefined, { onSessionDone, onSessionError }));

    await emitSnapshot(new Map([['s-side2', status(true)]]));
    // entry 被其它订阅者消费(本代际拿不到) → 兜底查询 store 判 side-task。
    await emitSnapshot(new Map());

    expect(onSessionDone).not.toHaveBeenCalled();
    expect(onSessionError).not.toHaveBeenCalled();
  });

  it('still fires the done callback when the transition entry vanished and the store has no error', async () => {
    vi.useFakeTimers();
    const onSessionDone = vi.fn();
    const onSessionError = vi.fn();

    renderHook(() => useSessionRunningStatus(undefined, { onSessionDone, onSessionError }));

    await emitSnapshot(new Map([['session-vanish', status(true)]]));
    await emitSnapshot(new Map());
    // done 走 debounce,推进 500ms 让定时器 fire
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(onSessionError).not.toHaveBeenCalled();
    expect(onSessionDone).toHaveBeenCalledWith('session-vanish');
    vi.useRealTimers();
  });

  it('suppresses onSessionDone when a new turn starts within the debounce window', async () => {
    // 场景:用户排了多条队列;turn A 结束后 main 在 debounce 窗口内自动 spawn
    // turn B。此时不应触发系统通知 —— 用户视角这是一条完整任务的中间态。
    vi.useFakeTimers();
    const onSessionDone = vi.fn();
    renderHook(() => useSessionRunningStatus(undefined, { onSessionDone }));

    await emitSnapshot(new Map([['session-1', status(true)]]));
    await emitSnapshot(new Map([['session-1', status(false)]]));
    // 100ms 后 turn B 开始 —— 应取消刚刚 schedule 的通知
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await emitSnapshot(new Map([['session-1', status(true)]]));
    // 继续推进到超过 debounce 窗口
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(onSessionDone).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('fires onSessionDone once the debounce window elapses without a follow-up turn', async () => {
    // 队列排空、真正 idle 的最后一次 turn 结束,debounce 窗口过完仍是 not-running
    // → 正常发系统通知。
    vi.useFakeTimers();
    const onSessionDone = vi.fn();
    renderHook(() => useSessionRunningStatus(undefined, { onSessionDone }));

    await emitSnapshot(new Map([['session-1', status(true)]]));
    await emitSnapshot(new Map([['session-1', status(false)]]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(onSessionDone).toHaveBeenCalledWith('session-1');
    vi.useRealTimers();
  });

  it('coalesces multiple queue-drain transitions into a single final notification', async () => {
    // 排队 3 条消息:A → done → B → done → C → done。前两次 done 都在 debounce
    // 窗口内被下一次 turn 起始取消,只有 C 结束(队列空)最终 fire 一次通知。
    // 修复"一次弹很多"回归。
    vi.useFakeTimers();
    const onSessionDone = vi.fn();
    renderHook(() => useSessionRunningStatus(undefined, { onSessionDone }));

    // A running
    await emitSnapshot(new Map([['session-1', status(true)]]));
    // A done
    await emitSnapshot(new Map([['session-1', status(false)]]));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    // B running
    await emitSnapshot(new Map([['session-1', status(true)]]));
    // B done
    await emitSnapshot(new Map([['session-1', status(false)]]));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    // C running
    await emitSnapshot(new Map([['session-1', status(true)]]));
    // C done —— 队列空
    await emitSnapshot(new Map([['session-1', status(false)]]));
    // 推进过 debounce 窗口
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });

    expect(onSessionDone).toHaveBeenCalledTimes(1);
    expect(onSessionDone).toHaveBeenCalledWith('session-1');
    vi.useRealTimers();
  });

  it('does not downgrade an awaiting badge to done after the debounce window', async () => {
    // 回归:turn 结束的同一帧带 pending ask-user → section 3 先亮 awaiting(黄)。
    // debounce 把 done 推迟到 section 3 之后,定时器 fire 时若仍 pending,不能用
    // done(橙)覆盖 awaiting,否则用户看不到需要处理的交互。done 系统通知仍照常发。
    vi.useFakeTimers();
    const onSessionDone = vi.fn();
    renderHook(() => useSessionRunningStatus(undefined, { onSessionDone }));

    await emitSnapshot(new Map([['s-ask', status(true)]]));
    await emitSnapshot(new Map([['s-ask', { ...status(false), hasPendingAskUser: true }]]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(vi.mocked(addSessionAttention)).toHaveBeenCalledWith('s-ask', 'awaiting');
    expect(vi.mocked(addSessionAttention)).not.toHaveBeenCalledWith('s-ask', 'done');
    expect(onSessionDone).toHaveBeenCalledWith('s-ask');
    vi.useRealTimers();
  });

  it('treats plugin setup as a needs-reply interaction', async () => {
    const onSessionNeedsReply = vi.fn();
    renderHook(() => useSessionRunningStatus('another-session', { onSessionNeedsReply }));

    await emitSnapshot(
      new Map([['s-setup', { ...status(false), hasPendingPluginSetup: true }]]),
    );

    expect(vi.mocked(addSessionAttention)).toHaveBeenCalledWith('s-setup', 'awaiting');
    expect(onSessionNeedsReply).toHaveBeenCalledWith('s-setup');
  });

  it('clears an orphaned error badge when a new turn starts and the terminal error is gone', async () => {
    // 回归(#592 review):失焦时报错挂了 error 角标、用户从未处置 → scheduler 起新
    // turn 把 store 的终止错误顶掉。running 上升沿必须把 orphan 角标 explicit 清掉,
    // 否则活跃会话的 done 分支不覆写,红点永久残留。
    renderHook(() => useSessionRunningStatus(undefined));

    vi.mocked(getSessionAttentionKind).mockReturnValue('error');
    storeMock.terminalErrorSessions.delete('s-orphan');
    await emitSnapshot(new Map([['s-orphan', status(true)]]));

    expect(vi.mocked(clearSessionAttention)).toHaveBeenCalledWith('s-orphan', { intent: 'explicit' });
    vi.mocked(getSessionAttentionKind).mockReturnValue(undefined);
  });

  it('keeps a still-real error badge when a new turn starts while the terminal error persists', async () => {
    renderHook(() => useSessionRunningStatus(undefined));

    vi.mocked(getSessionAttentionKind).mockReturnValue('error');
    storeMock.terminalErrorSessions.add('s-real');
    await emitSnapshot(new Map([['s-real', status(true)]]));

    expect(vi.mocked(clearSessionAttention)).not.toHaveBeenCalledWith('s-real', { intent: 'explicit' });
    vi.mocked(getSessionAttentionKind).mockReturnValue(undefined);
    storeMock.terminalErrorSessions.delete('s-real');
  });

  // 回归:静默 run 仍在飞行(还没 completed)时,session 的 running→done 会翻转多次
  // —— 主 turn done 只是中间态,runner 还在等在途后台 subagent;subagent 完成后 SDK
  // 自动续 turn,silent-stop 守卫也会在 1.5s 后自动续跑。标记以前被第一次中间 done
  // 消费掉,最终那次真 done 就走了普通完成路径,把 macOS toast / 飞书 / 手机推送全发
  // 一遍。上面那些静默用例都先调了 scheduleClearSilencedRun(即 completed 已到),
  // 正好绕开了这个缝隙,所以长期没被抓到。
  it('never fires the done callback across a multi-turn silenced run', async () => {
    vi.useFakeTimers();
    const onSessionDone = vi.fn();
    // 只有 silenced,没有 scheduleClearSilencedRun —— run 仍在飞行。
    markNextSessionDoneSilenced('run-multi', 'session-multi');

    renderHook(() => useSessionRunningStatus(undefined, { onSessionDone }));

    // 主 turn 跑完(中间态)。
    await emitSnapshot(new Map([['session-multi', status(true)]]));
    await emitSnapshot(new Map([['session-multi', status(false)]]));
    // 推过 debounce:标记若被第一次 done 消费掉,这里还不会响 —— 真正漏出的是下一次。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(onSessionDone).not.toHaveBeenCalled();

    // 后台 subagent 完成 → 自动续 turn，产出最终 summary 后再次 done。
    await emitSnapshot(new Map([['session-multi', status(true)]]));
    await emitSnapshot(new Map([['session-multi', status(false)]]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(onSessionDone).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('keeps scheduler notification ownership across a multi-turn run', async () => {
    // 同根因的第二个症状:标记被中间 done 消费后,最终 done 时 renderer 又发一条,
    // 与 scheduler notifier 自己那条叠成两次通知。
    vi.useFakeTimers();
    const onSessionDone = vi.fn();
    markNextSessionTerminalNotificationOwnedByScheduler('run-owned-multi', 'session-owned-multi');

    renderHook(() => useSessionRunningStatus(undefined, { onSessionDone }));

    await emitSnapshot(new Map([['session-owned-multi', status(true)]]));
    await emitSnapshot(new Map([['session-owned-multi', status(false)]]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    await emitSnapshot(new Map([['session-owned-multi', status(true)]]));
    await emitSnapshot(new Map([['session-owned-multi', status(false)]]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    // attention 仍照常挂(schedulerOwned 只抑制外发通知,不抑制角标)。
    expect(vi.mocked(addSessionAttention)).toHaveBeenCalledWith('session-owned-multi', 'done');
    expect(onSessionDone).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // 回归(codex review P1):agent 在自己 turn 内调 schedule_silence_current_run 时,
  // 标记建立时该 turn 已经 running、renderer 早过了 rising edge —— 任何依赖「事件序」
  // 建立/撤销兜底的方案都会在这条路径上失守。标记的存续不能与时间挂钩。
  it('keeps suppressing when the marker is created mid-turn and that turn runs long', async () => {
    vi.useFakeTimers();
    const onSessionDone = vi.fn();
    renderHook(() => useSessionRunningStatus(undefined, { onSessionDone }));

    // turn 先跑起来，之后 agent 才在 turn 内部请求静默。
    await emitSnapshot(new Map([['session-mid', status(true)]]));
    markNextSessionDoneSilenced('run-mid', 'session-mid');
    // agent 请求静默后继续跑一个很长的工具调用：running 状态毫无变化，也没有任何
    // scheduler 事件。跑多久都不该影响标记 —— run 的存活只由 scheduler 的权威状态
    // 决定，不由挂钟决定。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60_000);
    });
    expect(isSessionDoneSilenced('session-mid')).toBe(true);

    // turn 真正结束。
    await emitSnapshot(new Map([['session-mid', status(false)]]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(onSessionDone).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

});
