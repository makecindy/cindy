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
  it('flags a wake_kind the protocol never issues', () => {
    expect(findUnbackedDispatchClaim('已派修（wake_kind=accepted），等它交回。')).toEqual({
      kind: 'wake-kind',
      token: 'accepted',
      label: 'wake_kind',
    });
  });

  it('flags a fabricated wake_kind even when the host dispatched in this session', () => {
    noteLeadDispatchFact('lead-1', fact());

    expect(findUnbackedDispatchClaim('派了（wake_kind=dispatched），在跑。')).toMatchObject({
      kind: 'wake-kind',
      token: 'dispatched',
    });
  });

  it('accepts every wake_kind value the protocol can return', () => {
    for (const token of ['resumed', 'already-active', 'queued', 'created']) {
      expect(findUnbackedDispatchClaim(`已派（wake_kind=${token}）。`)).toBeNull();
    }
  });

  it('leaves a dispatch id alone — a missing id does not mean a fabricated one', () => {
    expect(
      findUnbackedDispatchClaim('派了：queued_message_id: e47e4ix8u7vjpxzd0ixrivw8'),
    ).toBeNull();
  });

  it('leaves an id alone even when the ledger holds other dispatches', () => {
    noteLeadDispatchFact('lead-1', { ...fact(), queuedMessageId: 'realidrealidrealid12' });

    expect(
      findUnbackedDispatchClaim(
        '两笔：queued_message_id: realidrealidrealid12 与 queued_message_id: abcdefgh123456',
      ),
    ).toBeNull();
  });

  it('leaves plain prose alone — it carries no protocol token to check', () => {
    expect(findUnbackedDispatchClaim('已派给 research 去改注入表了。')).toBeNull();
  });
});

describe('claim reminder budget', () => {
  it('allows one reminder per turn', () => {
    expect(consumeDispatchClaimReminder('lead-1', 3)).toBe(true);
    expect(consumeDispatchClaimReminder('lead-1', 3)).toBe(false);
    expect(consumeDispatchClaimReminder('lead-1', 4)).toBe(true);
  });

  it('does not repeat the same claim when the turn generation advances', () => {
    const claim = { kind: 'id', token: 'fakeidfakeidfakeid34' };
    expect(consumeDispatchClaimReminder('lead-1', 5, claim)).toBe(true);
    // 纠正会开启新一轮，轮次号前进；同一条假凭据不该再提醒一次。
    expect(consumeDispatchClaimReminder('lead-1', 6, claim)).toBe(false);
    expect(consumeDispatchClaimReminder('lead-1', 7, claim)).toBe(false);
    // 换一条凭据仍然可以提醒。
    expect(
      consumeDispatchClaimReminder('lead-1', 8, { kind: 'id', token: 'otheridotheridother8' }),
    ).toBe(true);
  });

  it('re-arms after the session instance restarts', () => {
    expect(consumeDispatchClaimReminder('lead-1', 9)).toBe(true);
    expect(consumeDispatchClaimReminder('lead-1', 9)).toBe(false);

    // 重建实例后轮次从 1 重来：旧实例的提醒额度不能压住新实例。
    expect(consumeDispatchClaimReminder('lead-1', 1)).toBe(true);
  });
});
