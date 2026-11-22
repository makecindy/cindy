import { afterEach, describe, expect, it } from 'vitest';
import {
  dispatchFactsForTurn,
  dispatchReconcileFloor,
  dropLeadDispatchFact,
  noteLeadDispatchFact,
  noteLeadTurnDeclaration,
  reconcileLeadTurnDeclaration,
  resetDispatchClaimState,
  settleDispatchClaimIncident,
  toDispatchClaimNotice,
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

describe('lead turn declaration reconciliation', () => {
  it('accepts a declaration that matches the host dispatch records', () => {
    noteLeadDispatchFact('lead-1', fact());

    noteLeadTurnDeclaration('lead-1', {
      assignments: [{ workerId: 'worker-1', taskSummary: 'Take the export bug.' }],
      dispatched: [{ workerId: 'worker-1', messageId: 'mq-1' }],
      pending: [],
      turnGeneration: 0,
    });

    expect(
      reconcileLeadTurnDeclaration('lead-1', dispatchFactsForTurn('lead-1', 0)),
    ).toEqual({ consistent: true });
  });

  it('catches an assignment the lead declared but never dispatched', () => {
    noteLeadTurnDeclaration('lead-1', {
      assignments: [{ workerId: 'worker-1', taskSummary: 'Classify the 199 cases.' }],
      dispatched: [],
      pending: [],
      turnGeneration: 0,
    });

    expect(reconcileLeadTurnDeclaration('lead-1', [])).toEqual({
      consistent: false,
      reason: 'declared-not-dispatched',
      targets: ['worker-1'],
      detail: 'worker-1',
    });
  });

  it('accepts an assignment the lead parked as pending', () => {
    noteLeadTurnDeclaration('lead-1', {
      assignments: [{ workerId: 'worker-1', taskSummary: 'Classify the 199 cases.' }],
      dispatched: [],
      pending: [{ workerId: 'worker-1', waitingFor: 'the owner to confirm the scope' }],
      turnGeneration: 0,
    });

    expect(reconcileLeadTurnDeclaration('lead-1', [])).toEqual({ consistent: true });
  });

  it('catches a dispatch the declaration leaves out', () => {
    noteLeadDispatchFact('lead-1', fact());
    noteLeadTurnDeclaration('lead-1', {
      assignments: [],
      dispatched: [],
      pending: [],
      turnGeneration: 0,
    });

    expect(
      reconcileLeadTurnDeclaration('lead-1', dispatchFactsForTurn('lead-1', 0)),
    ).toEqual({
      consistent: false,
      reason: 'dispatched-not-declared',
      targets: ['research'],
      detail: 'research',
    });
  });

  it('catches a queued message id that matches no dispatch', () => {
    noteLeadDispatchFact('lead-1', fact());
    noteLeadTurnDeclaration('lead-1', {
      assignments: [],
      dispatched: [{ workerId: 'worker-1', messageId: 'mq-404' }],
      pending: [],
      turnGeneration: 0,
    });

    expect(
      reconcileLeadTurnDeclaration('lead-1', dispatchFactsForTurn('lead-1', 0)),
    ).toEqual({
      consistent: false,
      reason: 'unknown-message-id',
      targets: ['research'],
      detail: 'mq-404',
    });
  });

  it('catches a turn that dispatched without declaring anything', () => {
    noteLeadDispatchFact('lead-1', fact());

    expect(
      reconcileLeadTurnDeclaration('lead-1', dispatchFactsForTurn('lead-1', 0)),
    ).toEqual({
      consistent: false,
      reason: 'no-declaration',
      targets: ['research'],
      detail: 'research',
    });
  });

  it('matches a queued message id against every dispatch the worker received', () => {
    for (const id of ['mq-1', 'mq-2']) {
      noteLeadDispatchFact('lead-1', fact({ dispatchId: id, queuedMessageId: id }));
    }
    noteLeadTurnDeclaration('lead-1', {
      assignments: [{ workerId: 'worker-1', taskSummary: 'Take the export bug.' }],
      dispatched: [{ workerId: 'worker-1', messageId: 'mq-1' }],
      pending: [],
      turnGeneration: 0,
    });

    expect(
      reconcileLeadTurnDeclaration('lead-1', dispatchFactsForTurn('lead-1', 0)),
    ).toEqual({ consistent: true });
  });

  it('keeps the record window at the turn that started the incident across the wake turn', () => {
    noteLeadDispatchFact(
      'lead-1',
      fact({
        dispatchId: 'mq-4',
        queuedMessageId: 'mq-4',
        turnGeneration: 4,
        at: Date.now() - 60_000,
      }),
    );
    noteLeadTurnDeclaration('lead-1', {
      assignments: [{ workerId: 'worker-1', taskSummary: 'Take the export bug.' }],
      dispatched: [],
      pending: [],
      turnGeneration: 4,
    });
    expect(reconcileLeadTurnDeclaration('lead-1', dispatchFactsForTurn('lead-1', 4)).consistent).toBe(
      false,
    );
    expect(settleDispatchClaimIncident('lead-1', false, 4)).toBe('wake');

    // 唤醒开的新一轮：账仍是第 4 轮那笔，凭据不能被新一轮的生成号挡掉。
    const floor = dispatchReconcileFloor('lead-1', 7);
    expect(floor).toBe(4);
    expect(
      dispatchFactsForTurn('lead-1', 7, floor).map((entry) => entry.dispatchId),
    ).toEqual(['mq-4']);

    settleDispatchClaimIncident('lead-1', true, 7);
    expect(dispatchReconcileFloor('lead-1', 7)).toBe(7);
  });

  it('stays silent on a turn that dispatched nothing and declared nothing', () => {
    expect(reconcileLeadTurnDeclaration('lead-1', [])).toEqual({ consistent: true });
  });

  it('clears the declaration once it reconciles so the next turn must declare again', () => {
    noteLeadDispatchFact('lead-1', fact());
    noteLeadTurnDeclaration('lead-1', {
      assignments: [],
      dispatched: [{ workerId: 'worker-1' }],
      pending: [],
      turnGeneration: 0,
    });

    expect(
      reconcileLeadTurnDeclaration('lead-1', dispatchFactsForTurn('lead-1', 0)),
    ).toEqual({ consistent: true });

    noteLeadDispatchFact('lead-1', fact({ dispatchId: 'mq-2', turnGeneration: 1 }));

    expect(
      reconcileLeadTurnDeclaration('lead-1', dispatchFactsForTurn('lead-1', 1)),
    ).toEqual({
      consistent: false,
      reason: 'no-declaration',
      targets: ['research'],
      detail: 'research',
    });
  });

  it('forgets a declaration when the session instance restarts', () => {
    noteLeadTurnDeclaration('lead-1', {
      assignments: [{ workerId: 'worker-1', taskSummary: 'Take the export bug.' }],
      dispatched: [],
      pending: [],
      turnGeneration: 8,
    });

    // 先把账本推进到第 8 轮，再让收口看到回退的生成号：会话实例变了，旧声明不能跨实例继续算账。
    dispatchFactsForTurn('lead-1', 8);
    dispatchFactsForTurn('lead-1', 0);

    expect(reconcileLeadTurnDeclaration('lead-1', [])).toEqual({ consistent: true });
  });

  it('keeps a fresh declaration when the session instance restarts', () => {
    // 旧实例的账本停在第 8 轮；重建会话后第 1 轮就交了声明，收口才发现代次回退。
    dispatchFactsForTurn('lead-1', 8);
    noteLeadTurnDeclaration('lead-1', {
      assignments: [{ workerId: 'worker-1', taskSummary: 'Take the export bug.' }],
      dispatched: [],
      pending: [],
      turnGeneration: 1,
    });

    const verdict = reconcileLeadTurnDeclaration('lead-1', dispatchFactsForTurn('lead-1', 1));
    if (verdict.consistent) throw new Error('expected an inconsistent verdict');
    expect(verdict.reason).toBe('declared-not-dispatched');
  });

  it('asks once, then escalates, then stays quiet until a real dispatch resets it', () => {
    expect(settleDispatchClaimIncident('lead-1', false, 0)).toBe('wake');
    expect(settleDispatchClaimIncident('lead-1', false, 0)).toBe('escalate');
    expect(settleDispatchClaimIncident('lead-1', false, 0)).toBeNull();

    noteLeadDispatchFact('lead-1', fact({ turnGeneration: 1 }));
    expect(settleDispatchClaimIncident('lead-1', false, 1)).toBe('wake');
  });

  it('does not re-arm the wake for a fact that lands after its turn settled', () => {
    // 第 5 轮派发、收口时没交声明→唤醒一次。
    noteLeadDispatchFact('lead-1', fact({ turnGeneration: 5 }));
    dispatchFactsForTurn('lead-1', 5);
    expect(settleDispatchClaimIncident('lead-1', false, 5)).toBe('wake');

    // 同一笔派发迟到落地（仍在第 5 轮）：账本不能因此重新武装，唤醒轮不能被告知「本轮派了」。
    noteLeadDispatchFact('lead-1', fact({ turnGeneration: 5, dispatchId: 'mq-2' }));
    expect(settleDispatchClaimIncident('lead-1', false, 6)).toBe('escalate');
  });

  it('keeps the open incident when a stale fact arrives', () => {
    dispatchFactsForTurn('lead-1', 8);
    noteLeadTurnDeclaration('lead-1', {
      assignments: [{ workerId: 'worker-1', taskSummary: 'Take the export bug.' }],
      dispatched: [],
      pending: [],
      turnGeneration: 8,
    });

    noteLeadDispatchFact('lead-1', fact({ turnGeneration: 3 }));

    expect(dispatchFactsForTurn('lead-1', 8)).toHaveLength(0);
    const verdict = reconcileLeadTurnDeclaration('lead-1', []);
    if (verdict.consistent) throw new Error('expected the declaration to survive');
    expect(verdict.reason).toBe('declared-not-dispatched');
  });

  it('drops a fact once the dispatch is retracted', () => {
    noteLeadDispatchFact('lead-1', fact());
    expect(dispatchFactsForTurn('lead-1', 0)).toHaveLength(1);

    dropLeadDispatchFact('lead-1', 'mq-1');
    expect(dispatchFactsForTurn('lead-1', 0)).toHaveLength(0);
  });

  it('builds the escalation notice from the reconciliation verdict', () => {
    noteLeadTurnDeclaration('lead-1', {
      assignments: [],
      dispatched: [{ workerId: 'worker-1', messageId: 'mq-404' }],
      pending: [],
      turnGeneration: 0,
    });
    const verdict = reconcileLeadTurnDeclaration('lead-1', []);
    if (verdict.consistent) throw new Error('expected an inconsistent verdict');

    expect(toDispatchClaimNotice(verdict)).toEqual({
      version: 1,
      state: 'unverified',
      targets: ['worker-1'],
      reason: 'declared-not-dispatched',
      detail: 'worker-1',
      at: expect.any(Number),
    });
  });
});
