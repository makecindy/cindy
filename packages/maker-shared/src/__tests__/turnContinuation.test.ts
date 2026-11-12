import { describe, expect, it } from 'vitest';

import {
  isProductTurnCompletionTailEvent,
  isProductTurnDoneEvent,
  isTurnContinuationBoundaryEvent,
} from '../turnContinuation.js';

describe('turn continuation predicates', () => {
  it('accepts only safe non-negative integer continuation ids', () => {
    expect(isTurnContinuationBoundaryEvent({ type: 'done', turnContinuationId: 0 })).toBe(true);
    expect(isTurnContinuationBoundaryEvent({ type: 'status', turnContinuationId: 7 })).toBe(true);

    for (const turnContinuationId of [
      undefined,
      null,
      '7',
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(isTurnContinuationBoundaryEvent({ type: 'done', turnContinuationId })).toBe(false);
    }
  });

  it('keeps a claimed done out of product completion while an unclaimed done closes it', () => {
    expect(isProductTurnDoneEvent({ type: 'done', data: { reason: 'final' } })).toBe(true);
    expect(
      isProductTurnDoneEvent({ type: 'done', data: { reason: 'sdk-turn' }, turnContinuationId: 1 }),
    ).toBe(false);
    expect(isProductTurnDoneEvent({ type: 'status', data: { status: 'Done', isRunning: false } })).toBe(false);
  });

  it('pairs terminal status and done claims consistently', () => {
    const terminalStatus = { type: 'status', data: { status: 'Done', isRunning: false } };
    const claimedTerminalStatus = { ...terminalStatus, turnContinuationId: 3 };

    expect(isProductTurnCompletionTailEvent(terminalStatus)).toBe(true);
    expect(isProductTurnCompletionTailEvent({ type: 'done' })).toBe(true);
    expect(isProductTurnCompletionTailEvent(claimedTerminalStatus)).toBe(false);
    expect(
      isProductTurnCompletionTailEvent({ type: 'done', turnContinuationId: 3 }),
    ).toBe(false);

    expect(isProductTurnCompletionTailEvent({ type: 'status', data: { status: 'Working', isRunning: false } })).toBe(false);
    expect(isProductTurnCompletionTailEvent({ type: 'status', data: { status: 'Done', isRunning: true } })).toBe(false);
    expect(isProductTurnCompletionTailEvent({ type: 'status', data: null })).toBe(false);
    expect(
      isProductTurnCompletionTailEvent({
        type: 'status',
        turnScope: 'background',
        data: { status: 'Done', isRunning: false },
      }),
    ).toBe(false);
    expect(isProductTurnCompletionTailEvent({ type: 'done', turnScope: 'background' })).toBe(false);
  });
});
