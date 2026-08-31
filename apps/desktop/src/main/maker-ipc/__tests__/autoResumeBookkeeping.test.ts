/**
 * 中断自愈簿记的生命周期不变量。
 *
 * 这一族在 review 里连着被抓出四轮真问题(悬空结算、定时器不撤、句柄被覆盖而不取消、
 * 暂存被覆盖或丢弃而不补落),共同点是**错法都不抛异常**:表现只有"历史里少一条错误卡"
 * 或"多一条假的已重新连接"。逻辑原先长在 register 的巨型 wiring 里,起不了单测;搬出来
 * 之后这里逐条锁死。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AutoResumeBookkeeping,
  shouldSkipOrcaWorkerTerminal,
  type AutoResumeBookkeepingDeps,
  type AutoResumeOutcome,
  type OrcaSuppressedTerminal,
  type SuppressedTurnError,
} from '../autoResumeBookkeeping.js';

function createOrcaTerminal(overrides?: Partial<OrcaSuppressedTerminal>): OrcaSuppressedTerminal {
  return {
    status: 'error',
    finalText: '',
    diagnostic: 'codex_reconnect_stalled',
    capture: { sessionId: 's1', generation: 1 },
    ...overrides,
  };
}

function createHarness() {
  const persisted: Array<{ sessionId: string; detail: SuppressedTurnError }> = [];
  const outcomes: Array<{ sessionId: string; clientId: string; outcome: AutoResumeOutcome }> = [];
  const guardRollbacks: string[] = [];
  const abandons: Array<{ sessionId: string; message?: string }> = [];
  const surfaced: Array<{ sessionId: string; detail: SuppressedTurnError }> = [];
  const orcaFinalized: Array<{ sessionId: string; payload: OrcaSuppressedTerminal }> = [];
  const deps: AutoResumeBookkeepingDeps = {
    persistSuppressedError: (sessionId, detail) => persisted.push({ sessionId, detail }),
    surfaceSuppressedError: (sessionId, detail) => surfaced.push({ sessionId, detail }),
    finalizeOrcaSuppressedTerminal: (sessionId, payload) =>
      orcaFinalized.push({ sessionId, payload }),
    markOutcome: (sessionId, clientId, outcome) => outcomes.push({ sessionId, clientId, outcome }),
    rollbackGuardPendingResume: (sessionId) => guardRollbacks.push(sessionId),
    abandonTakeover: (sessionId, message) =>
      abandons.push({ sessionId, ...(message !== undefined ? { message } : {}) }),
  };
  return {
    book: new AutoResumeBookkeeping(deps),
    persisted,
    surfaced,
    orcaFinalized,
    outcomes,
    guardRollbacks,
    abandons,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('被压住的错误详情:必有人补落', () => {
  it('flush 把详情落库并清空(重复 flush 是 no-op)', () => {
    const h = createHarness();
    h.book.stashSuppressedError('s1', {
      message: 'API Error: Connection closed mid-response.',
      sdkError: 'server_error',
      reason: undefined,
    });

    expect(h.book.flushSuppressedError('s1')).toBe(true);
    expect(h.persisted).toEqual([
      {
        sessionId: 's1',
        detail: { message: 'API Error: Connection closed mid-response.', sdkError: 'server_error' },
      },
    ]);
    expect(h.book.flushSuppressedError('s1'), '已经落过就不该再落一遍').toBe(false);
    expect(h.persisted).toHaveLength(1);
    expect(h.surfaced, '普通补落只恢复历史，不应通知其它错误表面').toEqual([]);
  });

  it('stash 只收字符串字段(非字符串一律丢弃,不把 undefined 写进 content)', () => {
    const h = createHarness();
    h.book.stashSuppressedError('s1', { message: 'boom', reason: 42, sdkError: null });
    h.book.flushSuppressedError('s1');
    expect(h.persisted[0]?.detail).toEqual({ message: 'boom' });
  });

  it('自愈成功 → discard 丢弃详情,历史里只留活动行', () => {
    const h = createHarness();
    h.book.stashSuppressedError('s1', { message: 'boom' });
    expect(h.book.hasSuppressedError('s1')).toBe(true);
    h.book.discardSuppressedError('s1');
    expect(h.book.hasSuppressedError('s1')).toBe(false);
    expect(h.book.flushSuppressedError('s1')).toBe(false);
    expect(h.persisted).toEqual([]);
    expect(h.surfaced).toEqual([]);
  });

  it('surface:补落并只向其它错误表面通知一次', () => {
    const h = createHarness();
    h.book.stashSuppressedError('s1', { message: 'boom' });

    expect(h.book.surfaceSuppressedError('s1')).toBe(true);
    expect(h.book.surfaceSuppressedError('s1')).toBe(false);
    expect(h.persisted).toEqual([{ sessionId: 's1', detail: { message: 'boom' } }]);
    expect(h.surfaced).toEqual([{ sessionId: 's1', detail: { message: 'boom' } }]);
  });

  it('replacement 归属按 clientId 锁定，别的队列项不能释放旧错误', () => {
    const h = createHarness();
    h.book.stashSuppressedError('s1', { message: 'old interruption' });

    expect(h.book.claimSuppressedErrorForRetry('s1', 'retry-1')).toBe(true);
    expect(h.book.claimSuppressedErrorForRetry('s1', 'retry-2')).toBe(false);
    expect(h.book.isSuppressedErrorClaimedByRetry('s1', 'retry-1')).toBe(true);
    expect(h.book.discardSuppressedErrorForRetry('s1', 'retry-2')).toBe(false);
    expect(h.book.hasSuppressedError('s1')).toBe(true);

    expect(h.book.discardSuppressedErrorForRetry('s1', 'retry-1')).toBe(true);
    expect(h.book.hasSuppressedError('s1')).toBe(false);
    expect(h.persisted).toEqual([]);
  });

  it('preview 后把 completion tail 交给 Agent Island，rollback 后重新接回', () => {
    const h = createHarness();
    h.book.stashSuppressedError('s1', { message: 'old interruption' });
    h.book.claimSuppressedErrorForRetry('s1', 'retry-1');

    expect(h.book.shouldSuppressAgentIslandCompletionTail('s1')).toBe(true);
    expect(h.book.shouldSuppressAgentIslandError('s1')).toBe(true);
    expect(h.book.markReplacementPreviewed('s1', 'retry-1')).toBe(true);
    expect(h.book.shouldSuppressAgentIslandCompletionTail('s1')).toBe(false);
    expect(h.book.shouldSuppressAgentIslandError('s1')).toBe(true);

    expect(h.book.rollbackReplacementPreview('s1', 'retry-1')).toBe(true);
    expect(h.book.shouldSuppressAgentIslandCompletionTail('s1')).toBe(true);
    expect(h.book.surfaceSuppressedErrorForRetry('s1', 'retry-1')).toBe(true);
    expect(h.persisted).toEqual([{ sessionId: 's1', detail: { message: 'old interruption' } }]);
    expect(h.surfaced).toEqual([{ sessionId: 's1', detail: { message: 'old interruption' } }]);
  });

  it('Island preview 不可用时 dispatch 仍切开新错误归属，但继续兜住旧 completion tail', () => {
    const h = createHarness();
    h.book.stashSuppressedError('s1', { message: 'old interruption' });
    h.book.claimSuppressedErrorForRetry('s1', 'retry-1');

    expect(h.book.markReplacementDispatching('s1', 'retry-1')).toBe(true);
    expect(h.book.shouldSuppressAgentIslandError('s1')).toBe(false);
    expect(h.book.shouldSuppressAgentIslandCompletionTail('s1')).toBe(true);

    h.book.rollbackReplacementPreview('s1', 'retry-1');
    expect(h.book.shouldSuppressAgentIslandError('s1')).toBe(true);
    expect(h.book.shouldSuppressAgentIslandCompletionTail('s1')).toBe(true);
  });

  it('replacement dispatch 后新错误独立接管，旧 owner 不能删掉它', () => {
    const h = createHarness();
    h.book.stashSuppressedError('s1', { message: 'old interruption' });
    h.book.claimSuppressedErrorForRetry('s1', 'retry-1');
    h.book.markReplacementPreviewed('s1', 'retry-1');
    expect(h.book.markReplacementDispatching('s1', 'retry-1')).toBe(true);
    expect(h.book.shouldSuppressAgentIslandError('s1')).toBe(false);

    // sendToAgent 可在返回前同步发出 replacement 自己的 retryable error。
    h.book.stashSuppressedError('s1', { message: 'new interruption' });
    expect(h.persisted, '旧 transient error 已被 replacement 取代，不应补回历史').toEqual([]);
    expect(h.book.isSuppressedErrorClaimedByRetry('s1', 'retry-1')).toBe(false);
    expect(h.book.discardSuppressedErrorForRetry('s1', 'retry-1')).toBe(false);

    expect(h.book.surfaceSuppressedError('s1')).toBe(true);
    expect(h.persisted).toEqual([{ sessionId: 's1', detail: { message: 'new interruption' } }]);
    expect(h.surfaced).toEqual([{ sessionId: 's1', detail: { message: 'new interruption' } }]);
  });

  it('replacement 的同步不可续跑终态可直接丢弃旧 dispatch owner', () => {
    const h = createHarness();
    h.book.stashSuppressedError('s1', { message: 'old interruption' });
    h.book.claimSuppressedErrorForRetry('s1', 'retry-1');
    h.book.markReplacementPreviewed('s1', 'retry-1');
    h.book.markReplacementDispatching('s1', 'retry-1');

    expect(h.book.discardReplacementProvenByProviderEvent('s1')).toBe(true);
    expect(h.book.discardReplacementProvenByProviderEvent('s1')).toBe(false);
    expect(h.book.hasSuppressedError('s1')).toBe(false);
    expect(h.persisted).toEqual([]);
    expect(h.surfaced).toEqual([]);
  });

  it('finalize:补落 + 呈现失败 + 结算 failed + 清接管态', () => {
    const h = createHarness();
    h.book.stashSuppressedError('s1', { message: 'boom' });
    h.book.registerPendingOutcome('s1', 'c-1');

    h.book.finalizeSuppressedError('s1', { surfaceError: true });

    expect(h.persisted).toHaveLength(1);
    expect(h.surfaced).toEqual([{ sessionId: 's1', detail: { message: 'boom' } }]);
    expect(h.outcomes).toEqual([{ sessionId: 's1', clientId: 'c-1', outcome: 'failed' }]);
    expect(h.abandons).toEqual([{ sessionId: 's1', message: 'boom' }]);
  });

  it('finalize(surfaceError=false):仍补落,但不重新呈现错误(用户已自己接手)', () => {
    const h = createHarness();
    h.book.stashSuppressedError('s1', { message: 'boom' });
    h.book.finalizeSuppressedError('s1', { surfaceError: false });
    expect(h.persisted).toHaveLength(1);
    expect(h.surfaced).toEqual([]);
    expect(h.abandons).toEqual([{ sessionId: 's1' }]);
  });
});

describe('待确认的重连记录:必有一次结算', () => {
  it('settle 回填结果并清除(重复 settle 是 no-op)', () => {
    const h = createHarness();
    h.book.registerPendingOutcome('s1', 'c-1');
    h.book.settleOutcome('s1', 'succeeded');
    h.book.settleOutcome('s1', 'failed');
    expect(h.outcomes).toEqual([{ sessionId: 's1', clientId: 'c-1', outcome: 'succeeded' }]);
  });

  it('release 按 clientId 校验:不撤别人的登记', () => {
    const h = createHarness();
    h.book.registerPendingOutcome('s1', 'c-1');
    h.book.releasePendingOutcome('s1', 'c-other');
    expect(h.book.isPendingOutcomeClientId('s1', 'c-1')).toBe(true);

    h.book.releasePendingOutcome('s1', 'c-1');
    expect(h.book.isPendingOutcomeClientId('s1', 'c-1')).toBe(false);
    h.book.settleOutcome('s1', 'succeeded');
    expect(h.outcomes, '登记已撤 → 不该再去 patch 一条压根没落库的消息').toEqual([]);
  });

  it('会话之间互不干扰', () => {
    const h = createHarness();
    h.book.registerPendingOutcome('s1', 'c-1');
    h.book.registerPendingOutcome('s2', 'c-2');
    h.book.settleOutcome('s1', 'failed');
    expect(h.outcomes).toEqual([{ sessionId: 's1', clientId: 'c-1', outcome: 'failed' }]);
    expect(h.book.isPendingOutcomeClientId('s2', 'c-2')).toBe(true);
  });
});

describe('退避排期:必可撤销、必只认自己那次', () => {
  it('到点执行一次,并在执行前摘掉自己的排期', () => {
    const h = createHarness();
    const run = vi.fn();
    h.book.schedule('s1', 5_000, run);
    expect(h.book.hasSchedule('s1')).toBe(true);

    vi.advanceTimersByTime(5_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.book.hasSchedule('s1'), '回调开跑就不再是"已排期"').toBe(false);
  });

  it('cancel 撤销排期并回滚守卫额度(会话终止语义)', () => {
    const h = createHarness();
    const run = vi.fn();
    h.book.schedule('s1', 5_000, run);
    h.book.cancelSchedule('s1');

    vi.advanceTimersByTime(10_000);
    expect(run).not.toHaveBeenCalled();
    expect(h.guardRollbacks).toEqual(['s1']);
    // 没有排期时是 no-op,不会重复回滚。
    h.book.cancelSchedule('s1');
    expect(h.guardRollbacks).toEqual(['s1']);
  });

  it('新排期顶替旧排期:旧回调不执行、**不**回滚守卫额度(那份属于新那次)', () => {
    const h = createHarness();
    const first = vi.fn();
    const second = vi.fn();
    h.book.schedule('s1', 20_000, first);
    h.book.schedule('s1', 3_000, second);

    vi.advanceTimersByTime(20_000);
    expect(first, '旧排期必须被真的取消,不能只是句柄被覆盖').not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(h.guardRollbacks, '顶替不是失败,回滚会把新那次的额度一起抹掉').toEqual([]);
  });

  it('后一次中断覆盖前一次时,前一次必须先被补落(否则它从历史里消失)', () => {
    // 旧排期的定时器回调是上一次中断唯一剩下的补落路径,新排期一撤就没人管了(codex P1)。
    // **补落必须发生在覆盖那一刻**(stash),放到 schedule 里就太晚了 —— 那时详情已被覆盖。
    const h = createHarness();
    h.book.stashSuppressedError('s1', { message: 'first interruption' });
    h.book.schedule('s1', 20_000, vi.fn());

    h.book.stashSuppressedError('s1', { message: 'second interruption' });
    expect(h.persisted.map((p) => p.detail.message)).toEqual(['first interruption']);
    expect(h.surfaced, '被新一轮顶替只补历史，不能拿旧错误打扰用户').toEqual([]);

    h.book.schedule('s1', 3_000, vi.fn());
    // 第二条仍在压制中,等它自己的结局。
    expect(h.book.flushSuppressedError('s1')).toBe(true);
    expect(h.persisted.map((p) => p.detail.message)).toEqual([
      'first interruption',
      'second interruption',
    ]);
  });

  it('同一次中断只 stash 一次:第一次 stash 不会把自己补落出来', () => {
    // 这是上一条 flush 成立的前提。调用方(register 的 onEvent 压制分支)是唯一 stash 点;
    // 若接管路径再 stash 一遍,正在压制中的那条就会被自己补落出来 —— 红色错误卡与活动行
    // 同时出现,本功能白做。
    const h = createHarness();
    h.book.stashSuppressedError('s1', { message: 'only interruption' });
    expect(h.persisted, '首次压制不该产生任何落库').toEqual([]);
  });

  it('被顶替的旧回调即使 fire 也不执行、不误删新句柄(令牌第二道防线)', () => {
    // 手工构造"旧回调已 fire"的情形:令牌不匹配时必须直接 return,否则它会 delete 掉新
    // 排期的句柄,teardown 从此取消不了任何东西(codex P1)。
    const h = createHarness();
    const timers: Array<() => void> = [];
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
    ) => {
      timers.push(fn);
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});

    const first = vi.fn();
    const second = vi.fn();
    h.book.schedule('s1', 20_000, first);
    h.book.schedule('s1', 3_000, second);

    // clearTimeout 被打桩成 no-op → 旧回调仍会被"触发",模拟真实竞态。
    timers[0]?.();
    expect(first).not.toHaveBeenCalled();
    expect(h.book.hasSchedule('s1'), '新排期的句柄不该被旧回调摘掉').toBe(true);

    timers[1]?.();
    expect(second).toHaveBeenCalledTimes(1);

    setTimeoutSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
  });

  it('timer 已 fire 后 Manual Retry 接管 → 旧 async completion 不能终结新 owner', async () => {
    const h = createHarness();
    h.book.stashSuppressedError('s1', { message: 'old interruption' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.book.schedule('s1', 1_000, async (attempt) => {
      await gate;
      if (attempt.isCurrent()) {
        h.book.finalizeSuppressedError('s1', { surfaceError: false });
      }
    });

    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(h.book.hasSchedule('s1'), 'async 判定期间仍须保留可撤销 lease').toBe(true);

    expect(h.book.claimSuppressedErrorForRetry('s1', 'manual-retry', 'manual')).toBe(true);
    expect(h.book.hasSchedule('s1')).toBe(false);
    expect(h.guardRollbacks).toEqual(['s1']);

    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.book.isSuppressedErrorClaimedByRetry('s1', 'manual-retry')).toBe(true);
    expect(h.persisted, '旧 completion 不得补落或删除手动 replacement 的错误').toEqual([]);
  });

  it('tokenized async callback 保持 lease，且业务 finalize 先释放 attempt 也能清自己的 lease', async () => {
    const h = createHarness();
    h.book.beginAttempt('s1', 7);
    h.book.stashSuppressedError('s1', { message: 'old interruption' }, 7);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let callbackAttempt!: { isCurrent: () => boolean };

    h.book.schedule('s1', 7, 1_000, async (attempt) => {
      callbackAttempt = attempt;
      await gate;
      expect(attempt.isCurrent()).toBe(true);
      h.book.finalizeSuppressedError('s1', 7, { surfaceBanner: false });
    });

    expect(h.book.hasWaitingSchedule('s1', 7)).toBe(true);
    expect(h.book.hasWaitingSchedule('s1', 8)).toBe(false);
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(h.book.hasSchedule('s1')).toBe(true);
    expect(
      h.book.hasWaitingSchedule('s1', 7),
      'timer 已触发、async callback 在跑时不再属于 provider rebuild 交棒窗口',
    ).toBe(false);
    expect(callbackAttempt.isCurrent()).toBe(true);

    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.book.hasSchedule('s1')).toBe(false);
    expect(h.persisted).toEqual([{ sessionId: 's1', detail: { message: 'old interruption' } }]);
  });

  it('结算 undispatched outcome 时保留 suppressed-error attempt lease 直到 finalize', () => {
    const h = createHarness();
    h.book.beginAttempt('s1', 7);
    h.book.stashSuppressedError('s1', { message: 'boom' }, 7);
    h.book.registerPendingOutcome('s1', 7, 'retry-1');

    h.book.settleOutcomeForClient('s1', 7, 'retry-1', 'failed');
    expect(h.book.isCurrentAttempt('s1', 7), 'suppressed owner 仍在时不能提前删 attempt').toBe(
      true,
    );

    h.book.finalizeSuppressedError('s1', 7, { surfaceBanner: true });
    expect(h.book.isCurrentAttempt('s1', 7)).toBe(false);
    expect(h.persisted).toEqual([{ sessionId: 's1', detail: { message: 'boom' } }]);
    expect(h.outcomes).toEqual([{ sessionId: 's1', clientId: 'retry-1', outcome: 'failed' }]);
  });

  it('deferred owner 精确 flush 不会被 newer attempt 拦截或误删', () => {
    const h = createHarness();
    const oldOwner = { generation: 3, clientId: 'old-turn' };
    const newOwner = { generation: 4, clientId: 'new-turn' };
    h.book.stashSuppressedError('s1', { message: 'deferred error' }, null, oldOwner);
    h.book.beginAttempt('s1', 9);

    expect(h.book.flushSuppressedError('s1', { deferredOwner: newOwner })).toBe(false);
    expect(h.book.hasSuppressedError('s1')).toBe(true);
    expect(h.book.flushSuppressedError('s1', { deferredOwner: oldOwner })).toBe(true);
    expect(h.persisted).toEqual([{ sessionId: 's1', detail: { message: 'deferred error' } }]);
  });

  it('释放 suppressed error 后回收无其它 owner 的 current attempt', () => {
    const h = createHarness();
    h.book.beginAttempt('s1', 11);
    h.book.stashSuppressedError('s1', { message: 'boom' }, 11);

    expect(h.book.flushSuppressedError('s1', { attemptToken: 11 })).toBe(true);
    h.book.stashSuppressedError('s1', { message: 'next' });
    expect(h.book.flushSuppressedError('s1')).toBe(true);
  });

  it('clearError / 新输入接管 → 同步释放旧 Island filter，已 fire 回调随即失效', async () => {
    const h = createHarness();
    h.book.stashSuppressedError('s1', { message: 'old interruption' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.book.schedule('s1', 1_000, async (attempt) => {
      await gate;
      if (attempt.isCurrent()) {
        h.book.finalizeSuppressedError('s1', { surfaceError: false });
      }
    });

    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(h.book.supersedeUnclaimedErrorForUserIntervention('s1')).toBe(true);
    expect(h.book.shouldSuppressAgentIslandError('s1')).toBe(false);
    expect(h.book.shouldSuppressAgentIslandCompletionTail('s1')).toBe(false);
    expect(h.persisted).toEqual([{ sessionId: 's1', detail: { message: 'old interruption' } }]);

    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.persisted, '失效的旧回调不得重复 disposition').toHaveLength(1);
    expect(h.surfaced).toEqual([]);
  });
});

describe('会话终止收尾', () => {
  it('teardown:先补落错误行,再撤排期(含回滚)、清接管态、钉 failed', () => {
    // 顺序重要:先补落 —— 后面就没人管那条详情了,删掉即等于那次中断消失(copilot review)。
    const h = createHarness();
    h.book.stashSuppressedError('s1', { message: 'boom' });
    h.book.registerPendingOutcome('s1', 'c-1');
    const run = vi.fn();
    h.book.schedule('s1', 10_000, run);

    h.book.teardown('s1');

    expect(h.persisted, 'teardown 不能把压住的错误行悄悄丢掉').toEqual([
      { sessionId: 's1', detail: { message: 'boom' } },
    ]);
    expect(h.surfaced, '会话已经终止，不应再向用户呈现旧错误').toEqual([]);
    expect(h.guardRollbacks).toEqual(['s1']);
    expect(h.abandons, '会话已被用户终止 → 只清接管态,不弹横幅').toEqual([{ sessionId: 's1' }]);
    expect(h.outcomes).toEqual([{ sessionId: 's1', clientId: 'c-1', outcome: 'failed' }]);

    vi.advanceTimersByTime(20_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('teardown 幂等:第二次不再重复落库 / 回滚 / 结算', () => {
    const h = createHarness();
    h.book.stashSuppressedError('s1', { message: 'boom' });
    h.book.registerPendingOutcome('s1', 'c-1');
    h.book.schedule('s1', 10_000, vi.fn());

    h.book.teardown('s1');
    h.book.teardown('s1');

    expect(h.persisted).toHaveLength(1);
    expect(h.guardRollbacks).toEqual(['s1']);
    expect(h.outcomes).toHaveLength(1);
    // 清接管态本身幂等(coordinator 侧没接管就 no-op),重复调用无副作用。
    expect(h.abandons).toEqual([{ sessionId: 's1' }, { sessionId: 's1' }]);
  });

  it('什么都没登记时 teardown 全程 no-op', () => {
    const h = createHarness();
    h.book.teardown('s1');
    expect(h.persisted).toEqual([]);
    expect(h.outcomes).toEqual([]);
    expect(h.guardRollbacks).toEqual([]);
  });

  it('teardown 会补落仅进入 dispatching、尚无 accepted/provider 证明的旧错误', () => {
    const h = createHarness();
    h.book.stashSuppressedError('s1', { message: 'old interruption' });
    h.book.claimSuppressedErrorForRetry('s1', 'retry-1');
    h.book.markReplacementPreviewed('s1', 'retry-1');
    h.book.markReplacementDispatching('s1', 'retry-1');

    h.book.teardown('s1');

    expect(h.persisted).toEqual([{ sessionId: 's1', detail: { message: 'old interruption' } }]);
    expect(h.surfaced).toEqual([]);
    expect(h.book.hasSuppressedError('s1')).toBe(false);
  });

  it('dispatching 后 teardown 与迟到 rollback 只补落旧错误一次', () => {
    const h = createHarness();
    h.book.stashSuppressedError('s1', { message: 'old interruption' });
    h.book.claimSuppressedErrorForRetry('s1', 'retry-1');
    h.book.markReplacementPreviewed('s1', 'retry-1');
    h.book.markReplacementDispatching('s1', 'retry-1');

    h.book.teardown('s1');
    expect(h.book.rollbackReplacementPreview('s1', 'retry-1')).toBe(false);
    expect(h.book.surfaceSuppressedErrorForRetry('s1', 'retry-1')).toBe(false);

    expect(h.persisted).toEqual([{ sessionId: 's1', detail: { message: 'old interruption' } }]);
    expect(h.surfaced).toEqual([]);
  });

  it('teardown 不复活已有 provider event 证明取代的旧错误', () => {
    const h = createHarness();
    h.book.stashSuppressedError('s1', { message: 'old interruption' });
    h.book.claimSuppressedErrorForRetry('s1', 'retry-1');
    h.book.markReplacementPreviewed('s1', 'retry-1');
    h.book.markReplacementDispatching('s1', 'retry-1');
    h.book.discardReplacementProvenByProviderEvent('s1');

    h.book.teardown('s1');

    expect(h.persisted).toEqual([]);
    expect(h.surfaced).toEqual([]);
    expect(h.book.hasSuppressedError('s1')).toBe(false);
  });
});

describe('Orca L2 terminal 与 suppressed error 共用 owner', () => {
  it('没有对应 error 时 stash Orca payload 失败，避免 silently skip-without-finalize', () => {
    const h = createHarness();
    expect(h.book.stashOrcaSuppressedTerminal('s1', createOrcaTerminal())).toBe(false);
    expect(h.orcaFinalized).toEqual([]);
  });

  it('surface 用当初的 capture 恰好一次收口 Orca；重复 surface 是 no-op', () => {
    const h = createHarness();
    const payload = createOrcaTerminal({ capture: { sessionId: 's1', stamp: 7 } });
    h.book.stashSuppressedError('s1', { message: 'boom' });
    expect(h.book.stashOrcaSuppressedTerminal('s1', payload)).toBe(true);

    expect(h.book.surfaceSuppressedError('s1')).toBe(true);
    expect(h.book.surfaceSuppressedError('s1')).toBe(false);
    expect(h.orcaFinalized).toEqual([{ sessionId: 's1', payload }]);
  });

  it('flush / discard / teardown 丢掉 payload，不把 L2 收成产品 error', () => {
    const flushCase = createHarness();
    flushCase.book.stashSuppressedError('s1', { message: 'boom' });
    flushCase.book.stashOrcaSuppressedTerminal('s1', createOrcaTerminal());
    expect(flushCase.book.flushSuppressedError('s1')).toBe(true);
    expect(flushCase.orcaFinalized).toEqual([]);

    const discardCase = createHarness();
    discardCase.book.stashSuppressedError('s1', { message: 'boom' });
    discardCase.book.stashOrcaSuppressedTerminal('s1', createOrcaTerminal());
    expect(discardCase.book.discardSuppressedError('s1')).toBe(true);
    expect(discardCase.orcaFinalized).toEqual([]);

    const teardownCase = createHarness();
    teardownCase.book.stashSuppressedError('s1', { message: 'boom' });
    teardownCase.book.stashOrcaSuppressedTerminal('s1', createOrcaTerminal());
    teardownCase.book.teardown('s1');
    expect(teardownCase.orcaFinalized).toEqual([]);
  });

  it('后一次中断覆盖前一次时，旧 Orca payload 不收口；surface 只用最新一份', () => {
    const h = createHarness();
    const first = createOrcaTerminal({ diagnostic: 'first' });
    const second = createOrcaTerminal({
      diagnostic: 'second',
      capture: { sessionId: 's1', stamp: 2 },
    });
    h.book.stashSuppressedError('s1', { message: 'first interruption' });
    h.book.stashOrcaSuppressedTerminal('s1', first);
    h.book.stashSuppressedError('s1', { message: 'second interruption' });
    h.book.stashOrcaSuppressedTerminal('s1', second);

    expect(h.orcaFinalized, '仍在自愈，旧 worker terminal 不得先 bridge').toEqual([]);
    expect(h.book.surfaceSuppressedError('s1')).toBe(true);
    expect(h.orcaFinalized).toEqual([{ sessionId: 's1', payload: second }]);
  });

  it('finalize(surfaceError=true) 收口 Orca；用户接手则不收口', () => {
    const surfaced = createHarness();
    const payload = createOrcaTerminal();
    surfaced.book.stashSuppressedError('s1', { message: 'boom' });
    surfaced.book.stashOrcaSuppressedTerminal('s1', payload);
    surfaced.book.finalizeSuppressedError('s1', { surfaceError: true });
    expect(surfaced.orcaFinalized).toEqual([{ sessionId: 's1', payload }]);

    const handedOff = createHarness();
    handedOff.book.stashSuppressedError('s1', { message: 'boom' });
    handedOff.book.stashOrcaSuppressedTerminal('s1', createOrcaTerminal());
    handedOff.book.finalizeSuppressedError('s1', { surfaceError: false });
    expect(handedOff.orcaFinalized).toEqual([]);
  });

  it('claimed retry：dispatch 失败才收口，成功 discard / Stop flush 都不收口', () => {
    const failedDispatch = createHarness();
    const payload = createOrcaTerminal({ diagnostic: 'undispatched' });
    failedDispatch.book.stashSuppressedError('s1', { message: 'old interruption' });
    failedDispatch.book.stashOrcaSuppressedTerminal('s1', payload);
    failedDispatch.book.claimSuppressedErrorForRetry('s1', 'retry-1');
    expect(failedDispatch.book.surfaceSuppressedErrorForRetry('s1', 'retry-1')).toBe(true);
    expect(failedDispatch.orcaFinalized).toEqual([{ sessionId: 's1', payload }]);

    const discarded = createHarness();
    discarded.book.stashSuppressedError('s1', { message: 'old interruption' });
    discarded.book.stashOrcaSuppressedTerminal('s1', createOrcaTerminal());
    discarded.book.claimSuppressedErrorForRetry('s1', 'retry-1');
    expect(discarded.book.discardSuppressedErrorForRetry('s1', 'retry-1')).toBe(true);
    expect(discarded.orcaFinalized).toEqual([]);

    const stopped = createHarness();
    stopped.book.stashSuppressedError('s1', { message: 'old interruption' });
    stopped.book.stashOrcaSuppressedTerminal('s1', createOrcaTerminal());
    stopped.book.claimSuppressedErrorForRetry('s1', 'retry-1');
    expect(stopped.book.flushSuppressedErrorForRetry('s1', 'retry-1')).toBe(true);
    expect(stopped.orcaFinalized).toEqual([]);
  });
});

describe('shouldSkipOrcaWorkerTerminal', () => {
  const idle = {
    isContinuationBoundary: false,
    stashedThisErrorEvent: false,
    eventType: 'done',
    isPairedFailedTurnDone: false,
    isFailedTurnCompletionTail: false,
    hasSuppressedError: false,
    isAutoResumePending: false,
    isAutoResumeDeferred: false,
  };

  it('skips continuation-boundary terminals so a claim-bearing segment cannot settle Orca', () => {
    expect(
      shouldSkipOrcaWorkerTerminal({ ...idle, isContinuationBoundary: true, eventType: 'error' }),
    ).toBe(true);
    expect(shouldSkipOrcaWorkerTerminal({ ...idle, isContinuationBoundary: true })).toBe(true);
  });

  it('skips the L2 error that just stashed the Orca payload', () => {
    expect(
      shouldSkipOrcaWorkerTerminal({
        ...idle,
        stashedThisErrorEvent: true,
        eventType: 'error',
      }),
    ).toBe(true);
  });

  it('does not skip an L3 terminal error that was not stashed', () => {
    expect(
      shouldSkipOrcaWorkerTerminal({
        ...idle,
        eventType: 'error',
      }),
    ).toBe(false);
  });

  it('skips the unclaimed paired done that follows a failed turn', () => {
    expect(
      shouldSkipOrcaWorkerTerminal({
        ...idle,
        isPairedFailedTurnDone: true,
      }),
    ).toBe(true);
    expect(
      shouldSkipOrcaWorkerTerminal({
        ...idle,
        hasSuppressedError: true,
      }),
    ).toBe(true);
    expect(
      shouldSkipOrcaWorkerTerminal({
        ...idle,
        isAutoResumePending: true,
      }),
    ).toBe(true);
    expect(
      shouldSkipOrcaWorkerTerminal({
        ...idle,
        isAutoResumeDeferred: true,
      }),
    ).toBe(true);
  });

  it('lets a real product done through after auto-resume no longer owns the failure', () => {
    expect(shouldSkipOrcaWorkerTerminal(idle)).toBe(false);
  });

  it('skips a zero-output failed-turn done after user force-flush cleared persist pairing and pending', () => {
    const h = createHarness();
    h.book.stashSuppressedError('s1', { message: 'network blip' });
    h.book.stashOrcaSuppressedTerminal('s1', createOrcaTerminal());
    h.book.noteFailedTurnCompletionTail('s1', 5);

    // User enqueue: force-flush drops the suppressed entry / Orca payload, no finalize.
    expect(h.book.supersedeUnclaimedErrorForUserIntervention('s1')).toBe(true);
    expect(h.book.hasSuppressedError('s1')).toBe(false);
    expect(h.orcaFinalized).toEqual([]);
    expect(h.book.hasFailedTurnCompletionTail('s1')).toBe(true);

    const isFailedTurnCompletionTail = h.book.consumeFailedTurnCompletionTail('s1', 5);
    expect(isFailedTurnCompletionTail).toBe(true);
    expect(
      shouldSkipOrcaWorkerTerminal({
        ...idle,
        isPairedFailedTurnDone: false,
        isFailedTurnCompletionTail,
        hasSuppressedError: h.book.hasSuppressedError('s1'),
        isAutoResumePending: false,
        isAutoResumeDeferred: false,
      }),
    ).toBe(true);
    expect(h.book.hasFailedTurnCompletionTail('s1')).toBe(false);
  });

  it('does not skip a later product done after a new attempt starts', () => {
    const h = createHarness();
    h.book.noteFailedTurnCompletionTail('s1', 5);
    h.book.clearFailedTurnCompletionTail('s1');
    expect(h.book.consumeFailedTurnCompletionTail('s1', 6)).toBe(false);
    expect(shouldSkipOrcaWorkerTerminal(idle)).toBe(false);
  });

  it('does not skip a later-generation done when the failed turn never emitted a paired done', () => {
    const h = createHarness();
    h.book.noteFailedTurnCompletionTail('s1', 5);
    expect(h.book.consumeFailedTurnCompletionTail('s1', 6)).toBe(false);
    expect(h.book.hasFailedTurnCompletionTail('s1')).toBe(false);
    expect(shouldSkipOrcaWorkerTerminal(idle)).toBe(false);
  });

  it('keeps the current tail when an older stray done arrives first', () => {
    const h = createHarness();
    h.book.noteFailedTurnCompletionTail('s1', 5);
    expect(h.book.consumeFailedTurnCompletionTail('s1', 4)).toBe(false);
    expect(h.book.hasFailedTurnCompletionTail('s1')).toBe(true);
    expect(h.book.consumeFailedTurnCompletionTail('s1', 5)).toBe(true);
  });

  it('does not treat an unstamped done as the failed-turn tail', () => {
    const h = createHarness();
    h.book.noteFailedTurnCompletionTail('s1', 5);
    expect(h.book.consumeFailedTurnCompletionTail('s1')).toBe(false);
    expect(h.book.hasFailedTurnCompletionTail('s1')).toBe(true);
  });

  it('teardown drops an unconsumed tail so session-id reuse cannot steal a done', () => {
    const h = createHarness();
    h.book.noteFailedTurnCompletionTail('s1', 5);
    h.book.teardown('s1');
    expect(h.book.hasFailedTurnCompletionTail('s1')).toBe(false);
    expect(h.book.consumeFailedTurnCompletionTail('s1', 5)).toBe(false);
  });
});
