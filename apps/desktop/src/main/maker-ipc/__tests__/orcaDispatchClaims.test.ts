import { afterEach, describe, expect, it } from 'vitest';
import {
  consumeDispatchClaimReminder,
  dispatchFactsForTurn,
  dropLeadDispatchFact,
  findUnbackedDispatchClaim,
  noteLeadDispatchFact,
  resetDispatchClaimState,
  sessionInstanceToken,
  type LeadDispatchFact,
} from '../orcaDispatchClaims';

function fact(overrides: Partial<LeadDispatchFact> = {}): LeadDispatchFact {
  return {
    workerId: 'worker-1',
    workerLabel: 'research',
    dispatchId: 'mq-1',
    turnSeq: 0,
    delivery: 'queued',
    at: Date.now(),
    ...overrides,
  };
}

afterEach(() => {
  resetDispatchClaimState();
});

describe('host dispatch fact ledger', () => {
  it('keeps a rebuilt instance first dispatch when the turn counter restarts', () => {
    const oldSession = {};
    const newSession = {};

    noteLeadDispatchFact(
      'lead-1',
      fact({
        dispatchId: 'mq-old',
        turnSeq: 8,
        instanceToken: sessionInstanceToken(oldSession),
      }),
    );
    expect(dispatchFactsForTurn('lead-1', 8)).toHaveLength(1);

    noteLeadDispatchFact(
      'lead-1',
      fact({
        dispatchId: 'mq-new',
        turnSeq: 1,
        instanceToken: sessionInstanceToken(newSession),
      }),
    );

    expect(dispatchFactsForTurn('lead-1', 1).map((entry) => entry.dispatchId)).toEqual(['mq-new']);
  });

  it('keeps the current ledger when a late fact from an older turn lands', () => {
    noteLeadDispatchFact('lead-1', fact({ dispatchId: 'mq-1', turnSeq: 4 }));
    // 投递落地晚于所属轮次收口：迟到的旧凭据不改账本轮次，也不抹掉现有凭据。
    noteLeadDispatchFact('lead-1', fact({ dispatchId: 'mq-2', turnSeq: 2 }));

    expect(dispatchFactsForTurn('lead-1', 4).map((entry) => entry.dispatchId)).toEqual([
      'mq-1',
      'mq-2',
    ]);
  });

  it('drops a dispatch fact when the dispatch is withdrawn', () => {
    noteLeadDispatchFact('lead-1', fact({ dispatchId: 'mq-1' }));
    noteLeadDispatchFact('lead-1', fact({ dispatchId: 'mq-2' }));

    dropLeadDispatchFact('lead-1', 'mq-1');

    expect(dispatchFactsForTurn('lead-1', 0).map((entry) => entry.dispatchId)).toEqual(['mq-2']);
  });

  it('keeps the credentials when the turn counter rolls back', () => {
    // 轮次回退通常只是会话实例重建，凭据还在 Lead 自己的上下文里。
    // 跟着清掉的话，它引用一个真实存在的带凭证编号就会被判成无中生有。
    noteLeadDispatchFact('lead-1', fact({ dispatchId: 'mq-real', turnSeq: 9 }));
    // 先把账本推到第 9 轮，再回退：这样才真的走进回退分支。
    expect(dispatchFactsForTurn('lead-1', 9)).toHaveLength(1);
    expect(dispatchFactsForTurn('lead-1', 2).map((entry) => entry.dispatchId)).toEqual(['mq-real']);
    expect(findUnbackedDispatchClaim('回执 wake_kind=resumed')).toBeNull();
  });

  it('treats an unknown turn number as neither progress nor a rollback', () => {
    // Stop hook 可能在本轮事件投递前触发，那时宿主只知道「0」。
    // 当成回退处理会清掉提醒额度，同一句声称就会被反复纠正。
    expect(consumeDispatchClaimReminder('lead-1', 3)).toBe(true);
    expect(dispatchFactsForTurn('lead-1', 0)).toEqual([]);
    expect(consumeDispatchClaimReminder('lead-1', 0)).toBe(false);
  });

  it('forgets facts older than the retention window', () => {
    noteLeadDispatchFact('lead-1', fact({ dispatchId: 'mq-old', at: Date.now() - 25 * 60 * 60 * 1000 }));
    noteLeadDispatchFact('lead-1', fact({ dispatchId: 'mq-new' }));

    expect(dispatchFactsForTurn('lead-1', 0).map((entry) => entry.dispatchId)).toEqual(['mq-new']);
  });

  it('resets one lead without touching another', () => {
    noteLeadDispatchFact('lead-1', fact());
    noteLeadDispatchFact('lead-2', fact());

    resetDispatchClaimState('lead-1');

    expect(dispatchFactsForTurn('lead-1', 0)).toEqual([]);
    expect(dispatchFactsForTurn('lead-2', 0)).toHaveLength(1);
  });
});

