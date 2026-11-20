import { describe, expect, it, vi } from 'vitest';

// createLogger 的输出最终走 emit()（文件写入 / dev terminal 流），测试环境不经过 console.warn,
// 所以直接 mock 掉 logger,让 reconcile 内部的 warn 成为 no-op（既消除 vitest 输出噪声,也避免
// 误以为 spy console.warn 能拦住它）。
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { reconcileStrandedOrcaLeads } from '../localDb/orcaStrandedLeadReconcile';

// Minimum surface of better-sqlite3 Database we touch: a synchronous transaction wrapper
// plus prepare().run() returning { changes }. Mocking avoids loading the native module under
// vitest (Electron-ABI bound), mirroring orcaStaleIndexCleanup.test.ts.
function makeDb(opts: { changesBySql?: (sql: string) => number; throwOnRun?: boolean }) {
  const runSqls: string[] = [];
  const db = {
    transaction: (fn: () => unknown) => () => fn(),
    prepare: (sql: string) => ({
      run: () => {
        runSqls.push(sql);
        if (opts.throwOnRun) throw new Error('boom');
        return { changes: opts.changesBySql ? opts.changesBySql(sql) : 0 };
      },
    }),
  };
  return { db: db as unknown as import('better-sqlite3').Database, runSqls };
}

describe('reconcileStrandedOrcaLeads', () => {
  it('repairs inactive teams and separately restores visibility to side-chat leads', () => {
    const { db, runSqls } = makeDb({ changesBySql: () => 1 });
    reconcileStrandedOrcaLeads(db);

    expect(runSqls).toHaveLength(5);
    const [endArchivedTeam, archiveWorkers, doneWorkers, clearLeads] = runSqls;
    expect(endArchivedTeam).toContain("UPDATE orca_teams SET status = 'completed'");
    expect(endArchivedTeam).toContain("source = 'side-chat' AND side_chat_promoted = 1 AND status = 'archived'");

    // 1) archive ONLY still-active orphan worker sessions of non-active teams — must not touch
    //    already-archived rows, and must not resurrect user-deleted (status='deleted') sessions.
    expect(archiveWorkers).toContain("UPDATE sessions SET status = 'archived'");
    expect(archiveWorkers).toContain("orca_role = 'worker'");
    expect(archiveWorkers).toContain("status = 'active'");
    expect(archiveWorkers).not.toContain("status != 'archived'");
    expect(archiveWorkers).toContain("t.status != 'active'");

    // 2) converge orca_workers to done: only not-yet-done rows, scoped to non-active teams.
    //    (Pin the team-scope predicate explicitly via its `orca_teams` subquery so it can't be
    //    confused with the orca_workers `status != 'done'` guard.)
    expect(doneWorkers).toContain("UPDATE orca_workers SET status = 'done'");
    expect(doneWorkers).toContain("status != 'done'");
    expect(doneWorkers).toContain("orca_teams WHERE status != 'active'");

    // 3) clear stranded leads (lead role + no active team)
    expect(clearLeads).toContain('UPDATE sessions SET orca_role = NULL');
    expect(clearLeads).toContain("orca_role = 'lead'");
    expect(clearLeads).toContain('NOT IN');
    expect(clearLeads).toContain("SELECT lead_session_id FROM orca_teams WHERE status = 'active'");
  });

  it('still runs the idempotent statements when nothing is stranded (changes=0, no throw)', () => {
    const { db, runSqls } = makeDb({ changesBySql: () => 0 });
    expect(() => reconcileStrandedOrcaLeads(db)).not.toThrow();
    expect(runSqls).toHaveLength(5);
  });

  it('does not propagate errors (must not block ensureReady)', () => {
    const { db } = makeDb({ throwOnRun: true });
    expect(() => reconcileStrandedOrcaLeads(db)).not.toThrow();
  });
});
