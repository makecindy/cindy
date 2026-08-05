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
  type AutoResumeBookkeepingDeps,
  type AutoResumeOutcome,
  type SuppressedTurnError,
} from '../autoResumeBookkeeping.js';

function createHarness() {
  const persisted: Array<{ sessionId: string; detail: SuppressedTurnError }> = [];
  const outcomes: Array<{ sessionId: string; clientId: string; outcome: AutoResumeOutcome }> = [];
  const guardRollbacks: string[] = [];
  const abandons: Array<{ sessionId: string; message?: string }> = [];
  const surfaced: Array<{ sessionId: string; detail: SuppressedTurnError }> = [];
  const deps: AutoResumeBookkeepingDeps = {
    persistSuppressedError: (sessionId, detail) => persisted.push({ sessionId, detail }),
    surfaceSuppressedError: (sessionId, detail) => surfaced.push({ sessionId, detail }),
    markOutcome: (sessionId, clientId, outcome) => outcomes.push({ sessionId, clientId, outcome }),
    rollbackGuardPendingResume: (sessionId) => guardRollbacks.push(sessionId),
    abandonTakeover: (sessionId, message) => abandons.push({ sessionId, ...(message !== undefined ? { message } : {}) }),
  };
  return { book: new AutoResumeBookkeeping(deps), persisted, surfaced, outcomes, guardRollbacks, abandons };
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
    expect(h.persisted).toEqual([
      { sessionId: 's1', detail: { message: 'old interruption' } },
    ]);
    expect(h.surfaced).toEqual([
      { sessionId: 's1', detail: { message: 'old interruption' } },
    ]);
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
    expect(h.persisted).toEqual([
      { sessionId: 's1', detail: { message: 'new interruption' } },
    ]);
    expect(h.surfaced).toEqual([
      { sessionId: 's1', detail: { message: 'new interruption' } },
    ]);
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
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: () => void) => {
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
    const gate = new Promise<void>((resolve) => { release = resolve; });
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
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let callbackAttempt!: { isCurrent: () => boolean };

    h.book.schedule('s1', 7, 1_000, async (attempt) => {
      callbackAttempt = attempt;
      await gate;
      expect(attempt.isCurrent()).toBe(true);
      h.book.finalizeSuppressedError('s1', 7, { surfaceBanner: false });
    });

    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(h.book.hasSchedule('s1')).toBe(true);
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
    expect(h.book.isCurrentAttempt('s1', 7), 'suppressed owner 仍在时不能提前删 attempt').toBe(true);

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
    const gate = new Promise<void>((resolve) => { release = resolve; });
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
    expect(h.persisted).toEqual([
      { sessionId: 's1', detail: { message: 'old interruption' } },
    ]);

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

    expect(h.persisted).toEqual([
      { sessionId: 's1', detail: { message: 'old interruption' } },
    ]);
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

    expect(h.persisted).toEqual([
      { sessionId: 's1', detail: { message: 'old interruption' } },
    ]);
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