describe('unbacked dispatch claim detection', () => {
  it('flags a wake_kind value the protocol never issues', () => {
    expect(
      findUnbackedDispatchClaim('已派修（wake_kind=already-dispatched），等它交回。'),
    ).toEqual({ kind: 'wake-kind', token: 'already-dispatched', label: 'wake_kind' });
  });

  it('accepts every value the protocol can return', () => {
    for (const token of ['resumed', 'already-active', 'queued', 'created']) {
      expect(findUnbackedDispatchClaim(`派工回执 wake_kind=${token}`)).toBeNull();
    }
  });

  it('leaves a cited dispatch id alone — a missing ledger entry proves nothing', () => {
    // 账本在内存里、有 24 小时与 200 条上限；重启或过期之后一条真实编号与编造的
    // 完全一样。查不到不等于编造，所以编号一律不核对，只交给语义层。
    expect(
      findUnbackedDispatchClaim('派了：dispatch_id: e47e4ix8u7vjpxzd0ixrivw8'),
    ).toBeNull();
    expect(
      findUnbackedDispatchClaim('派了：queued_message_id: e47e4ix8u7vjpxzd0ixrivw8'),
    ).toBeNull();
  });

  it('leaves plain prose alone — it carries no protocol token to check', () => {
    expect(findUnbackedDispatchClaim('已派给 research 去改注入表了。')).toBeNull();
  });

  it('flags a fabricated value even when the host recorded dispatches', () => {
    noteLeadDispatchFact('lead-1', fact({}));
    expect(findUnbackedDispatchClaim('已派工（wake_kind=dispatched）。')).toEqual({
      kind: 'wake-kind',
      token: 'dispatched',
      label: 'wake_kind',
    });
  });
});

describe('claim reminder budget', () => {
  it('allows one reminder per turn', () => {
    expect(consumeDispatchClaimReminder('lead-1', 3)).toBe(true);
    expect(consumeDispatchClaimReminder('lead-1', 3)).toBe(false);
    expect(consumeDispatchClaimReminder('lead-1', 4)).toBe(true);
  });

  it('corrects a new claim even on the turn right after a correction', () => {
    expect(consumeDispatchClaimReminder('lead-1', 5)).toBe(true);
    // 一轮里可派多次：按会话静默会把后来那几次的假凭据一起放过。
    expect(consumeDispatchClaimReminder('lead-1', 6)).toBe(true);
  });

  it('corrects the same sentence again on a later turn', () => {
    expect(consumeDispatchClaimReminder('lead-1', 7)).toBe(true);
    // 不按声称身份跨轮静默：反复坚持同一句假话不能免费过关。
    // 真话靠判定器看到账本里的派发行放行，不靠压制提醒次数。
    expect(consumeDispatchClaimReminder('lead-1', 8)).toBe(true);
  });

  it('re-arms after the session instance restarts', () => {
    expect(consumeDispatchClaimReminder('lead-1', 9)).toBe(true);
    expect(consumeDispatchClaimReminder('lead-1', 10)).toBe(true);

    // 重建实例后轮次从 1 重来：旧实例的提醒额度不能压住新实例。
    expect(consumeDispatchClaimReminder('lead-1', 1)).toBe(true);
    expect(consumeDispatchClaimReminder('lead-1', 1)).toBe(false);
  });
});
