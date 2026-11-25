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
    turnGeneration: 0,
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
        turnGeneration: 8,
        instanceToken: sessionInstanceToken(oldSession),
      }),
    );
    expect(dispatchFactsForTurn('lead-1', 8)).toHaveLength(1);

    noteLeadDispatchFact(
      'lead-1',
      fact({
        dispatchId: 'mq-new',
        turnGeneration: 1,
        instanceToken: sessionInstanceToken(newSession),
      }),
    );

    expect(dispatchFactsForTurn('lead-1', 1).map((entry) => entry.dispatchId)).toEqual(['mq-new']);
  });

  it('keeps the current ledger when a late fact from an older turn lands', () => {
    noteLeadDispatchFact('lead-1', fact({ dispatchId: 'mq-1', turnGeneration: 4 }));
    // 投递落地晚于所属轮次收口：迟到的旧凭据不改账本轮次，也不抹掉现有凭据。
    noteLeadDispatchFact('lead-1', fact({ dispatchId: 'mq-2', turnGeneration: 2 }));

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
    noteLeadDispatchFact('lead-1', fact({ dispatchId: 'mq-real', turnGeneration: 9 }));
    // 先把账本推到第 9 轮，再回退：这样才真的走进回退分支。
    expect(dispatchFactsForTurn('lead-1', 9)).toHaveLength(1);
    expect(dispatchFactsForTurn('lead-1', 2).map((entry) => entry.dispatchId)).toEqual(['mq-real']);
    expect(findUnbackedDispatchClaim('lead-1', '回执 wake_kind=resumed')).toBeNull();
  });

  it('treats an unknown turn number as neither progress nor a rollback', () => {
    // Stop hook 可能在本轮事件投递前触发，那时宿主只知道「0」。
    // 当成回退处理会清掉提醒额度，同一句声称就会被反复纠正。
    expect(consumeDispatchClaimReminder('lead-1', 3, 'spoken:research')).toBe(true);
    expect(dispatchFactsForTurn('lead-1', 0)).toEqual([]);
    expect(consumeDispatchClaimReminder('lead-1', 0, 'spoken:research')).toBe(false);
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
  it('flags a wake_kind value while the host recorded no dispatch at all', () => {
    expect(
      findUnbackedDispatchClaim('lead-1', '已派修（wake_kind=already-active），等它交回。'),
    ).toEqual({ kind: 'wake-kind', token: 'already-active', label: 'wake_kind' });
  });

  it('accepts a wake_kind recap once the host has dispatches to back it', () => {
    noteLeadDispatchFact('lead-1', fact());

    expect(
      findUnbackedDispatchClaim('lead-1', '上一笔 wake_kind=queued 还在队列里。'),
    ).toBeNull();
  });

  it('leaves a cited queue id alone — the host prints those ids itself', () => {
    // 入站排队回报的编号由宿主以 `queued_message_id:` 写进 Lead 的输入，提示词还要求
    // Lead 用它去 steer。拿它去核对只会把复述真编号拦下来。
    expect(
      findUnbackedDispatchClaim('lead-1', '派了：queued_message_id: e47e4ix8u7vjpxzd0ixrivw8'),
    ).toBeNull();
    noteLeadDispatchFact('lead-1', fact({ queuedMessageId: 'cvpssg60na9s2ona9dh7327s' }));
    expect(
      findUnbackedDispatchClaim('lead-1', '上一条的 queued_message_id: cvpssg60na9s2ona9dh7327s 已消费。'),
    ).toBeNull();
  });

  it('leaves plain prose alone — it carries no protocol token to check', () => {
    expect(findUnbackedDispatchClaim('lead-1', '已派给 research 去改注入表了。')).toBeNull();
  });

  it('does not flag a wake_kind recap once the ledger has any dispatch', () => {
    // 账本非空时分不清它复述的是哪一次，误判代价高——那条路交给语义层。
    noteLeadDispatchFact('lead-1', fact({}));
    expect(findUnbackedDispatchClaim('lead-1', '上一笔 wake_kind=queued。')).toBeNull();
  });

  it('flags a wake_kind value the host never issues, even with dispatches recorded', () => {
    // “账本非空就不管”只对真值成立；协议里不存在的值不可能来自某次派发。
    noteLeadDispatchFact('lead-1', fact({}));
    expect(findUnbackedDispatchClaim('lead-1', '已派工（wake_kind=dispatched）。')).toEqual({
      kind: 'wake-kind',
      token: 'dispatched',
      label: 'wake_kind',
    });
  });

  it('reports the first problem only, so one reminder names one place', () => {
    expect(
      findUnbackedDispatchClaim('lead-1', 'wake_kind=queued，编号 queued_message_id: abcdefgh1234'),
    )?.toMatchObject({ kind: 'wake-kind' });
  });
});

describe('claim reminder budget', () => {
  it('allows one reminder per turn', () => {
    expect(consumeDispatchClaimReminder('lead-1', 3)).toBe(true);
    expect(consumeDispatchClaimReminder('lead-1', 3)).toBe(false);
    expect(consumeDispatchClaimReminder('lead-1', 4)).toBe(true);
  });

  it('corrects a different claim on the next turn, so a later dispatch is still checked', () => {
    expect(consumeDispatchClaimReminder('lead-1', 5, 'id:aaaaaaaaaaaa')).toBe(true);
    // 一轮里可派多次：按会话静默会把后来那几次的假凭据一起放过。
    expect(consumeDispatchClaimReminder('lead-1', 6, 'id:bbbbbbbbbbbb')).toBe(true);
  });

  it('corrects one claim once, even when a later turn restates it', () => {
    expect(consumeDispatchClaimReminder('lead-1', 7, 'id:cccccccccccc')).toBe(true);
    // 复述同一件事不是新问题：每轮都纠一遍就是「一单纠正四次」。
    expect(consumeDispatchClaimReminder('lead-1', 8, 'id:cccccccccccc')).toBe(false);
    expect(consumeDispatchClaimReminder('lead-1', 9, 'id:cccccccccccc')).toBe(false);
  });

  it('re-arms after the session instance restarts', () => {
    expect(consumeDispatchClaimReminder('lead-1', 9, 'id:dddddddddddd')).toBe(true);
    expect(consumeDispatchClaimReminder('lead-1', 9, 'id:dddddddddddd')).toBe(false);

    // 重建实例后轮次从 1 重来：旧实例的提醒额度不能压住新实例。
    expect(consumeDispatchClaimReminder('lead-1', 1)).toBe(true);
  });
});
