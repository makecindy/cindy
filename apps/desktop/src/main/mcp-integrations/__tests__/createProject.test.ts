import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dialogueRoot: '',
  owner: { dataOwnerId: 'owner-a', ownerGeneration: 1 },
  boundary: false,
  ready: true,
  query: vi.fn(),
  botLinks: vi.fn(),
  upsert: vi.fn(),
  restore: vi.fn(),
  send: vi.fn(),
  untrustedSend: vi.fn(),
  registered: [] as Array<{ path: string }>,
  list: vi.fn(),
  aliases: vi.fn(),
  rename: vi.fn(),
  visibility: vi.fn(),
  hiddenKeys: [] as string[],
}));
vi.mock('../../localDb/dialogueWorkspace.js', () => ({
  dialogueWorkspaceRootDir: () => h.dialogueRoot,
}));
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { trusted: true, webContents: { send: h.send } },
      { trusted: false, webContents: { send: h.untrustedSend } },
    ],
  },
}));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  isTrustedAppRendererWindow: (window: { trusted: boolean }) => window.trusted,
}));
vi.mock('../../appSessionState.js', () => ({
  getActiveDataOwnerPushStamp: () => ({ ...h.owner }),
  isAppSessionBoundaryPending: () => h.boundary,
}));
vi.mock('../../localDb/client/current.js', async () => {
  const { botSessionLinks } = await import('../../localDb/schema.js');
  const client = {
    drizzle: {
      select: () => ({
        from: (table: unknown) =>
          Object.assign(Promise.resolve(h.registered), {
            where: () => ({ limit: table === botSessionLinks ? h.botLinks : h.query }),
          }),
      }),
    },
  };
  return { tryGetDbClient: () => (h.ready ? client : null) };
});
vi.mock('../../localDb/ipc/recentWorkdirs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../localDb/ipc/recentWorkdirs.js')>();
  return {
    normalizeRecentWorkdirPath: actual.normalizeRecentWorkdirPath,
    upsertRecentWorkdir: h.upsert,
    listRecentWorkdirs: h.list,
  };
});
vi.mock('../../localDb/ipc/projectAliases.js', () => ({
  listProjectAliases: h.aliases,
  upsertProjectAlias: h.rename,
}));
vi.mock('../../sidebarSettingsStore.js', () => ({
  restoreLocalProjectVisibility: h.restore,
  setLocalProjectHidden: h.visibility,
  loadSidebarSettingsSnapshot: () => ({ ...h.owner, hiddenProjectKeys: h.hiddenKeys }),
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));

import { createProject } from '../createProject.js';
import { listProjects, renameProject, removeProject } from '../projectManagement.js';

describe('createProject', () => {
  let directory: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await mkdtemp(path.join(os.tmpdir(), 'cindy-create-project-'));
    h.dialogueRoot = path.join(directory, 'dialogues');
    h.owner = { dataOwnerId: 'owner-a', ownerGeneration: 1 };
    h.boundary = false;
    h.ready = true;
    h.query.mockResolvedValue([{ id: 'caller', remoteHostId: null }]);
    h.botLinks.mockResolvedValue([]);
    h.upsert.mockResolvedValue(true);
    h.restore.mockResolvedValue(false);
    h.registered = [{ path: directory.replaceAll('\\', '/') }];
    h.hiddenKeys = [];
    h.list.mockResolvedValue([
      { path: directory.replaceAll('\\', '/'), exists: true, lastUsedAt: '2026-09-17T00:00:00Z' },
    ]);
    h.aliases.mockResolvedValue([]);
    h.rename.mockResolvedValue(null);
    h.visibility.mockResolvedValue(true);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const run = (workingDir: string) => createProject({ callerSessionId: 'caller', workingDir });

  it('rejects managed dialogue roots, descendants and symlink aliases but permits adjacent projects', async () => {
    const managed = path.join(h.dialogueRoot, '2026-09-18', 'task');
    await mkdir(managed, { recursive: true });
    expect(await run(h.dialogueRoot)).toMatchObject({ ok: false });
    expect(await run(managed)).toMatchObject({ ok: false });
    const alias = path.join(directory, 'alias');
    await symlink(managed, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await run(alias)).toMatchObject({ ok: false });
    expect(h.upsert).not.toHaveBeenCalled();
    const adjacent = `${h.dialogueRoot}-project`;
    await mkdir(adjacent);
    expect(await run(adjacent)).toMatchObject({ ok: true });
  });

  it('registers an existing directory, restores visibility and refreshes with the captured owner', async () => {
    await writeFile(path.join(directory, 'keep.txt'), 'unchanged');
    const workingDir = directory.replaceAll('\\', '/');
    expect(await run(directory)).toEqual({ ok: true, workingDir });
    expect(h.upsert).toHaveBeenCalledWith(
      workingDir,
      expect.any(Number),
      process.platform,
      expect.any(Object),
    );
    expect(h.restore).toHaveBeenCalledWith(workingDir, h.owner);
    expect(h.send).toHaveBeenCalledWith(
      'local-db:recent-workdirs:changed',
      { path: workingDir },
      h.owner,
    );
    expect(h.untrustedSend).not.toHaveBeenCalled();
    expect(await readFile(path.join(directory, 'keep.txt'), 'utf8')).toBe('unchanged');
    expect(await run(directory)).toEqual({ ok: true, workingDir });
  });

  it.each(['source', 'link'])(
    'rejects Bot %s callers before any project callback',
    async (signal) => {
      h.query.mockResolvedValue([{ id: 'caller', source: signal === 'source' ? 'bot' : null }]);
      h.botLinks.mockResolvedValue(signal === 'link' ? [{ botId: 'bot' }] : []);
      for (const operation of [
        () => run(directory),
        () =>
          listProjects({ callerSessionId: 'caller', includeHidden: true, offset: 0, limit: 100 }),
        () => renameProject({ callerSessionId: 'caller', workingDir: directory, name: 'changed' }),
        () => removeProject({ callerSessionId: 'caller', workingDir: directory }),
      ])
        expect(await operation()).toMatchObject({ errorCode: 'UNSUPPORTED_CAPABILITY' });
      for (const effect of [h.upsert, h.restore, h.list, h.aliases, h.rename, h.visibility, h.send])
        expect(effect).not.toHaveBeenCalled();
    },
  );

  it('allows ordinary delegated callers but fences owner changes during Bot lookup', async () => {
    h.query.mockResolvedValue([{ id: 'caller', parentSessionId: 'bot-task' }]);
    expect(await run(directory)).toMatchObject({ ok: true });
    h.upsert.mockClear();
    h.botLinks.mockImplementationOnce(async () => {
      h.owner.ownerGeneration++;
      return [];
    });
    expect(await run(directory)).toMatchObject({ errorCode: 'PRECONDITION_FAILED' });
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it('does not create a missing directory', async () => {
    expect(await run(path.join(directory, 'missing'))).toMatchObject({
      ok: false,
      errorCode: 'NOT_FOUND',
    });
    expect(h.upsert).not.toHaveBeenCalled();
  });
  it.for(['.cindy-worktrees', '.xdt-worktrees'])(
    'rejects %s aliases before registration',
    async (managedName, ctx) => {
      const managed = path.join(directory, managedName, 'task');
      await mkdir(managed, { recursive: true });
      const alias = path.join(directory, 'alias');
      try {
        await symlink(managed, alias, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          ctx.skip();
          return;
        }
        throw error;
      }
      expect(await run(alias)).toMatchObject({ errorCode: 'INVALID_ARGS' });
      expect(h.upsert).not.toHaveBeenCalled();
      expect(h.restore).not.toHaveBeenCalled();
      await rm(alias);
      await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
      // Preserve the logical alias identity, not the physical target path.
      expect(await run(alias)).toMatchObject({ ok: true, workingDir: alias.replaceAll('\\', '/') });
    },
  );
  it('rejects files, relative paths and managed task worktrees', async () => {
    const file = path.join(directory, 'file');
    await writeFile(file, 'contents');
    expect(await run(file)).toMatchObject({ errorCode: 'NOT_A_DIRECTORY' });
    expect(await run('relative')).toMatchObject({ errorCode: 'INVALID_ARGS' });
    expect(await run(path.join(directory, '.cindy-worktrees', 'task'))).toMatchObject({
      errorCode: 'INVALID_ARGS',
    });
    expect(h.upsert).not.toHaveBeenCalled();
  });
  it('rejects unavailable storage and callers outside the local account', async () => {
    h.ready = false;
    expect(await run(directory)).toMatchObject({ errorCode: 'HOST_NOT_READY' });
    h.ready = true;
    h.query.mockResolvedValueOnce([]);
    expect(await run(directory)).toMatchObject({ errorCode: 'NO_SESSION_CONTEXT' });
    h.query.mockResolvedValueOnce([{ id: 'caller', remoteHostId: 'ssh-host' }]);
    expect(await run(directory)).toMatchObject({ errorCode: 'UNSUPPORTED_CAPABILITY' });
    expect(h.upsert).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform === 'win32')(
    'rejects literal POSIX backslashes instead of registering another path',
    async () => {
      expect(await run(path.join(directory, 'a\\b'))).toMatchObject({ errorCode: 'INVALID_ARGS' });
      expect(h.query).not.toHaveBeenCalled();
      expect(h.upsert).not.toHaveBeenCalled();
    },
  );
  it('does not report successful registration after a persistence failure', async () => {
    h.upsert.mockResolvedValueOnce(false);
    expect(await run(directory)).toMatchObject({ ok: false, errorCode: 'INTERNAL' });
    expect(h.restore).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });
  it('fences an account change before persistence', async () => {
    h.query.mockImplementationOnce(async () => {
      h.owner.ownerGeneration++;
      return [{ id: 'caller', remoteHostId: null }];
    });
    expect(await run(directory)).toMatchObject({ errorCode: 'PRECONDITION_FAILED' });
    expect(h.upsert).not.toHaveBeenCalled();
  });
  it('does not restore or broadcast into a new account after persistence', async () => {
    h.upsert.mockImplementationOnce(async () => {
      h.owner.ownerGeneration++;
      return true;
    });
    expect(await run(directory)).toMatchObject({ errorCode: 'PRECONDITION_FAILED' });
    expect(h.restore).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });
  it('does not announce success if restoring the project fails', async () => {
    h.restore.mockRejectedValueOnce(new Error('write failed'));
    expect(await run(directory)).toMatchObject({ ok: false, errorCode: 'INTERNAL' });
    expect(h.send).not.toHaveBeenCalled();
  });
  it('lists empty and hidden projects with aliases and explicit pagination', async () => {
    const workingDir = directory.replaceAll('\\', '/');
    h.hiddenKeys = [`local:${workingDir}`];
    h.aliases.mockResolvedValue([{ projectKey: `local:${workingDir}`, alias: 'My project' }]);
    h.list.mockResolvedValue([
      { path: workingDir, exists: false, lastUsedAt: '2026-09-17T00:00:00Z' },
      { path: `${workingDir}/second`, exists: true, lastUsedAt: '2026-09-16T00:00:00Z' },
    ]);
    expect(
      await listProjects({ callerSessionId: 'caller', includeHidden: true, offset: 0, limit: 1 }),
    ).toMatchObject({
      ok: true,
      total: 2,
      nextOffset: 1,
      projects: [
        {
          workingDir,
          directoryName: path.basename(directory),
          alias: 'My project',
          hidden: true,
          exists: false,
        },
      ],
    });
    expect(
      await listProjects({
        callerSessionId: 'caller',
        includeHidden: false,
        offset: 0,
        limit: 100,
      }),
    ).toMatchObject({
      ok: true,
      total: 1,
      nextOffset: null,
      projects: [{ directoryName: 'second', alias: null, hidden: false }],
    });
  });
  it('renames a registered offline project and clears the alias without changing its directory or visibility', async () => {
    const workingDir = directory.replaceAll('\\', '/');
    await rm(directory, { recursive: true });
    h.rename.mockResolvedValueOnce({ alias: 'New name' });
    expect(
      await renameProject({ callerSessionId: 'caller', workingDir, name: 'New name' }),
    ).toEqual({ ok: true, workingDir, alias: 'New name' });
    expect(h.rename).toHaveBeenCalledWith(
      `local:${workingDir}`,
      'New name',
      process.platform,
      expect.objectContaining({ assertCurrent: expect.any(Function), client: expect.any(Object) }),
    );
    expect(await renameProject({ callerSessionId: 'caller', workingDir, name: '' })).toEqual({
      ok: true,
      workingDir,
      alias: null,
    });
    expect(h.visibility).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });
  it('removes project grouping idempotently and restores it through createProject', async () => {
    const workingDir = directory.replaceAll('\\', '/');
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await removeProject({ callerSessionId: 'caller', workingDir })).toEqual({
        ok: true,
        workingDir,
        removed: true,
      });
      expect(h.visibility).toHaveBeenLastCalledWith(workingDir, true, h.owner);
    }
    expect(h.rename).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
    expect(await createProject({ callerSessionId: 'caller', workingDir })).toEqual({
      ok: true,
      workingDir,
    });
    expect(h.restore).toHaveBeenCalledWith(workingDir, h.owner);
  });
  it('rejects metadata edits for unregistered projects', async () => {
    h.registered = [];
    expect(
      await renameProject({ callerSessionId: 'caller', workingDir: directory, name: 'Wrong' }),
    ).toMatchObject({ errorCode: 'NOT_FOUND' });
    expect(
      await removeProject({
        callerSessionId: 'caller',
        workingDir: directory,
      }),
    ).toMatchObject({ errorCode: 'NOT_FOUND' });
    expect(h.rename).not.toHaveBeenCalled();
    expect(h.visibility).not.toHaveBeenCalled();
  });
  it('discards project list results after the active account changes', async () => {
    h.list.mockImplementationOnce(async () => {
      h.owner.ownerGeneration++;
      return [];
    });
    expect(
      await listProjects({ callerSessionId: 'caller', includeHidden: true, offset: 0, limit: 100 }),
    ).toMatchObject({ errorCode: 'PRECONDITION_FAILED' });
  });
});
