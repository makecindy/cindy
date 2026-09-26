import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dialogueRoot: '',
  owner: { dataOwnerId: 'owner-a', ownerGeneration: 1 },
  query: vi.fn(),
  botLinks: [] as Array<{ botId: string }>,
  botLinkSequence: null as null | Array<Array<{ botId: string }>>,
  workers: [] as Array<{ sessionId: string }>,
  running: new Set<string>(),
  attached: false,
  update: vi.fn(),
  saved: vi.fn(),
  enterLock: vi.fn(),
  beforeCommit: vi.fn(),
}));
vi.mock('../../localDb/dialogueWorkspace.js', () => ({
  dialogueWorkspaceRootDir: () => h.dialogueRoot,
  dialogueWorkspaceRoots: () => [h.dialogueRoot],
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../appSessionState.js', () => ({
  getActiveDataOwnerPushStamp: () => ({ ...h.owner }),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../localDb/client/current.js', async () => {
  const { botSessionLinks } = await import('../../localDb/schema.js');
  const client = {
    drizzle: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit:
              table === botSessionLinks
                ? async () => h.botLinkSequence?.shift() ?? h.botLinks
                : h.query,
          }),
          innerJoin: () => ({ where: async () => h.workers }),
        }),
      }),
    },
  };
  return { tryGetDbClient: () => client };
});
vi.mock('../../localDb/ipc/recentWorkdirs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../localDb/ipc/recentWorkdirs.js')>();
  return {
    normalizeRecentWorkdirPath: actual.normalizeRecentWorkdirPath,
    upsertRecentWorkdir: vi.fn(),
  };
});
vi.mock('../../sidebarSettingsStore.js', () => ({ restoreLocalProjectVisibility: vi.fn() }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../im/binding.js', () => ({
  bindingStore: { findByTarget: () => (h.attached ? 'im' : null) },
}));
vi.mock('../../localDb/ipc/sessions.js', () => ({ updateSessionInDb: h.update }));

import { createMoveSession } from '../moveSession.js';

