import { describe, expect, it, vi } from 'vitest';

import { RecoveryPlanSettlement } from '../recoveryPlanSettlement.js';

const PLAN = {
  clientId: 'plan-row-client',
  toolUseId: 'plan:failed-turn',
  turnId: 'failed-turn',
  input: { plan: [{ step: 'Recover', status: 'in_progress' }] },
};
const GENERATION = 11;

describe('RecoveryPlanSettlement', () => {
  it('returns the predecessor plan only at the matching successful recovery terminal', () => {
    const book = new RecoveryPlanSettlement();
    book.arm('s1', 'recovery-user', 7, GENERATION, PLAN);
    expect(book.ownsPredecessorPlan('s1', 'plan:failed-turn')).toBe(true);

    expect(
      book.settleDone(
        's1',
        6,
        { raw: { id: 'stale-turn', status: 'completed' } },
        'foreground',
        GENERATION,
      ),
    ).toBeNull();
    expect(
      book.settleDone(
        's1',
        7,
        { raw: { id: 'recovery-turn', status: 'completed' } },
        'foreground',
        GENERATION,
      ),
    ).toEqual(PLAN);
    expect(book.ownsPredecessorPlan('s1', 'plan:failed-turn')).toBe(false);
    expect(
      book.settleDone(
        's1',
        7,
        { raw: { id: 'recovery-turn', status: 'completed' } },
        'foreground',
        GENERATION,
      ),
    ).toBeNull();
  });

  it('keeps the plan open when recovery fails or is interrupted', () => {
    const book = new RecoveryPlanSettlement();
    book.arm('s1', 'recovery-user', 7, GENERATION, PLAN);

    expect(
      book.settleDone(
        's1',
        7,
        { raw: { id: 'recovery-turn', status: 'interrupted' } },
        'foreground',
        GENERATION,
      ),
    ).toBeNull();
    expect(book.hasPending('s1')).toBe(false);

    book.arm('s1', 'recovery-user-2', 8, GENERATION, PLAN);
    expect(book.settleError('s1', 8, null, 'foreground', GENERATION)).toBe(true);
    expect(book.hasPending('s1')).toBe(false);

    book.arm('s1', 'recovery-user-3', 9, GENERATION, PLAN);
    expect(
      book.settleDone(
        's1',
        9,
        {
          cancelled: true,
          raw: { id: 'cancelled-recovery-turn', status: 'completed' },
        },
        'foreground',
        GENERATION,
      ),
    ).toBeNull();
    expect(book.hasPending('s1')).toBe(false);
  });

  it('ignores a late terminal event from the predecessor turn', () => {
    const book = new RecoveryPlanSettlement();
    book.arm('s1', 'manual-recovery-user', null, GENERATION, PLAN);

    expect(book.settleError('s1', null, null, 'foreground', GENERATION, false)).toBe(false);
    expect(book.hasPending('s1')).toBe(true);
    expect(
      book.settleDone(
        's1',
        null,
        { raw: { id: 'failed-turn', status: 'failed' } },
        'foreground',
        GENERATION - 1,
        false,
      ),
    ).toBeNull();
    expect(book.hasPending('s1')).toBe(true);
    expect(
      book.settleDone(
        's1',
        null,
        {
          raw: { id: 'manual-recovery-turn', status: 'failed' },
        },
        'foreground',
        GENERATION,
      ),
    ).toBeNull();
    expect(book.hasPending('s1')).toBe(false);

    book.arm('s1', 'manual-recovery-user-2', null, GENERATION + 1, PLAN);
    expect(
      book.settleDone(
        's1',
        null,
        {
          raw: { id: 'manual-recovery-turn-2', status: 'interrupted' },
        },
        'foreground',
        GENERATION + 1,
      ),
    ).toBeNull();
    expect(book.hasPending('s1')).toBe(false);

    book.arm('s1', 'manual-recovery-user-3', null, GENERATION + 2, PLAN);
    expect(
      book.settleDone(
        's1',
        null,
        { raw: { id: 'manual-recovery-turn-3', status: 'completed' } },
        'foreground',
        GENERATION + 2,
      ),
    ).toEqual(PLAN);
  });

  it('does not let background terminals settle a foreground recovery', () => {
    const book = new RecoveryPlanSettlement();
    book.arm('s1', 'recovery-user', null, GENERATION, PLAN);

    expect(
      book.settleDone(
        's1',
        null,
        { raw: { id: 'background-turn', status: 'completed' } },
        'background',
        GENERATION,
      ),
    ).toBeNull();
    expect(book.hasPending('s1')).toBe(true);
    expect(book.settleError('s1', null, 'background-turn', 'background', GENERATION)).toBe(false);
    expect(book.hasPending('s1')).toBe(true);
  });

  it('does not let an ordinary success seal after the owned recovery ended with an id-less error', () => {
    const book = new RecoveryPlanSettlement();
    book.arm('s1', 'manual-recovery-user', null, GENERATION, PLAN);

    expect(book.settleError('s1', null, null, 'foreground', GENERATION, true)).toBe(true);
    expect(book.hasPending('s1')).toBe(false);
    expect(
      book.settleDone(
        's1',
        null,
        { raw: { id: 'ordinary-later-turn', status: 'completed' } },
        'foreground',
        GENERATION + 1,
        true,
      ),
    ).toBeNull();
  });

  it('does not settle from a late terminal whose provider generation is no longer current', () => {
    const book = new RecoveryPlanSettlement();
    book.arm('s1', 'manual-recovery-user', null, GENERATION, PLAN);

    expect(
      book.settleDone(
        's1',
        null,
        { raw: { id: 'stale-non-predecessor-turn', status: 'completed' } },
        'foreground',
        GENERATION,
        false,
      ),
    ).toBeNull();
    expect(book.hasPending('s1')).toBe(true);
  });

  it('cannot arm a recovery row cancelled on either side of its durable-write race', () => {
    const book = new RecoveryPlanSettlement();
    book.cancelUndispatched('s1', 'cancelled-before-arm');
    book.teardown('s1');
    book.arm('s1', 'cancelled-before-arm', 7, GENERATION, PLAN);
    expect(book.hasPending('s1')).toBe(false);

    book.arm('s1', 'cancelled-after-arm', 8, GENERATION, PLAN);
    book.cancelUndispatched('s1', 'cancelled-after-arm');
    expect(book.hasPending('s1')).toBe(false);
  });

  it('closes immediately but never arms a failed or undispatched durable recovery row', async () => {
    const failed = new RecoveryPlanSettlement();
    const closeFailed = vi.fn();
    await expect(
      failed.persistUserBoundary({
        sessionId: 's1',
        recoveryUserClientId: 'failed-write',
        attemptToken: 7,
        providerGeneration: GENERATION,
        plan: PLAN,
        closePlanUpdates: closeFailed,
        persist: () => Promise.reject(new Error('write failed')),
      }),
    ).rejects.toThrow('write failed');
    expect(closeFailed).toHaveBeenCalledTimes(1);
    expect(failed.hasPending('s1')).toBe(false);

    const cancelled = new RecoveryPlanSettlement();
    let releaseWrite!: () => void;
    const write = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const pending = cancelled.persistUserBoundary({
      sessionId: 's2',
      recoveryUserClientId: 'cancelled-write',
      attemptToken: 8,
      providerGeneration: GENERATION,
      plan: PLAN,
      closePlanUpdates: () => {},
      persist: () => write,
    });
    cancelled.cancelUndispatched('s2', 'cancelled-write');
    releaseWrite();
    await pending;
    expect(cancelled.hasPending('s2')).toBe(false);
  });
});
