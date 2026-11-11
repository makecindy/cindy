/**
 * Regression: PR #6813 review found stale saves resurrecting deleted profile folders and
 * repository grouping conflating independently linked worktrees; duplicate basenames in settings. Existing storage tests
 * do not exercise access IDs, availability, or lifecycle locking. Minimum inputs: an
 * accessor created before deletion; a base repo plus its missing worktree in an old file.
 * Single-file run: 356ms (5 tests); tier: unit. Production access/storage/profile lock, real temporary files; only account,
 * DB projections and renderer notifications are stubbed. No real-time waits or app launch.
 */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  root: '', status: 'active',
  registered: vi.fn<() => Promise<Array<{ path: string; exists: boolean }>>>(),
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'owner', isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: () => h.root,
}));
vi.mock('../../localDb/ipc/bots.js', () => ({
  getBotRemoteSettingsSource: async () => {
    if (h.status === 'deleted') throw new Error('Bot does not exist');
    return { source: { status: h.status } };
  },
}));
vi.mock('../../localDb/ipc/recentWorkdirs.js', () => ({ listRecentWorkdirs: h.registered }));
vi.mock('../../localDb/ipc/projectAliases.js', () => ({ listProjectAliases: async () => [] }));
vi.mock('../../sidebarSettingsStore.js', () => ({ loadSidebarSettingsSnapshot: () => ({ hiddenProjectKeys: [] }) }));
vi.mock('../botRemoteResourceInvalidation.js', () => ({ broadcastBotRemoteResourceChanged: () => {} }));

import { botLinkedProjectAccess } from '../botLinkedProjects.js';
import { botProfileDir } from '../botProfileFolder.js';
import { withBotProfileLocks } from '../botProfileLock.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(async () => {
  h.root = await mkdtemp(path.join(os.tmpdir(), 'bot-linked-projects-'));
  h.status = 'active';
  h.registered.mockReset().mockResolvedValue([{ path: h.root, exists: true }]);
});
afterEach(async () => { await rm(h.root, { recursive: true, force: true }); });

it('keeps a missing legacy worktree distinct and removes only that association', async () => {
  const worktree = path.join(h.root, '.cindy-worktrees', 'worker');
  const file = path.join(botProfileDir(h.root, 'bot-1'), 'workbench.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ directories: [h.root, worktree].map(directory => ({ path: directory, addedAt: 'old' })), tasks: {} }));
  const service = await botLinkedProjectAccess('bot-1');
  const options = await service.read();
  expect(options).toHaveLength(2);
  const base = options.find(item => item.path === h.root)!;
  const child = options.find(item => item.path === worktree)!;
  expect(child.id).not.toBe(base.id);
  expect(base.available).toBe(true);
  expect(child.available).toBe(false);
  await service.set(child.id, false);
  expect(JSON.parse(await readFile(file, 'utf8')).directories).toEqual([{ path: h.root, addedAt: 'old' }]);
});

it('rejects a queued save after deletion without recreating the profile directory', async () => {
  const service = await botLinkedProjectAccess('bot-1');
  const [project] = await service.read();
  await service.set(project.id, true);
  const entered = deferred();
  const finishDelete = deferred();
  const deletion = withBotProfileLocks(['bot-1'], async () => {
    entered.resolve();
    await finishDelete.promise;
    h.status = 'deleted';
    await rm(botProfileDir(h.root, 'bot-1'), { recursive: true });
  });
  await entered.promise;
  const saving = service.set(project.id, true);
  const rejected = expect(saving).rejects.toThrow('Bot does not exist');
  finishDelete.resolve();
  await deletion;
  await rejected;
  await expect(access(botProfileDir(h.root, 'bot-1'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('holds the profile lock throughout a save so deletion runs after the write', async () => {
  const service = await botLinkedProjectAccess('bot-1');
  const [project] = await service.read();
  const entered = deferred();
  const finishRead = deferred();
  h.registered.mockImplementationOnce(async () => {
    entered.resolve();
    await finishRead.promise;
    return [{ path: h.root, exists: true }];
  });
  const saving = service.set(project.id, true);
  await entered.promise;
  let savedDirectories: unknown;
  const deletion = withBotProfileLocks(['bot-1'], async () => {
    savedDirectories = JSON.parse(await readFile(path.join(botProfileDir(h.root, 'bot-1'), 'workbench.json'), 'utf8')).directories;
    h.status = 'deleted';
    await rm(botProfileDir(h.root, 'bot-1'), { recursive: true });
  });
  finishRead.resolve();
  await Promise.all([saving, deletion]);
  expect(savedDirectories).toEqual([expect.objectContaining({ path: h.root })]);
  await expect(access(botProfileDir(h.root, 'bot-1'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rechecks active status when using an accessor created before a pause', async () => {
  const service = await botLinkedProjectAccess('bot-1');
  const [project] = await service.read();
  h.status = 'paused';
  await expect(service.set(project.id, true)).rejects.toThrow('Teammate is not active');
  await expect(access(botProfileDir(h.root, 'bot-1'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('disambiguates registered projects with the same basename before exposing them to settings', async () => {
  h.registered.mockResolvedValue([
    { path: path.join(h.root, 'team-a', 'app'), exists: true },
    { path: path.join(h.root, 'team-b', 'app'), exists: true },
  ]);
  const options = await (await botLinkedProjectAccess('bot-1')).read();
  expect(options.map(project => project.name)).toEqual(['team-a/app', 'team-b/app']);
});
