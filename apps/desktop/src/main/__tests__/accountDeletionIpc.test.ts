import { AuthApiError, type AccountDeletionStatus } from '@cindy/auth-client';
import { describe, expect, it, vi } from 'vitest';

import {
  createAccountDeletionIpcHandlers,
  type AccountDeletionIpcDeps,
} from '../accountDeletionIpc';

const pendingStatus: AccountDeletionStatus = {
  status: 'pending',
  requestedAt: '2026-07-22T00:00:00.000Z',
  deleteAfter: '2026-08-21T00:00:00.000Z',
};

function createDeps(overrides: Partial<AccountDeletionIpcDeps> = {}): AccountDeletionIpcDeps {
  return {
    getAvailability: vi.fn().mockResolvedValue({
      available: true,
      verification: { channel: 'email', maskedTarget: 'u***@example.com' },
      manualAppleRevocationRequired: false,
    }),
    requestChallenge: vi.fn().mockResolvedValue({
      challengeId: 'challenge-id',
      channel: 'email',
      maskedTarget: 'u***@example.com',
      expiresAt: '2026-07-22T00:10:00.000Z',
    }),
    confirm: vi.fn().mockResolvedValue(pendingStatus),
    getStatus: vi.fn().mockResolvedValue(pendingStatus),
    clearReceipt: vi.fn(),
    consumeRestoredNotice: vi.fn().mockReturnValue(false),
    isConfirmedLocalSessionCurrent: vi.fn().mockReturnValue(true),
    beginAccountBoundary: vi.fn().mockReturnValue(vi.fn()),
    teardownAccountBoundary: vi.fn().mockResolvedValue(undefined),
    clearLocalSession: vi.fn().mockReturnValue(true),
    logWarn: vi.fn(),
    ...overrides,
  };
}

