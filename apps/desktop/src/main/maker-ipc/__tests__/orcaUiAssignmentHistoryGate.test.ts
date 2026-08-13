import { describe, expect, it, vi } from 'vitest';

import { createOrcaUiAssignmentHistoryGate } from '../orcaUiAssignmentHistoryGate';

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
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishQuery = resolve; }))
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
