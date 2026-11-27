import { beforeEach, describe, expect, it, vi } from 'vitest';

const { warn } = vi.hoisted(() => ({ warn: vi.fn<(payload: string) => void>() }));
vi.mock('../logger', () => ({ createLogger: () => ({ warn }) }));

import { reconcileStrandedOrcaLeads } from '../localDb/orcaStrandedLeadReconcile';

// Unit tier: startup reports a completed repair, leaves an idle scan quiet,
// and reports a storage failure without blocking startup. The migration replay
// suite exercises the actual SQL and atomic rollback against SQLite.
function makeDb({ changes = 0, error }: { changes?: number; error?: Error } = {}) {
  return {
    transaction: (fn: () => unknown) => () => fn(),
    prepare: () => ({
      run: () => {
        if (error) throw error;
        return { changes };
      },
    }),
  } as unknown as import('better-sqlite3').Database;
}

describe('reconcileStrandedOrcaLeads', () => {
  beforeEach(() => {
    warn.mockClear();
  });

  it('reports the effects when it repairs stranded teams and restores visibility', () => {
    reconcileStrandedOrcaLeads(makeDb({ changes: 1 }));

    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({
      event: 'localDb.reconcile.strandedOrcaState.cleared',
      archivedTeams: 1,
      archivedWorkerSessions: 1,
      doneWorkers: 1,
      clearedLeads: 1,
      promotedLeads: 1,
    });
  });

  it('leaves an empty recovery quiet', () => {
    reconcileStrandedOrcaLeads(makeDb());

    expect(warn).not.toHaveBeenCalled();
  });

  it('reports a storage failure without blocking startup', () => {
    expect(() => reconcileStrandedOrcaLeads(makeDb({ error: new Error('database unavailable') }))).not.toThrow();

    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.parse(warn.mock.calls[0][0])).toMatchObject({
      event: 'localDb.reconcile.strandedOrcaState.failed',
      error: 'database unavailable',
    });
  });
});