describe('account deletion IPC handlers', () => {
  it('tears down account services before clearing the initiating local session', async () => {
    const order: string[] = [];
    const deps = createDeps({
      confirm: vi.fn().mockImplementation(async () => {
        order.push('confirm');
        return pendingStatus;
      }),
      beginAccountBoundary: vi.fn().mockImplementation(() => {
        order.push('begin-boundary');
        return () => order.push('release-boundary');
      }),
      teardownAccountBoundary: vi.fn().mockImplementation(async () => {
        order.push('teardown');
      }),
      clearLocalSession: vi.fn().mockImplementation(() => {
        order.push('clear-local');
        return true;
      }),
    });

    const result = await createAccountDeletionIpcHandlers(deps).confirm({
      challengeId: 'challenge-id',
      code: '123456',
    });

    expect(result).toEqual({ success: true, value: pendingStatus });
    expect(order).toEqual([
      'confirm',
      'begin-boundary',
      'teardown',
      'clear-local',
      'release-boundary',
    ]);
  });

  it('still clears local auth when post-confirm teardown reports a non-fatal failure', async () => {
    const error = new Error('db worker already stopped');
    const deps = createDeps({
      teardownAccountBoundary: vi.fn().mockRejectedValue(error),
    });
    const handlers = createAccountDeletionIpcHandlers(deps);

    await expect(
      handlers.confirm({ challengeId: 'challenge-id', code: '123456' }),
    ).resolves.toEqual({ success: true, value: pendingStatus });
    expect(deps.clearLocalSession).toHaveBeenCalledOnce();
    expect(deps.logWarn).toHaveBeenCalledWith(
      'account boundary teardown after deletion failed (non-fatal)',
      error,
    );
  });

  it('always releases the account boundary when local session clearing throws', async () => {
    const releaseBoundary = vi.fn();
    const error = new Error('local auth store unavailable');
    const deps = createDeps({
      beginAccountBoundary: vi.fn().mockReturnValue(releaseBoundary),
      clearLocalSession: vi.fn().mockImplementation(() => {
        throw error;
      }),
    });

    await expect(
      createAccountDeletionIpcHandlers(deps).confirm({
        challengeId: 'challenge-id',
        code: '123456',
      }),
    ).rejects.toThrow(error);
    expect(releaseBoundary).toHaveBeenCalledOnce();
  });

  it('preserves auth-server failure codes and leaves the local session intact', async () => {
    const deps = createDeps({
      confirm: vi
        .fn()
        .mockRejectedValue(new AuthApiError('ACCOUNT_DELETION_CHALLENGE_INVALID', 401, 'expired')),
    });

    const result = await createAccountDeletionIpcHandlers(deps).confirm({
      challengeId: 'challenge-id',
      code: '000000',
    });

    expect(result).toEqual({
      success: false,
      code: 'ACCOUNT_DELETION_CHALLENGE_INVALID',
    });
    expect(deps.teardownAccountBoundary).not.toHaveBeenCalled();
    expect(deps.beginAccountBoundary).not.toHaveBeenCalled();
    expect(deps.clearLocalSession).not.toHaveBeenCalled();
  });

  it('does not tear down a different account selected while confirmation was in flight', async () => {
    const deps = createDeps({
      isConfirmedLocalSessionCurrent: vi.fn().mockReturnValue(false),
    });

    await expect(
      createAccountDeletionIpcHandlers(deps).confirm({
        challengeId: 'challenge-id',
        code: '123456',
      }),
    ).resolves.toEqual({ success: true, value: pendingStatus });
    expect(deps.teardownAccountBoundary).not.toHaveBeenCalled();
    expect(deps.beginAccountBoundary).not.toHaveBeenCalled();
    expect(deps.clearLocalSession).not.toHaveBeenCalled();
    expect(deps.logWarn).toHaveBeenCalledWith(
      'account deletion confirmed after local auth identity changed; skip teardown',
    );
  });

  it('rejects malformed confirmation input before any server call', async () => {
    const deps = createDeps();
    const result = await createAccountDeletionIpcHandlers(deps).confirm({
      challengeId: '',
      code: '123456',
    });

    expect(result).toEqual({ success: false, code: 'INVALID_PARAMS' });
    expect(deps.confirm).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent challenge requests so the persisted receipt matches every caller', async () => {
    let resolveChallenge!: (
      challenge: Awaited<ReturnType<AccountDeletionIpcDeps['requestChallenge']>>,
    ) => void;
    const deferred = new Promise<Awaited<ReturnType<AccountDeletionIpcDeps['requestChallenge']>>>(
      (resolve) => {
        resolveChallenge = resolve;
      },
    );
    const deps = createDeps({ requestChallenge: vi.fn().mockReturnValue(deferred) });
    const handlers = createAccountDeletionIpcHandlers(deps);

    const first = handlers.requestChallenge();
    const second = handlers.requestChallenge();
    resolveChallenge({
      challengeId: 'challenge-id',
      channel: 'email',
      maskedTarget: 'u***@example.com',
      expiresAt: '2026-07-22T00:10:00.000Z',
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ success: true }),
      expect.objectContaining({ success: true }),
    ]);
    expect(deps.requestChallenge).toHaveBeenCalledOnce();
  });

  it('deduplicates concurrent confirmation clicks into one irreversible operation', async () => {
    let resolveConfirm!: (status: AccountDeletionStatus) => void;
    const deferred = new Promise<AccountDeletionStatus>((resolve) => {
      resolveConfirm = resolve;
    });
    const deps = createDeps({ confirm: vi.fn().mockReturnValue(deferred) });
    const handlers = createAccountDeletionIpcHandlers(deps);

    const first = handlers.confirm({ challengeId: 'challenge-id', code: '123456' });
    const second = handlers.confirm({ challengeId: 'challenge-id', code: '123456' });
    resolveConfirm(pendingStatus);

    await expect(Promise.all([first, second])).resolves.toEqual([
      { success: true, value: pendingStatus },
      { success: true, value: pendingStatus },
    ]);
    expect(deps.confirm).toHaveBeenCalledOnce();
    expect(deps.teardownAccountBoundary).toHaveBeenCalledOnce();
    expect(deps.clearLocalSession).toHaveBeenCalledOnce();
  });
});
