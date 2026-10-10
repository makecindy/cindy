import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROJECT_WORKSPACES_CHANGED_CHANNEL,
  PROJECT_WORKSPACES_GET_CHANNEL,
  PROJECT_WORKSPACES_MUTATE_CHANNEL,
  type ProjectWorkspaceMutation,
} from '../../shared/projectWorkspaceSettings.js';
import { registerProjectWorkspaceIpc } from '../projectWorkspaceStore.js';

const harness = vi.hoisted(() => ({
  root: '',
  ownerId: 'owner-a' as string | null,
  generation: 1,
  boundaryPending: false,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
  untrustedSend: vi.fn(),
  tapWindowBroadcast: vi.fn(),
  assertTrusted: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { trusted: true, webContents: { send: harness.send } },
      { trusted: false, webContents: { send: harness.untrustedSend } },
    ],
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      harness.handlers.set(channel, handler);
    },
  },
}));

vi.mock('../appSessionState.js', () => ({
  activeOwnerScopeKey: () => ['cloud', harness.ownerId, harness.generation].join(':'),
  getActiveDataOwnerPushStamp: () => ({
    dataOwnerId: harness.ownerId,
    ownerGeneration: harness.generation,
  }),
  isAppSessionBoundaryPending: () => harness.boundaryPending,
  ownerScopedUserDataPath: (...parts: string[]) =>
    path.join(harness.root, 'owners', harness.ownerId ?? 'none', ...parts),
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: (...args: unknown[]) => harness.assertTrusted(...args),
  isTrustedAppRendererWindow: (window: { trusted: boolean }) => window.trusted,
}));

vi.mock('../device-link/broadcast-tap.js', () => ({
  tapWindowBroadcast: (...args: unknown[]) => harness.tapWindowBroadcast(...args),
}));

function stamp() {
  return { dataOwnerId: harness.ownerId, ownerGeneration: harness.generation };
}

function settingsPath(ownerId = 'owner-a') {
  return path.join(harness.root, 'owners', ownerId, 'project-workspaces.json');
}

async function invoke(channel: string, ...args: unknown[]) {
  const handler = harness.handlers.get(channel);
  if (!handler) throw new Error('handler not registered');
  return handler({ trusted: true }, ...args);
}

function getSnapshot() {
  return invoke(PROJECT_WORKSPACES_GET_CHANNEL);
}

function mutate(mutation: ProjectWorkspaceMutation) {
  return invoke(PROJECT_WORKSPACES_MUTATE_CHANNEL, { ownerStamp: stamp(), mutation });
}

function create(id: string, name = id) {
  return mutate({ type: 'create', id, name });
}

function workspace(id: string, projectKeys: string[] = []) {
  return { id, name: id, projectKeys, collapsed: false };
}

function writeSettings(contents: string) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), contents);
}

