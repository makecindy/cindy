// Unit: the actual create boundary must atomically reference a selected existing
// tree, without cloning history or ownership. Existing opening tests cover model
// admission, but not picker identity, recycling serialization or borrower rows.
// Minimal input: one managed tree and one new task; no real Git, DB or timers.
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  owner: null as unknown,
  row: null as Record<string, unknown> | null,
  locked: false,
  entries: [] as Array<Record<string, unknown>>,
  git: vi.fn(),
  bootstrap: vi.fn(),
  insert: vi.fn(),
  notify: vi.fn(),
}));
const db = {
  insert: () => ({
    values: async (row: Record<string, unknown>) => {
      h.insert(row);
      expect(h.locked).toBe(true);
      h.row = row;
    },
  }),
  select: () => ({ from: () => ({ where: async () => (h.row ? [h.row] : []) }) }),
};
vi.mock('../../client/current', () => ({
  getCurrentDbClientSnapshot: () => h.owner,
  getDbClient: () => ({ drizzle: db }),
}));
vi.mock('../../../worktree/worktreeStore', () => ({ getAll: () => h.entries }));
vi.mock('../../../worktree/gitExec', () => ({ gitExec: h.git }));
vi.mock('../../../worktree/resourceLock', () => ({
  physicalWorktreeKey: async (value: string) => value,
  withWorktreeResourceLocks: async (_paths: string[], task: () => Promise<unknown>) => {
    const previous = h.locked;
    h.locked = true;
    try {
      return await task();
    } finally {
      h.locked = previous;
    }
  },
}));
vi.mock('../../../logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../../../git-snapshot/projectGitBootstrap', () => ({
  ensureProjectGitInitialized: h.bootstrap,
}));
vi.mock('../../../maker-host/git-safety-settings-store', () => ({
  readGitSafetySettings: () => ({}),
}));
vi.mock('../sessionSourceGuard', () => ({ assertRendererSessionSourceAllowed: vi.fn() }));
vi.mock('../recentWorkdirsCore', () => ({ upsertRecentWorkdir: vi.fn(async () => undefined) }));
import { createUserSession } from '../createUserSession';
import { setSessionOpeningModelAdmission } from '../../sessionOpening';
const tree = {
  sessionId: 'owner',
  name: 'login',
  path: '/repo/.cindy-worktrees/login',
  baseRepo: '/repo',
  branch: 'cindy/login',
  sourceBranch: 'main',
  createdAt: '2026-11-17',
};
const request = {
  id: 'borrower',
  model: 'model',
  agentKind: 'codex',
  permissionMode: 'ask',
  workingDir: '/repo',
  workspaceKind: 'project',
  reuseWorktreePath: tree.path,
  reuseWorktreeSessionId: 'owner',
};
const ports = { senderId: 1, userDataDir: '/user-data', notifyPluginSessionCreated: h.notify };
beforeEach(() => {
  vi.clearAllMocks();
  h.owner = { client: { drizzle: db } };
  h.row = null;
  h.entries = [{ ...tree }];
  h.locked = false;
  h.git.mockImplementation(async () => {
    expect(h.locked).toBe(true);
    return { stdout: tree.path };
  });
  h.bootstrap.mockResolvedValue(undefined);
  setSessionOpeningModelAdmission(async (body) => body);
});
it('opens an empty borrower with durable project and worktree references while preserving the owner', async () => {
  const result = await createUserSession(request, ports);
  expect(result).toMatchObject({
    id: 'borrower',
    workingDir: tree.path,
    projectDir: '/repo',
    worktreePath: tree.path,
    permissionMode: 'ask',
    _count: { messages: 0 },
  });
  expect(h.row).toMatchObject({
    worktreePath: tree.path,
    workingDir: tree.path,
    projectDir: '/repo',
  });
  expect(h.row?.parentSessionId).toBeNull();
  expect(h.entries).toEqual([tree]);
  expect(h.git).toHaveBeenCalledWith(['rev-parse', '--show-toplevel'], tree.path);
});
it.each(['removed', 'another-project', 'ephemeral', 'quarantine', 'replaced'] as const)(
  'rejects a %s selection before opening any task',
  async (reason) => {
    if (reason === 'removed') h.entries = [];
    if (reason === 'another-project') h.entries = [{ ...tree, baseRepo: '/other' }];
    if (reason === 'ephemeral') h.entries = [{ ...tree, ephemeral: true }];
    if (reason === 'quarantine') h.entries = [{ ...tree, quarantinePath: '/quarantine' }];
    if (reason === 'replaced') h.entries = [{ ...tree, sessionId: 'new-owner' }];
    await expect(createUserSession(request, ports)).rejects.toThrow('no longer available');
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.bootstrap).not.toHaveBeenCalled();
  },
);
it('does not recreate a missing checkout or leave an empty session behind', async () => {
  h.git.mockRejectedValueOnce(new Error('ENOENT'));
  await expect(createUserSession(request, ports)).rejects.toThrow('no longer available');
  expect(h.bootstrap).not.toHaveBeenCalled();
  expect(h.insert).not.toHaveBeenCalled();
});
it('rejects a different repository placed at the old worktree path', async () => {
  h.git.mockImplementation(async (args: string[], cwd: string) => ({
    stdout: args.includes('--show-toplevel')
      ? tree.path
      : cwd === tree.path
        ? '/replacement/.git'
        : '/repo/.git',
  }));
  await expect(createUserSession(request, ports)).rejects.toThrow('no longer available');
  expect(h.insert).not.toHaveBeenCalled();
});
it('rejects an account switch during worktree validation', async () => {
  h.git.mockImplementationOnce(async () => {
    h.owner = { client: { drizzle: db } };
    return { stdout: tree.path };
  });
  await expect(createUserSession(request, ports)).rejects.toThrow('Account changed');
  expect(h.insert).not.toHaveBeenCalled();
});
it.each([{ remoteHostId: 'ssh' }, { workspaceKind: 'dialogue' }, { reuseWorktreePath: false }])(
  'rejects an invalid reuse request before touching Git: %j',
  async (patch) => {
    await expect(createUserSession({ ...request, ...patch }, ports)).rejects.toThrow(
      'local project task',
    );
    expect(h.git).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  },
);