describe('moveSession host', () => {
  let directory: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await mkdtemp(path.join(os.tmpdir(), 'cindy-move-session-'));
    h.dialogueRoot = path.join(directory, 'dialogues');
    h.owner = { dataOwnerId: 'owner-a', ownerGeneration: 1 };
    h.running = new Set();
    h.workers = [];
    h.botLinks = [];
    h.botLinkSequence = null;
    h.attached = false;
    h.enterLock.mockImplementation(() => undefined);
    h.beforeCommit.mockImplementation(() => undefined);
    h.query.mockResolvedValue([
      { id: 'target', status: 'active', remoteHostId: null, source: null, orcaRole: null },
    ]);
    h.update.mockImplementation(async (id, patch, _opts, guard) => {
      await h.enterLock();
      guard.assertCurrent();
      await guard.beforeUpdate();
      guard.assertCurrent();
      await h.beforeCommit();
      await guard.beforeWrite?.();
      h.saved(patch);
      guard.assertCurrent();
      return { id, workingDir: patch.workingDir ?? '/old', workspaceKind: patch.workspaceKind };
    });
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const run = (workingDir: string | null) =>
    createMoveSession((id) => h.running.has(id))({
      callerSessionId: 'caller',
      sessionId: 'target',
      workingDir,
    });

  it('uses the shared update path for moving projects and preserves cwd when removing grouping', async () => {
    // recent_workdirs stores logical project identities with forward slashes on all platforms.
    expect(await run(directory)).toMatchObject({
      ok: true,
      workingDir: directory.replaceAll('\\', '/'),
      workspaceKind: 'project',
    });
    expect(h.saved).toHaveBeenLastCalledWith({
      workingDir: directory.replaceAll('\\', '/'),
      workspaceKind: 'project',
    });
    expect(await run(null)).toMatchObject({
      ok: true,
      workingDir: '/old',
      workspaceKind: 'dialogue',
    });
    expect(h.saved).toHaveBeenLastCalledWith({ workspaceKind: 'dialogue' });
  });
  it.each([false, true])(
    'rechecks running state after acquiring the route lock (%s)',
    async (target) => {
      h.enterLock.mockImplementation(() => h.running.add('target'));
      expect(await run(target ? directory : null)).toMatchObject({
        errorCode: 'PRECONDITION_FAILED',
      });
      expect(h.saved).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    'rejects a newly running Worker created after initial validation (project=%s)',
    async (project) => {
      h.beforeCommit.mockImplementation(() => {
        h.workers = [{ sessionId: 'late-worker' }];
        h.running.add('late-worker');
      });
      expect(await run(project ? directory : null)).toMatchObject({
        errorCode: 'PRECONDITION_FAILED',
      });
      expect(h.saved).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'rechecks target lifecycle and ownership at commit (project=%s)',
    async (project) => {
      for (const change of ['archived', 'bot-link', 'im']) {
        h.query.mockResolvedValue([{ id: 'target', status: 'active' }]);
        h.botLinks = [];
        h.attached = false;
        h.beforeCommit.mockImplementationOnce(() => {
          if (change === 'archived')
            h.query.mockResolvedValue([{ id: 'target', status: 'archived' }]);
          if (change === 'bot-link') h.botLinks = [{ botId: 'bot' }];
          if (change === 'im') h.attached = true;
        });
        expect(await run(project ? directory : null)).toMatchObject({ ok: false });
      }
      expect(h.saved).not.toHaveBeenCalled();
    },
  );

  it.each(['source', 'link'])(
    'lets Bot %s callers move ordinary tasks',
    async (signal) => {
      h.query
        .mockResolvedValueOnce([
          { id: 'caller', remoteHostId: null, source: signal === 'source' ? 'bot' : null },
        ])
        .mockResolvedValue([{ id: 'target', status: 'active', remoteHostId: null, source: null }]);
      if (signal === 'link') h.botLinkSequence = [[{ botId: 'bot' }], []];
      expect(await run(directory)).toMatchObject({ ok: true });
      expect(h.update).toHaveBeenCalled();
    },
  );

  it('does not report a committed move as rejected when IM attaches after the write', async () => {
    h.saved.mockImplementationOnce(() => {
      h.attached = true;
    });
    expect(await run(null)).toMatchObject({ ok: true, workspaceKind: 'dialogue' });
  });

  it('rejects IM-controlled tasks and running Orca workers', async () => {
    h.attached = true;
    expect(await run(null)).toMatchObject({ errorCode: 'PRECONDITION_FAILED' });
    h.attached = false;
    h.query.mockResolvedValue([{ id: 'target', status: 'active', orcaRole: 'lead' }]);
    h.workers = [{ sessionId: 'worker' }];
    h.running.add('worker');
    expect(await run(null)).toMatchObject({ errorCode: 'PRECONDITION_FAILED' });
    expect(h.saved).not.toHaveBeenCalled();
  });
  it.each([
    [[], 'NOT_FOUND'],
    [[{ status: 'active', remoteHostId: 'ssh' }], 'UNSUPPORTED_CAPABILITY'],
    [[{ status: 'archived' }], 'PRECONDITION_FAILED'],
    [[{ status: 'deleted' }], 'PRECONDITION_FAILED'],
    [[{ status: 'active', source: 'review' }], 'UNSUPPORTED_CAPABILITY'],
  ])('rejects an unavailable target %j', async (rows, errorCode) => {
    h.query.mockResolvedValueOnce([{ id: 'caller' }]).mockResolvedValueOnce(rows);
    expect(await run(null)).toMatchObject({ errorCode });
    expect(h.saved).not.toHaveBeenCalled();
  });
  it('rejects account switches while queued behind the route lock', async () => {
    h.enterLock.mockImplementation(() => {
      h.owner.ownerGeneration++;
    });
    expect(await run(null)).toMatchObject({ errorCode: 'PRECONDITION_FAILED' });
    expect(h.saved).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'keeps Bot-owned tasks in their managed workspace (project=%s)',
    async (project) => {
      const workingDir = project ? directory : null;
      // Source-only records and legacy linked records share the same restriction.
      h.query
        .mockResolvedValueOnce([{ id: 'caller' }])
        .mockResolvedValueOnce([{ id: 'target', status: 'active', source: 'bot' }]);
      expect(await run(workingDir)).toMatchObject({ errorCode: 'UNSUPPORTED_CAPABILITY' });
      h.enterLock.mockImplementationOnce(() => {
        h.botLinks = [{ botId: 'bot' }];
      });
      expect(await run(workingDir)).toMatchObject({ errorCode: 'UNSUPPORTED_CAPABILITY' });
      expect(h.saved).not.toHaveBeenCalled();
      // A normal delegated task is not a Bot-owned task; parent linkage does not restrict moving it.
      h.botLinks = [];
      h.query.mockResolvedValue([{ id: 'target', status: 'active', parentSessionId: 'bot-task' }]);
      expect(await run(workingDir)).toMatchObject({ ok: true });
    },
  );
  it('rejects missing directories, files, and relative paths without writing', async () => {
    expect(await run(path.join(directory, 'missing'))).toMatchObject({ errorCode: 'NOT_FOUND' });
    await writeFile(path.join(directory, 'file'), 'keep');
    expect(await run(path.join(directory, 'file'))).toMatchObject({ ok: false });
    expect(await run('relative')).toMatchObject({ errorCode: 'INVALID_ARGS' });
    expect(h.saved).not.toHaveBeenCalled();
  });
  it.for(
    ['.cindy-worktrees', '.xdt-worktrees', 'dialogues'].flatMap((name) =>
      ['lock', 'commit'].map((phase) => [name, phase] as const),
    ),
  )('rejects a %s alias retargeted before %s', async ([managedName, phase], ctx) => {
    const ordinary = path.join(directory, 'ordinary');
    const managed = path.join(directory, managedName, 'task');
    const alias = path.join(directory, 'alias');
    await mkdir(ordinary);
    await mkdir(managed, { recursive: true });
    try {
      await symlink(ordinary, alias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        ctx.skip();
        return;
      }
      throw error;
    }
    expect(await run(alias)).toMatchObject({ ok: true, workingDir: alias.replaceAll('\\', '/') });
    h.saved.mockClear();
    const checkpoint = phase === 'lock' ? h.enterLock : h.beforeCommit;
    checkpoint.mockImplementationOnce(async () => {
      await rm(alias);
      await symlink(managed, alias, process.platform === 'win32' ? 'junction' : 'dir');
    });
    expect(await run(alias)).toMatchObject({ errorCode: 'INVALID_PARAMS' });
    expect(h.saved).not.toHaveBeenCalled();
    expect(await run(null)).toMatchObject({ ok: true, workingDir: '/old' });
  });
});
