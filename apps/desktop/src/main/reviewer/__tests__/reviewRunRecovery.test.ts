import { describe, expect, it, vi } from 'vitest';

import type { ReviewRunMeta, ReviewRunOwner } from '../../../shared/reviewRun.js';
import {
  createRetryableReviewStartup,
  shouldFailInterruptedReview,
} from '../reviewRunRecovery.js';

const currentOwner: ReviewRunOwner = { instanceId: 'current', processId: 200 };

function running(owner?: ReviewRunOwner): ReviewRunMeta {
  return {
    version: 1,
    runId: 'run-1',
    sourceSessionId: 'source-1',
    reviewerSessionId: 'reviewer-1',
    status: 'running',
    targetKind: 'changes',
    startedAt: 1,
    ...(owner ? { owner } : {}),
  };
}

describe('Review run recovery ownership', () => {
  it('coalesces startup reconciliation and retries after a transient failure', async () => {
    let rejectFirst!: (error: Error) => void;
    const firstAttempt = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const start = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => firstAttempt)
      .mockResolvedValue(undefined);
    const ensureReady = createRetryableReviewStartup(start);

    const first = ensureReady();
    const concurrent = ensureReady();
    expect(concurrent).toBe(first);
    expect(start).toHaveBeenCalledTimes(1);
    rejectFirst(new Error('database is temporarily locked'));
    await expect(first).rejects.toThrow('database is temporarily locked');

    await expect(ensureReady()).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledTimes(2);
    await expect(ensureReady()).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('does not fail a run owned by this process instance', async () => {
    const probe = vi.fn(() => false);
    await expect(
      shouldFailInterruptedReview(running(currentOwner), currentOwner, probe),
    ).resolves.toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('preserves a legacy run while its foreign owner process is alive', async () => {
    const probe = vi.fn(() => true);
    await expect(
      shouldFailInterruptedReview(
        running({ instanceId: 'other', processId: 300 }),
        currentOwner,
        probe,
      ),
    ).resolves.toBe(false);
    expect(probe).toHaveBeenCalledWith(300);
  });

  it('fails a legacy run only after the foreign owner is confirmed dead', async () => {
    await expect(
      shouldFailInterruptedReview(
        running({ instanceId: 'other', processId: 300 }),
        currentOwner,
        () => false,
      ),
    ).resolves.toBe(true);
  });

  it('recognizes PID reuse by the current differently identified instance', async () => {
    const probe = vi.fn(() => true);
    await expect(
      shouldFailInterruptedReview(
        running({ instanceId: 'previous', processId: currentOwner.processId }),
        currentOwner,
        probe,
      ),
    ).resolves.toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it('uses the exact instance probe instead of a reused PID', async () => {
    const processProbe = vi.fn(() => true);
    const owner = {
      instanceId: 'previous',
      processId: 300,
      liveness: { version: 1 as const, port: 1234, token: '1234567890abcdef' },
    };
    const livenessProbe = vi.fn(() => 'ended' as const);

    await expect(
      shouldFailInterruptedReview(running(owner), currentOwner, processProbe, livenessProbe),
    ).resolves.toBe(true);
    expect(livenessProbe).toHaveBeenCalledWith(owner);
    expect(processProbe).not.toHaveBeenCalled();
  });

  it('preserves the lease when an exact instance probe is temporarily ambiguous', async () => {
    const owner = {
      instanceId: 'other',
      processId: 300,
      liveness: { version: 1 as const, port: 1234, token: '1234567890abcdef' },
    };
    await expect(
      shouldFailInterruptedReview(
        running(owner),
        currentOwner,
        () => false,
        () => 'unknown',
      ),
    ).resolves.toBe(false);
  });

  it('leaves owner-less cards from older clients untouched', async () => {
    const probe = vi.fn(() => false);
    await expect(shouldFailInterruptedReview(running(), currentOwner, probe)).resolves.toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});
