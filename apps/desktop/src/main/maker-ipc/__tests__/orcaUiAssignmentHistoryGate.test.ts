import { describe, expect, it, vi } from 'vitest';

import {
  createOrcaUiAssignmentDispatchClaims,
  createOrcaUiAssignmentHistoryGate,
} from '../orcaUiAssignmentHistoryGate';

describe('Orca UI assignment history gate', () => {
  it('returns immediately when the Lead input is already queryable', async () => {
    const hasUserMessageSince = vi.fn().mockResolvedValue(true);
    const gate = createOrcaUiAssignmentHistoryGate({ hasUserMessageSince });

    await expect(gate.waitUntilQueryable('lead-1', 123)).resolves.toBe(true);
    expect(hasUserMessageSince).toHaveBeenCalledWith('lead-1', 123);
  });

  it('does not miss persistence that happens while the initial DB query is in flight', async () => {
    let finishQuery!: (value: boolean) => void;
    const hasUserMessageSince = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finishQuery = resolve;
          }),
      )
      .mockResolvedValueOnce(true);
    const gate = createOrcaUiAssignmentHistoryGate({ hasUserMessageSince });

    const pending = gate.waitUntilQueryable('lead-1', 123);
    gate.notifyUserMessagePersisted('lead-1');
    finishQuery(false);

    await expect(pending).resolves.toBe(true);
    expect(hasUserMessageSince).toHaveBeenCalledTimes(2);
  });

  it('rechecks the DB after a persistence notification instead of treating it as proof', async () => {
    const hasUserMessageSince = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const gate = createOrcaUiAssignmentHistoryGate({ hasUserMessageSince });

    const pending = gate.waitUntilQueryable('lead-1', 123);
    await vi.waitFor(() => expect(hasUserMessageSince).toHaveBeenCalledTimes(1));
    gate.notifyUserMessagePersisted('lead-1');
    await vi.waitFor(() => expect(hasUserMessageSince).toHaveBeenCalledTimes(2));
    gate.notifyUserMessagePersisted('lead-1');

    await expect(pending).resolves.toBe(true);
    expect(hasUserMessageSince).toHaveBeenCalledTimes(3);
  });

  it('fails closed after the bounded wait when no Lead input becomes queryable', async () => {
    vi.useFakeTimers();
    const hasUserMessageSince = vi.fn().mockResolvedValue(false);
    const gate = createOrcaUiAssignmentHistoryGate({ hasUserMessageSince, timeoutMs: 1_000 });

    const pending = gate.waitUntilQueryable('lead-1', 123);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe(false);
    expect(hasUserMessageSince).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe('Orca UI assignment dispatch claims', () => {
  const assignment = {
    leadSessionId: 'lead-1',
    workerSessionId: 'worker-1',
    snapshotBeforeMs: 123,
  };

  it('shares one dispatch across concurrent and later calls for the same assignment', async () => {
    let finishDispatch!: (value: string) => void;
    const dispatch = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishDispatch = resolve;
        }),
    );
    const claims = createOrcaUiAssignmentDispatchClaims();

    const first = claims.runOnce(assignment, dispatch);
    const concurrent = claims.runOnce(assignment, dispatch);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    finishDispatch('accepted');

    await expect(Promise.all([first, concurrent])).resolves.toEqual(['accepted', 'accepted']);
    await expect(claims.runOnce(assignment, dispatch)).resolves.toBe('accepted');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not conflate assignments from different snapshots', async () => {
    const dispatch = vi.fn().mockResolvedValue('accepted');
    const claims = createOrcaUiAssignmentDispatchClaims();

    await claims.runOnce(assignment, dispatch);
    await claims.runOnce({ ...assignment, snapshotBeforeMs: 124 }, dispatch);

    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('shares a rejected dispatch without retrying the same assignment', async () => {
    const failure = new Error('dispatch failed');
    const dispatch = vi.fn().mockRejectedValue(failure);
    const claims = createOrcaUiAssignmentDispatchClaims();

    const first = claims.runOnce(assignment, dispatch);
    const concurrent = claims.runOnce(assignment, dispatch);

    const outcomes = await Promise.allSettled([first, concurrent]);
    expect(outcomes).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
    await expect(claims.runOnce(assignment, dispatch)).rejects.toBe(failure);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
