import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  enabled: false,
  getDbClient: vi.fn(),
  errorRows: vi.fn(),
  makeRows: vi.fn(),
}));

vi.mock('@cindy/maker-shared/cindy-make-feature', async (importOriginal) => ({
  ...await importOriginal<typeof import('@cindy/maker-shared/cindy-make-feature')>(),
  get CINDY_MAKE_ENABLED() { return state.enabled; },
}));
vi.mock('../localDb/client/current.js', () => ({ getDbClient: state.getDbClient }));
vi.mock('../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../maker-ipc/recoveryCoordinator.js', () => ({ boundedSummary: vi.fn() }));

import { listCindyMakePendingFailureSessionIds } from '../localDb/cindyMakeAttention.js';
import { listErrorTailPendingSessionIds } from '../localDb/sessionActiveTurn.js';

function nativeResult(sessionId: string, completion: unknown, content: unknown = '') {
  return {
    sessionId,
    role: 'assistant',
    content: JSON.stringify(content),
    agentMeta: JSON.stringify({ cindyMakeCompletion: completion }),
  };
}

describe('Cindy Make pending-alert recovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    state.enabled = false;
    state.errorRows.mockResolvedValue([{ sessionId: 'ordinary-error', clientId: 'error-message' }]);
    state.makeRows.mockResolvedValue([
      nativeResult('make-build-failed', { reportedAt: 100, lastAction: 'build', personal: { status: 'failed' } }),
      nativeResult('make-test-failed', { reportedAt: 100, lastAction: 'test', test: { status: 'failed' } }),
    ]);
    state.getDbClient.mockReturnValue({
      drizzle: {
        select: (fields: Record<string, unknown>) => ({
          from: () => ({
            innerJoin: () => ({ where: 'role' in fields ? state.makeRows : state.errorRows }),
          }),
        }),
      },
    });
  });

  it('does not recover native Make failure ids while the feature is disabled', async () => {
    expect(await listCindyMakePendingFailureSessionIds()).toEqual([]);
    expect(state.getDbClient).not.toHaveBeenCalled();
    expect(state.makeRows).not.toHaveBeenCalled();
  });

  it('keeps ordinary error alerts without adding hidden Make ids to the badge projection', async () => {
    expect(await listErrorTailPendingSessionIds()).toEqual(['ordinary-error']);
    expect(state.errorRows).toHaveBeenCalledOnce();
    expect(state.makeRows).not.toHaveBeenCalled();
  });

  it('does not require the database to recover disabled Make alerts', async () => {
    state.getDbClient.mockImplementation(() => { throw new Error('database is not ready'); });
    await expect(listCindyMakePendingFailureSessionIds()).resolves.toEqual([]);
    expect(state.getDbClient).not.toHaveBeenCalled();
  });

  it('preserves unresolved native failure recovery when the feature is enabled', async () => {
    state.enabled = true;
    state.makeRows.mockResolvedValue([
      nativeResult('make-build-failed', { reportedAt: 100, lastAction: 'build', personal: { status: 'failed' } }),
      nativeResult('make-test-failed', { reportedAt: 100, lastAction: 'test', test: { status: 'failed' } }),
      nativeResult('make-interrupted', { reportedAt: 100, lastAction: 'test', test: { status: 'stopped', error: 'interrupted' } }),
      nativeResult('make-preparation', null, { __cindyMakeCard: { type: 'cindy-make', data: { report: { runId: 'run', status: 'failed' } } } }),
      nativeResult('make-continued', { reportedAt: 100, continuedAt: 101, personal: { status: 'failed' } }),
      nativeResult('make-cancelled', { reportedAt: 100, personal: { status: 'failed', error: 'cancelled' } }),
      nativeResult('make-retried', { reportedAt: 100, personal: { status: 'checking' } }),
      nativeResult('make-done', { reportedAt: 100, test: { status: 'ready' } }),
    ]);
    expect(await listCindyMakePendingFailureSessionIds()).toEqual([
      'make-build-failed', 'make-test-failed', 'make-interrupted', 'make-preparation',
    ]);
    expect(state.makeRows).toHaveBeenCalledOnce();
  });

  it('still deduplicates native and ordinary errors when the feature is enabled', async () => {
    state.enabled = true;
    state.errorRows.mockResolvedValue([
      { sessionId: 'ordinary-error', clientId: 'error-message' },
      { sessionId: 'make-build-failed', clientId: 'old-error-message' },
    ]);
    expect(await listErrorTailPendingSessionIds()).toEqual([
      'ordinary-error', 'make-build-failed', 'make-test-failed',
    ]);
  });

  it('does not swallow database failures for ordinary error alerts', async () => {
    state.errorRows.mockRejectedValue(new Error('database is not ready'));
    await expect(listErrorTailPendingSessionIds()).rejects.toThrow('database is not ready');
    expect(state.makeRows).not.toHaveBeenCalled();
  });
});
