import { beforeEach, describe, expect, it, vi } from 'vitest';

// Unit: create_task_worktree creates the worktree for a task that is already running. The fetch and
// checkout take long, so the task may be archived or deleted, or the account switched, before the
// binding is stored; the status-change recycler has then already run without seeing it.
const h = vi.hoisted(() => ({
  rows: [] as Array<{ workingDir?: string; status: string; source: string | null }>,
  accountChanged: false,
  prepare: vi.fn(),
  removeWorktreeForSession: vi.fn(async () => undefined),
  recycle: vi.fn(async () => undefined),
  broadcast: vi.fn(),
}));

vi.mock('../../localDb/schema.js', () => ({ sessions: { workingDir: 'workingDir', status: 'status', source: 'source', id: 'id' } }));
vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));
vi.mock('../../localDb/ipc/sessions.js', () => ({ broadcastWorktreeChanged: h.broadcast, recycleSessionWorktreeForStatusChange: h.recycle }));
vi.mock('../../maker-ipc/handoffWorktree.js', () => ({ prepareTaskWorktree: h.prepare }));
vi.mock('../../worktree/index.js', () => ({
  resolveFreshSourceBranch: vi.fn(),
  WorktreeManager: {
    getForSession: vi.fn(), listAll: vi.fn(), detectCwd: vi.fn(), suggestName: vi.fn(), listBranches: vi.fn(), revParseCommit: vi.fn(),
    createWorktree: vi.fn(), removeWorktreeForSession: h.removeWorktreeForSession,
  },
}));
vi.mock('../createProject.js', () => ({
  withLocalProjectContext: async (_id: string, run: (context: unknown) => Promise<unknown>) => run({
    client: { drizzle: { select: () => ({ from: () => ({ where: () => ({ limit: async () => (h.rows.length ? [h.rows.shift()] : []) }) }) }) } },
    assertCurrent: () => { if (h.accountChanged) throw new Error('account changed'); },
  }),
}));

import { createTaskWorktreeHost } from '../createTaskWorktree.js';

const meta = { path: '/wt', branch: 'b', baseRepo: '/repo', sourceBranch: 'main' };

describe('create_task_worktree compensation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.accountChanged = false;
    h.prepare.mockResolvedValue({ ok: true, created: true, meta });
  });

  it('publishes the worktree while the task is still active', async () => {
    h.rows = [{ workingDir: '/repo', status: 'active', source: null }, { status: 'active', source: null }];
    await expect(createTaskWorktreeHost()({ callerSessionId: 's1' })).resolves.toMatchObject({ ok: true, worktreePath: '/wt', created: true });
    expect(h.recycle).not.toHaveBeenCalled();
    expect(h.broadcast).toHaveBeenCalledWith('s1');
  });

  it('runs the terminal recycle and reports failure when the task was archived meanwhile', async () => {
    h.rows = [{ workingDir: '/repo', status: 'active', source: null }, { status: 'archived', source: null }];
    await expect(createTaskWorktreeHost()({ callerSessionId: 's2' })).resolves.toMatchObject({ ok: false, errorCode: 'PRECONDITION_FAILED' });
    expect(h.recycle).toHaveBeenCalledWith('s2', 'archived');
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it('removes the new worktree when the task row is gone', async () => {
    h.rows = [{ workingDir: '/repo', status: 'active', source: null }];
    await expect(createTaskWorktreeHost()({ callerSessionId: 's3' })).resolves.toMatchObject({ ok: false });
    expect(h.recycle).toHaveBeenCalledWith('s3', 'deleted');
    expect(h.removeWorktreeForSession).toHaveBeenCalledWith('s3');
  });

  it('removes the new worktree when the account changed during creation', async () => {
    h.rows = [{ workingDir: '/repo', status: 'active', source: null }];
    h.prepare.mockImplementation(async () => { h.accountChanged = true; return { ok: true, created: true, meta }; });
    // The real wrapper turns the account-change throw into a failure result; this stand-in lets it through.
    await expect(createTaskWorktreeHost()({ callerSessionId: 's4' })).rejects.toThrow('account changed');
    expect(h.removeWorktreeForSession).toHaveBeenCalledWith('s4');
  });

  it('leaves an existing binding alone', async () => {
    h.rows = [{ workingDir: '/repo', status: 'active', source: null }];
    h.prepare.mockResolvedValue({ ok: true, created: false, meta });
    await expect(createTaskWorktreeHost()({ callerSessionId: 's5' })).resolves.toMatchObject({ ok: true, created: false });
    expect(h.recycle).not.toHaveBeenCalled();
  });
});