describe('projectWorkspaceStore', () => {
  beforeEach(() => {
    harness.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-project-workspaces-'));
    harness.ownerId = 'owner-a';
    harness.generation = 1;
    harness.boundaryPending = false;
    harness.handlers.clear();
    vi.clearAllMocks();
    harness.assertTrusted.mockReset();
    registerProjectWorkspaceIpc();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(harness.root, { recursive: true, force: true });
  });

  it('GET returns defaults without creating a file', async () => {
    await expect(getSnapshot()).resolves.toEqual({ workspaces: [], ownerStamp: stamp() });
    expect(fs.existsSync(settingsPath())).toBe(false);
  });

  it('persists creation, trimmed names, rename and collapse, with fenced local broadcasts', async () => {
    await create('business', '  Business  ');
    await mutate({ type: 'rename', id: 'business', name: '  Work  ' });
    const snapshot = await mutate({ type: 'set-collapsed', id: 'business', collapsed: true });
    expect(snapshot).toEqual({
      workspaces: [{ id: 'business', name: 'Work', projectKeys: [], collapsed: true }],
      ownerStamp: stamp(),
    });
    expect(await getSnapshot()).toEqual(snapshot);
    expect(JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))).toEqual({
      workspaces: [{ id: 'business', name: 'Work', projectKeys: [], collapsed: true }],
    });
    expect(harness.send).toHaveBeenLastCalledWith(
      PROJECT_WORKSPACES_CHANGED_CHANNEL,
      snapshot,
      stamp(),
    );
    expect(harness.untrustedSend).not.toHaveBeenCalled();
    expect(harness.tapWindowBroadcast).not.toHaveBeenCalled();
  });

  it('creates a group and moves its project in one persisted update and broadcast', async () => {
    await create('first');
    await mutate({ type: 'move-project', projectKey: 'local:/repo', workspaceId: 'first' });
    harness.send.mockClear();
    const snapshot = await mutate({
      type: 'create',
      id: 'second',
      name: 'second',
      projectKey: 'local:/repo',
    });
    expect(snapshot).toEqual({
      workspaces: [workspace('first'), workspace('second', ['local:/repo'])],
      ownerStamp: stamp(),
    });
    expect(harness.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).workspaces).toEqual([
      workspace('first'),
      workspace('second', ['local:/repo']),
    ]);
  });

  it('keeps the original membership if creating and moving fails to persist', async () => {
    await mutate({ type: 'create', id: 'first', name: 'first', projectKey: 'local:/repo' });
    harness.send.mockClear();
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('disk failure');
    });
    await expect(
      mutate({ type: 'create', id: 'second', name: 'second', projectKey: 'local:/repo' }),
    ).rejects.toThrow('[INTERNAL]');
    expect(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).workspaces).toEqual([
      workspace('first', ['local:/repo']),
    ]);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('rejects trimmed case-insensitive duplicate names on create and rename', async () => {
    await create('first', ' Work ');
    await create('second', 'Other');
    harness.send.mockClear();
    await expect(create('third', '  wORK ')).rejects.toThrow('[ALREADY_EXISTS]');
    await expect(mutate({ type: 'rename', id: 'second', name: ' work ' })).rejects.toThrow(
      '[ALREADY_EXISTS]',
    );
    expect(harness.send).not.toHaveBeenCalled();
    await mutate({ type: 'rename', id: 'first', name: ' WORK ' });
    await create('longest', 'x'.repeat(80));
    expect(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).workspaces).toEqual([
      { ...workspace('first'), name: 'WORK' },
      { ...workspace('second'), name: 'Other' },
      { ...workspace('longest'), name: 'x'.repeat(80) },
    ]);
  });

  it('reorders groups while preserving their contents', async () => {
    await create('first');
    await create('second');
    await mutate({ type: 'move-project', projectKey: 'local:/repo', workspaceId: 'first' });
    await expect(mutate({ type: 'reorder', workspaceIds: ['second', 'first'] })).resolves.toEqual({
      workspaces: [workspace('second'), workspace('first', ['local:/repo'])],
      ownerStamp: stamp(),
    });
  });

  it('moves local and remote project keys exclusively and supports ungrouping', async () => {
    await create('first');
    await create('second');
    const projectKey = 'device:other:/repo';
    await mutate({ type: 'move-project', projectKey, workspaceId: 'first' });
    await mutate({ type: 'move-project', projectKey, workspaceId: 'second' });
    await mutate({ type: 'move-project', projectKey: 'local:/keep', workspaceId: 'second' });
    await mutate({ type: 'move-project', projectKey, workspaceId: 'second' });
    await expect(getSnapshot()).resolves.toEqual({
      workspaces: [workspace('first'), workspace('second', [projectKey, 'local:/keep'])],
      ownerStamp: stamp(),
    });
    await mutate({ type: 'move-project', projectKey, workspaceId: null });
    await expect(getSnapshot()).resolves.toEqual({
      workspaces: [workspace('first'), workspace('second', ['local:/keep'])],
      ownerStamp: stamp(),
    });
  });

  it('deletes only the group and membership without changing projects or other groups', async () => {
    const projectFile = path.join(harness.root, 'project.txt');
    fs.writeFileSync(projectFile, 'keep project and task data');
    await create('first');
    await create('second');
    await mutate({
      type: 'move-project',
      projectKey: 'local:' + projectFile,
      workspaceId: 'first',
    });
    await mutate({ type: 'move-project', projectKey: 'local:/other', workspaceId: 'second' });
    await expect(mutate({ type: 'delete', id: 'first' })).resolves.toEqual({
      workspaces: [workspace('second', ['local:/other'])],
      ownerStamp: stamp(),
    });
    expect(fs.readFileSync(projectFile, 'utf8')).toBe('keep project and task data');
    await mutate({ type: 'delete', id: 'second' });
    await expect(getSnapshot()).resolves.toEqual({ workspaces: [], ownerStamp: stamp() });
  });

  it.each([
    null,
    {},
    { type: 'create', id: '', name: 'valid' },
    { type: 'create', id: ' ', name: 'valid' },
    { type: 'create', id: 'x'.repeat(129), name: 'valid' },
    { type: 'create', id: 'valid', name: '  ' },
    { type: 'create', id: 'valid', name: 'x'.repeat(81) },
    { type: 'create', id: 'valid', name: 'valid', projectKey: '' },
    { type: 'create', id: 'valid', name: 'valid', projectKeys: [] },
    { type: 'rename', id: 'valid', name: 12 },
    { type: 'reorder', workspaceIds: ['same', 'same'] },
    { type: 'reorder', workspaceIds: 'invalid' },
    { type: 'move-project', projectKey: '', workspaceId: null },
    { type: 'move-project', projectKey: 'x'.repeat(4097), workspaceId: null },
    { type: 'move-project', projectKey: 'local:/repo' },
    { type: 'set-collapsed', id: 'valid', collapsed: 'true' },
    { type: 'unknown' },
  ])('rejects malformed mutation %j without writing or broadcasting', async (mutation) => {
    await expect(
      invoke(PROJECT_WORKSPACES_MUTATE_CHANNEL, { ownerStamp: stamp(), mutation }),
    ).rejects.toThrow('[INVALID_PARAMS]');
    expect(fs.existsSync(settingsPath())).toBe(false);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('rejects missing, malformed or excess request fields and extra IPC arguments', async () => {
    const mutation = { type: 'create', id: 'first', name: 'first' };
    for (const request of [
      { mutation },
      { ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: -1 }, mutation },
      { ownerStamp: { ...stamp(), extra: true }, mutation },
      { ownerStamp: stamp(), mutation, extra: true },
    ]) {
      await expect(invoke(PROJECT_WORKSPACES_MUTATE_CHANNEL, request)).rejects.toThrow(
        '[INVALID_PARAMS]',
      );
    }
    await expect(invoke(PROJECT_WORKSPACES_GET_CHANNEL, {})).rejects.toThrow('[INVALID_PARAMS]');
    await expect(
      invoke(PROJECT_WORKSPACES_MUTATE_CHANNEL, { ownerStamp: stamp(), mutation }, {}),
    ).rejects.toThrow('[INVALID_PARAMS]');
    expect(fs.existsSync(settingsPath())).toBe(false);
  });

  it('rejects duplicate IDs, missing targets and incomplete or unknown reorder IDs', async () => {
    await create('first');
    const saved = fs.readFileSync(settingsPath(), 'utf8');
    harness.send.mockClear();
    await expect(create('first')).rejects.toThrow('[ALREADY_EXISTS]');
    await expect(mutate({ type: 'rename', id: 'missing', name: 'new' })).rejects.toThrow(
      '[NOT_FOUND]',
    );
    await expect(mutate({ type: 'delete', id: 'missing' })).rejects.toThrow('[NOT_FOUND]');
    await expect(mutate({ type: 'set-collapsed', id: 'missing', collapsed: true })).rejects.toThrow(
      '[NOT_FOUND]',
    );
    await expect(
      mutate({ type: 'move-project', projectKey: 'local:/repo', workspaceId: 'missing' }),
    ).rejects.toThrow('[NOT_FOUND]');
    await expect(mutate({ type: 'reorder', workspaceIds: [] })).rejects.toThrow('[INVALID_PARAMS]');
    await expect(mutate({ type: 'reorder', workspaceIds: ['missing'] })).rejects.toThrow(
      '[NOT_FOUND]',
    );
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(saved);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('isolates owners and rejects stale owner and generation stamps', async () => {
    await create('first');
    const originalStamp = stamp();
    harness.ownerId = 'owner-b';
    harness.generation++;
    await expect(getSnapshot()).resolves.toEqual({ workspaces: [], ownerStamp: stamp() });
    await expect(
      invoke(PROJECT_WORKSPACES_MUTATE_CHANNEL, {
        ownerStamp: originalStamp,
        mutation: { type: 'create', id: 'wrong', name: 'wrong' },
      }),
    ).rejects.toThrow('[PRECONDITION_FAILED]');
    await create('second');
    expect(fs.existsSync(settingsPath('owner-b'))).toBe(true);
    harness.ownerId = 'owner-a';
    harness.generation++;
    await expect(getSnapshot()).resolves.toEqual({
      workspaces: [workspace('first')],
      ownerStamp: stamp(),
    });
    await expect(
      invoke(PROJECT_WORKSPACES_MUTATE_CHANNEL, {
        ownerStamp: originalStamp,
        mutation: { type: 'delete', id: 'first' },
      }),
    ).rejects.toThrow('[PRECONDITION_FAILED]');
  });

  it.each(['signed-out', 'boundary-pending'])(
    'blocks writes and returns an unstamped empty GET when %s',
    async (mode) => {
      await create('first');
      harness.send.mockClear();
      if (mode === 'signed-out') harness.ownerId = null;
      else harness.boundaryPending = true;
      await expect(getSnapshot()).resolves.toEqual({ workspaces: [] });
      await expect(create('second')).rejects.toThrow('[PRECONDITION_FAILED]');
      expect(harness.send).not.toHaveBeenCalled();
      expect(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).workspaces).toEqual([
        workspace('first'),
      ]);
    },
  );

  it('rejects an owner switch while the asynchronous write lock is being acquired', async () => {
    const pending = create('first');
    harness.ownerId = 'owner-b';
    harness.generation++;
    await expect(pending).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(fs.existsSync(settingsPath())).toBe(false);
    expect(fs.existsSync(settingsPath('owner-b'))).toBe(false);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('fences a completed write from broadcasting into a new account', async () => {
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      rename(source, target);
      if (target === settingsPath()) {
        harness.ownerId = 'owner-b';
        harness.generation++;
      }
    });
    await expect(create('first')).rejects.toThrow('[PRECONDITION_FAILED]');
    expect(harness.send).not.toHaveBeenCalled();
    await expect(getSnapshot()).resolves.toEqual({ workspaces: [], ownerStamp: stamp() });
    expect(fs.existsSync(settingsPath('owner-b'))).toBe(false);
  });

  it('rejects corrupted GET without rewriting the file and retries after repair', async () => {
    writeSettings('{broken');
    const originalMtime = fs.statSync(settingsPath()).mtime;
    await expect(getSnapshot()).rejects.toThrow('[INTERNAL]');
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe('{broken');
    writeSettings(JSON.stringify({ workspaces: [workspace('recovered')] }));
    fs.utimesSync(settingsPath(), originalMtime, originalMtime);
    await expect(getSnapshot()).resolves.toEqual({
      workspaces: [workspace('recovered')],
      ownerStamp: stamp(),
    });
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('rejects unreadable GET and retries after access recovers without a timestamp change', async () => {
    const contents = JSON.stringify({ workspaces: [workspace('saved')] });
    writeSettings(contents);
    const originalMtime = fs.statSync(settingsPath()).mtimeMs;
    const open = fs.openSync;
    const failure = vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      if (file === settingsPath()) {
        throw Object.assign(new Error('private/path: access denied'), { code: 'EACCES' });
      }
      return open(file, flags, mode);
    });
    await expect(getSnapshot()).rejects.toThrow('[INTERNAL] failed to read project workspaces');
    failure.mockRestore();
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(contents);
    expect(fs.statSync(settingsPath()).mtimeMs).toBe(originalMtime);
    await expect(getSnapshot()).resolves.toEqual({
      workspaces: [workspace('saved')],
      ownerStamp: stamp(),
    });
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('does not serve a cached success after its file becomes corrupted', async () => {
    await create('saved');
    await expect(getSnapshot()).resolves.toEqual({
      workspaces: [workspace('saved')],
      ownerStamp: stamp(),
    });
    const originalMtime = fs.statSync(settingsPath()).mtime;
    writeSettings('{broken');
    fs.utimesSync(settingsPath(), originalMtime, originalMtime);
    await expect(getSnapshot()).rejects.toThrow('[INTERNAL]');
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe('{broken');
  });

  it('reads an empty override object as the default empty workspace list', async () => {
    writeSettings('{}');
    await expect(getSnapshot()).resolves.toEqual({ workspaces: [], ownerStamp: stamp() });
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe('{}');
  });

  it.each([
    '{broken',
    '[]',
    '{"workspaces":42}',
    JSON.stringify({ workspaces: [workspace('same'), workspace('same')] }),
    JSON.stringify({
      workspaces: [workspace('first', ['local:/same']), workspace('second', ['local:/same'])],
    }),
    JSON.stringify({ workspaces: [workspace('first', ['local:/same', 'local:/same'])] }),
    ' '.repeat(1024 * 1024 + 1),
  ])('preserves unreadable files and refuses mutations (case %#)', async (contents) => {
    writeSettings(contents);
    await expect(getSnapshot()).rejects.toThrow('[INTERNAL]');
    await expect(create('new')).rejects.toThrow('[INTERNAL]');
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(contents);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('keeps the saved state and does not broadcast when atomic replacement fails', async () => {
    await create('first');
    const saved = fs.readFileSync(settingsPath(), 'utf8');
    harness.send.mockClear();
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('private/path: disk write failed');
    });
    await expect(mutate({ type: 'rename', id: 'first', name: 'changed' })).rejects.toThrow(
      '[INTERNAL] failed to persist project workspaces',
    );
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe(saved);
    await expect(getSnapshot()).resolves.toEqual({
      workspaces: [workspace('first')],
      ownerStamp: stamp(),
    });
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('fails deleting the final group when removing its override fails', async () => {
    await create('first');
    harness.send.mockClear();
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
      if (file === settingsPath()) throw new Error('cannot delete settings');
      unlink(file);
    });
    await expect(mutate({ type: 'delete', id: 'first' })).rejects.toThrow('[INTERNAL]');
    await expect(getSnapshot()).resolves.toEqual({
      workspaces: [workspace('first')],
      ownerStamp: stamp(),
    });
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('preserves independent concurrent mutations', async () => {
    await Promise.all([create('first'), create('second')]);
    await Promise.all([
      mutate({ type: 'rename', id: 'first', name: 'renamed' }),
      mutate({ type: 'set-collapsed', id: 'first', collapsed: true }),
      mutate({ type: 'move-project', projectKey: 'local:/repo', workspaceId: 'second' }),
    ]);
    expect(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).workspaces).toEqual(
      expect.arrayContaining([
        { id: 'first', name: 'renamed', projectKeys: [], collapsed: true },
        workspace('second', ['local:/repo']),
      ]),
    );
  });

  it('allows only one concurrent creation with the same normalized name', async () => {
    const results = await Promise.allSettled([create('first', ' Work '), create('second', 'WORK')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'ALREADY_EXISTS' }) }),
    ]);
    expect(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).workspaces).toHaveLength(1);
    expect(harness.send).toHaveBeenCalledTimes(1);
  });

  it('reads fresh disk contents for mutations even when the cached mtime is unchanged', async () => {
    await create('first');
    const stat = fs.statSync(settingsPath());
    writeSettings(JSON.stringify({ workspaces: [workspace('first'), workspace('external')] }));
    fs.utimesSync(settingsPath(), stat.atime, stat.mtime);
    await expect(mutate({ type: 'rename', id: 'first', name: 'changed' })).resolves.toEqual({
      workspaces: [{ ...workspace('first'), name: 'changed' }, workspace('external')],
      ownerStamp: stamp(),
    });
  });

  it('requires trusted renderer validation for both IPC channels', async () => {
    harness.assertTrusted.mockImplementation(() => {
      throw new Error('[PERMISSION_DENIED] untrusted renderer');
    });
    await expect(getSnapshot()).rejects.toThrow('[PERMISSION_DENIED]');
    await expect(create('first')).rejects.toThrow('[PERMISSION_DENIED]');
    expect(harness.assertTrusted).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(settingsPath())).toBe(false);
    expect(harness.send).not.toHaveBeenCalled();
  });
});
