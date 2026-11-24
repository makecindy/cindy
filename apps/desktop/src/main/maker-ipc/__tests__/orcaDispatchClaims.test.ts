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

  it('flags a labeled dispatch id that exists nowhere in the ledger', () => {
    expect(
      findUnbackedDispatchClaim('lead-1', '派了：queued_message_id: e47e4ix8u7vjpxzd0ixrivw8'),
    ).toEqual({ kind: 'id', token: 'e47e4ix8u7vjpxzd0ixrivw8', label: 'queued_message_id' });
  });

  it('accepts an id dispatched in an earlier turn', () => {
    noteLeadDispatchFact('lead-1', fact({ queuedMessageId: 'cvpssg60na9s2ona9dh7327s' }));

    expect(
      findUnbackedDispatchClaim('lead-1', '上一条的 queued_message_id: cvpssg60na9s2ona9dh7327s 已消费。'),
    ).toBeNull();
  });

  it('leaves plain prose alone — it carries no protocol token to check', () => {
    expect(findUnbackedDispatchClaim('lead-1', '已派给 research 去改注入表了。')).toBeNull();
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

  it('re-arms after the session instance restarts', () => {
    expect(consumeDispatchClaimReminder('lead-1', 9)).toBe(true);
    expect(consumeDispatchClaimReminder('lead-1', 9)).toBe(false);

    // 重建实例后轮次从 1 重来：旧实例的提醒额度不能压住新实例。
    expect(consumeDispatchClaimReminder('lead-1', 1)).toBe(true);
  });
});
