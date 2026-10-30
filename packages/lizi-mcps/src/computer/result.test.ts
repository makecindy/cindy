import { describe, expect, it } from 'vitest';
import { computerResultOutcome } from './result.js';

describe('Computer Use result evidence', () => {
  it.each(['partial', 'unverifiable', 'suspected_noop'])(
    'does not report %s as confirmed',
    (effect) => {
      expect(computerResultOutcome('click', { effect })).toMatchObject({
        ok: true,
        outcome: { status: 'unknown', next_step: 'verify_state' },
      });
    },
  );
  it.each([{ ok: false }, { isError: true }, { effect: 'refused' }])(
    'preserves driver failures: %j',
    (data) => {
      expect(computerResultOutcome('click', data)).toMatchObject({
        ok: false,
        outcome: { status: 'failed' },
      });
    },
  );
  it.each([
    null,
    'satisfied',
    [],
    {},
    { status: 'unknown' },
    { status: 'unsatisfied' },
    { status: 'satisfied', stable: false },
  ])('requires interpretable verification evidence: %j', (data) => {
    expect(computerResultOutcome('verify_state', data)).toMatchObject({
      ok: false,
      errorCode: 'POSTCONDITION_NOT_SATISFIED',
    });
  });
  it('confirms only a satisfied verification', () => {
    expect(computerResultOutcome('verify_state', { status: 'satisfied' })).toEqual({
      ok: true,
      outcome: { status: 'confirmed', next_step: 'done' },
    });
  });
});
