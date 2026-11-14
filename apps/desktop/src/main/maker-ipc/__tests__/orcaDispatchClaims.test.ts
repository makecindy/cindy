/**
 * Lead 派单主张对账：宿主只认派发凭据，不认 Lead 文本里的「已派给 X」。
 * 判据集中在 orcaDispatchClaims，服务层只按 wake / escalate 动作执行。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  dispatchFactsForTurn,
  dropLeadDispatchFact,
  noteLeadDispatchFact,
  readDispatchClaim,
  resetDispatchClaimState,
  settleDispatchClaimIncident,
  verifyDispatchClaim,
  type LeadDispatchFact,
} from '../orcaDispatchClaims.js';

const LEAD = 'lead-1';
const ROSTER = [
  { id: 'worker-1', label: '研究员' },
  { id: 'worker-2', label: '执行员' },
];
const QUEUE_ID = '11111111-2222-3333-4444-555555555555';

function fact(overrides: Partial<LeadDispatchFact> = {}): LeadDispatchFact {
  return {
    dispatchId: `d-${Math.random().toString(16).slice(2)}`,
    workerId: 'worker-1',
    workerLabel: '研究员',
    delivery: 'direct',
    turnGeneration: 3,
    at: 1,
    ...overrides,
  };
}

describe('lead dispatch claim reading', () => {
  beforeEach(() => resetDispatchClaimState());

  it('reads a past-tense dispatch claim and resolves the named worker', () => {
    const reading = readDispatchClaim('已派给研究员，正在等回报。', ROSTER);
    expect(reading.claimed).toBe(true);
    expect(reading.targets.map((entry) => entry.id)).toEqual(['worker-1']);
    expect(reading.quote).toContain('已派给研究员');
  });

  it('does not treat plans, negations, or quoted text as a claim', () => {
    for (const text of [
      '我准备派给研究员，先确认一下。',
      '这一轮还没有派给研究员。',
      '尚未派给研究员。',
      '用户说「已派给研究员」，但那只是一句转述。',
      '```\n已派给研究员\n```',
    ]) {
      expect(readDispatchClaim(text, ROSTER).claimed).toBe(false);
    }
  });

  it('ignores identifiers that are not labelled as a queue id', () => {
    const reading = readDispatchClaim(`已派给研究员，参考 commit ${QUEUE_ID}。`, ROSTER);
    expect(reading.claimed).toBe(true);
    expect(reading.messageIds).toEqual([]);

    const labelled = readDispatchClaim(`已派给研究员，queued_message_id: ${QUEUE_ID}`, ROSTER);
    expect(labelled.messageIds).toEqual([QUEUE_ID]);
  });

  it('ignores an old queue id the lead is quoting back', () => {
    noteLeadDispatchFact(LEAD, fact({ delivery: 'direct', turnGeneration: 3 }));
    const reading = readDispatchClaim(
      `已派给研究员，之前的错误记录是「queued_message_id: ${QUEUE_ID}」`,
      ROSTER,
    );
    expect(reading.messageIds).toEqual([]);
    expect(verifyDispatchClaim(reading, dispatchFactsForTurn(LEAD, 3))).toEqual({ consistent: true });
  });

  it('keeps a labelled queue id that is written as inline code', () => {
    const reading = readDispatchClaim(
      `已派给研究员，queued_message_id: \`${QUEUE_ID}\``,
      ROSTER,
    );
    expect(reading.messageIds).toEqual([QUEUE_ID]);
  });
});

describe('lead dispatch claim verification', () => {
  beforeEach(() => resetDispatchClaimState());

  it('accepts a claim backed by a dispatch in the same turn', () => {
    noteLeadDispatchFact(LEAD, fact());
    const reading = readDispatchClaim('已派给研究员。', ROSTER);
    expect(verifyDispatchClaim(reading, dispatchFactsForTurn(LEAD, 3))).toEqual({
      consistent: true,
    });
  });

  it('rejects a claim naming a worker that this turn did not dispatch to', () => {
    noteLeadDispatchFact(LEAD, fact());
    const reading = readDispatchClaim('已派给执行员。', ROSTER);
    expect(verifyDispatchClaim(reading, dispatchFactsForTurn(LEAD, 3))).toEqual({
      consistent: false,
      reason: 'target-not-dispatched',
      detail: '执行员',
    });
  });

  it('rejects a claim when nothing was dispatched this turn', () => {
    const reading = readDispatchClaim('已派给研究员。', ROSTER);
    expect(verifyDispatchClaim(reading, dispatchFactsForTurn(LEAD, 3))).toMatchObject({
      consistent: false,
      reason: 'no-dispatch',
    });
  });

  it('rejects a fabricated queue id even when it is written as inline code', () => {
    noteLeadDispatchFact(LEAD, fact({ turnGeneration: 3 }));
    const reading = readDispatchClaim(
      `已派给研究员，queued_message_id: \`${QUEUE_ID}\``,
      ROSTER,
    );
    expect(verifyDispatchClaim(reading, dispatchFactsForTurn(LEAD, 3))).toMatchObject({
      consistent: false,
      reason: 'unknown-message-id',
    });
  });

  it('matches a queued identifier only against queued deliveries', () => {
    noteLeadDispatchFact(LEAD, fact({ delivery: 'direct' }));
    const claimingQueued = readDispatchClaim(
      `已派给研究员，queued_message_id: ${QUEUE_ID}`,
      ROSTER,
    );
    expect(verifyDispatchClaim(claimingQueued, dispatchFactsForTurn(LEAD, 3))).toMatchObject({
      consistent: false,
      reason: 'unknown-message-id',
    });

    noteLeadDispatchFact(
      LEAD,
      fact({ delivery: 'queued', queuedMessageId: QUEUE_ID, turnGeneration: 3 }),
    );
    expect(verifyDispatchClaim(claimingQueued, dispatchFactsForTurn(LEAD, 3))).toEqual({
      consistent: true,
    });
  });

  it('drops a fact when the queued message is withdrawn before the worker reads it', () => {
    noteLeadDispatchFact(LEAD, fact({ delivery: 'queued', queuedMessageId: QUEUE_ID }));
    dropLeadDispatchFact(LEAD, QUEUE_ID);
    const reading = readDispatchClaim(`已派给研究员，queued_message_id: ${QUEUE_ID}`, ROSTER);
    expect(verifyDispatchClaim(reading, dispatchFactsForTurn(LEAD, 3))).toMatchObject({
      consistent: false,
      reason: 'no-dispatch',
    });
  });

  it('invalidates stale facts when a rebuilt session restarts turn generations', () => {
    noteLeadDispatchFact(LEAD, fact({ turnGeneration: 9 }));
    expect(dispatchFactsForTurn(LEAD, 9)).toHaveLength(1);

    // 重建 Session 后 generation 从 0 重来：旧凭据不能再给新一轮作证。
    const reading = readDispatchClaim('已派给研究员。', ROSTER);
    expect(verifyDispatchClaim(reading, dispatchFactsForTurn(LEAD, 0))).toMatchObject({
      consistent: false,
      reason: 'no-dispatch',
    });
  });
});

describe('lead dispatch claim incident', () => {
  beforeEach(() => resetDispatchClaimState());

  it('wakes once, escalates on the next unbacked claim, then stays quiet until a real dispatch', () => {
    expect(settleDispatchClaimIncident(LEAD, false)).toBe('wake');
    expect(settleDispatchClaimIncident(LEAD, false)).toBe('escalate');
    expect(settleDispatchClaimIncident(LEAD, false)).toBeNull();

    noteLeadDispatchFact(LEAD, fact());
    expect(settleDispatchClaimIncident(LEAD, true)).toBeNull();
    expect(settleDispatchClaimIncident(LEAD, false)).toBe('wake');
  });
});
