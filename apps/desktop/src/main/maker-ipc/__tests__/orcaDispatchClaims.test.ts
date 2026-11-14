import { describe, expect, it, beforeEach } from 'vitest';
import {
  detectDispatchClaim,
  dispatchFactsForTurn,
  dropLeadDispatchFact,
  noteLeadDispatchFact,
  resetDispatchClaimState,
  settleDispatchClaimIncident,
  verifyDispatchClaim,
  type LeadDispatchFact,
} from '../orcaDispatchClaims.js';

const LEAD = 'lead-session';

function fact(overrides: Partial<LeadDispatchFact> = {}): LeadDispatchFact {
  return {
    leadSessionId: LEAD,
    turnGeneration: 3,
    workerId: 'worker-1',
    workerLabel: '研究员',
    delivery: 'direct',
    at: 1,
    ...overrides,
  };
}

describe('orca dispatch claim verification', () => {
  beforeEach(() => {
    resetDispatchClaimState();
  });

  it('accepts a claim backed by a dispatch in the same turn', () => {
    noteLeadDispatchFact(fact());
    const reading = detectDispatchClaim('已派给研究员，等他回报。');
    expect(reading.claimed).toBe(true);
    expect(verifyDispatchClaim(reading, dispatchFactsForTurn(LEAD, 3))).toEqual({ consistent: true });
  });

  it('rejects a claim with no dispatch record in this turn', () => {
    noteLeadDispatchFact(fact({ turnGeneration: 1 }));
    const reading = detectDispatchClaim('已派给研究员，等他回报。');
    expect(verifyDispatchClaim(reading, dispatchFactsForTurn(LEAD, 3))).toMatchObject({
      consistent: false,
      reason: 'no-dispatch',
    });
  });

  it('does not treat plans or analysis as a dispatch claim', () => {
    expect(detectDispatchClaim('我会派给研究员，先看一下目录。').claimed).toBe(false);
    expect(detectDispatchClaim('准备派发，但还缺一份数据。').claimed).toBe(false);
    expect(detectDispatchClaim('I will dispatch this to the worker next.').claimed).toBe(false);
  });

  it('rejects an invented queue id and accepts the real one', () => {
    const real = '11111111-2222-3333-4444-555555555555';
    const fake = '99999999-8888-7777-6666-555555555555';
    noteLeadDispatchFact(fact({ delivery: 'queued', queuedMessageId: real }));
    const facts = dispatchFactsForTurn(LEAD, 3);
    expect(verifyDispatchClaim(detectDispatchClaim(`已派给研究员，排队号 ${real}`), facts)).toEqual({ consistent: true });
    expect(verifyDispatchClaim(detectDispatchClaim(`已派给研究员，排队号 ${fake}`), facts)).toMatchObject({
      consistent: false,
      reason: 'unknown-message-id',
    });
  });

  it('drops withdrawn dispatches so a queued claim loses its backing', () => {
    noteLeadDispatchFact(fact({ delivery: 'queued', queuedMessageId: 'queue-1' }));
    dropLeadDispatchFact(LEAD, 'queue-1');
    expect(dispatchFactsForTurn(LEAD, 3)).toEqual([]);
  });

  it('wakes once, then escalates instead of repeating', () => {
    expect(settleDispatchClaimIncident(LEAD, false)).toBe('wake');
    expect(settleDispatchClaimIncident(LEAD, false)).toBe('escalate');
    expect(settleDispatchClaimIncident(LEAD, false)).toBeNull();
  });

  it('stays silent after a consistent turn and resumes on a fresh incident', () => {
    expect(settleDispatchClaimIncident(LEAD, false)).toBe('wake');
    expect(settleDispatchClaimIncident(LEAD, true)).toBeNull();
    expect(settleDispatchClaimIncident(LEAD, false)).toBe('wake');
  });

  it('stops escalating once a real dispatch lands', () => {
    settleDispatchClaimIncident(LEAD, false);
    settleDispatchClaimIncident(LEAD, false);
    expect(settleDispatchClaimIncident(LEAD, false)).toBeNull();
    noteLeadDispatchFact(fact());
    expect(settleDispatchClaimIncident(LEAD, false)).toBe('wake');
  });
});
