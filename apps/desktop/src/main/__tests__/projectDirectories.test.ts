/** Unit tier. Project settings must survive reload/account switches and apply at the next
 * turn without overwriting legacy task grants. Existing icon tests cover neither scope nor
 * filesystem permissions. Minimal inputs: two directories, a worktree task, then revoke. */
import { mkdtemp, realpath, mkdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '@cindy/maker-core';
const h = vi.hoisted(() => ({ root: '', owner: 'a', row: null as Record<string, unknown> | null }));
vi.mock('../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.owner,
  ownerScopedUserDataPath: (file: string) => path.join(h.root, h.owner, file),
  getActiveDataOwnerPushStamp: () => ({ dataOwnerId: h.owner, ownerGeneration: 1 }),
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../logger.js', () => ({
  createLogger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
}));
vi.mock('../localDb/client/current.js', () => ({
  getDbClient: () => ({
    drizzle: {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => (h.row ? [h.row] : []) }) }),
      }),
    },
  }),
}));
import { readProjectDirectories, setProjectDirectories } from '../projectDirectoryStore';
import { configureProjectDirectoryProbe, validateProjectDirectories } from '../projectDirectoryValidation';
import { applyProjectDirectoriesForTurn, createTaskWritableDirsUpdater } from '../projectDirectoryRuntime';
import { applyRemoteDirectoryGrantUpdate } from '../maker-ipc/remoteDirectoryGrantUpdate.js';
import {
  parseHostProjectAliasesSnapshot,
  resolveProjectDirectories,
} from '@cindy/maker-shared/project-alias-sync';
let main: string, reference: string, output: string;
beforeAll(async () => {
  h.root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cindy-project-directories-')));
  [main, reference, output] = ['repo', 'reference', 'output'].map((name) =>
    path.join(h.root, name),
  );
  await Promise.all([main, reference, output].map((dir) => mkdir(dir)));
});
afterAll(async () => {
  await rm(h.root, { recursive: true, force: true });
});
beforeEach(() => {
  h.owner = 'a';
  h.row = {
    workspaceKind: 'project',
    source: 'desktop',
    projectDir: main,
    workingDir: main,
    remoteHostId: null,
    extraDirs: JSON.stringify([reference]),
    writableDirs: '[]',
  };
});
const capabilities = { extraDirs: { supported: true }, writableDirs: { supported: true } };

it('persists project scopes and isolates account changes, including an explicit empty override', async () => {
  await setProjectDirectories(`local:${main}`, [{ path: reference, access: 'read' }], () => {});
  await setProjectDirectories(`local:${output}`, [], () => {});
  expect(readProjectDirectories()[`local:${main}`]).toEqual([{ path: reference, access: 'read' }]);
  h.owner = 'b';
  expect(readProjectDirectories()).toEqual({});
  h.owner = 'a';
  expect(readProjectDirectories()[`local:${output}`]).toEqual([]);
  await expect(
    setProjectDirectories(`local:${main}`, [], () => {
      throw new Error('account changed');
    }),
  ).rejects.toThrow('account changed');
  expect(readProjectDirectories()[`local:${main}`]).toHaveLength(1);
});
it('rejects overlapping and symlink-equivalent directories before saving access', async () => {
  await expect(
    validateProjectDirectories(`local:${main}`, [
      { path: output, access: 'write' },
      { path: reference, access: 'read' },
    ]),
  ).resolves.toEqual([{ path: output, access: 'write' }, { path: reference, access: 'read' }]);
  await expect(
    validateProjectDirectories(`local:${main}`, [{ path: h.root, access: 'read' }]),
  ).rejects.toThrow('overlap');
  const alias = path.join(h.root, 'alias');
  await symlink(output, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await expect(
    validateProjectDirectories(`local:${main}`, [
      { path: output, access: 'write' },
      { path: alias, access: 'read' },
    ]),
  ).rejects.toThrow('overlap');
  await expect(
    validateProjectDirectories(`local:${main}`, [
      { path: path.join(h.root, 'missing'), access: 'write' },
    ]),
  ).rejects.toThrow();
});
it('applies the owning project to a worktree on each turn and preserves legacy task-only grants', async () => {
  h.row = {
    workspaceKind: 'project',
    source: 'desktop',
    projectDir: main,
    workingDir: path.join(main, '.cindy-worktrees', 'one'),
    remoteHostId: null,
    extraDirs: JSON.stringify([reference]),
    writableDirs: '[]',
  };
  const observed = { read: [] as string[], write: [] as string[] };
  const session = {
    id: 'task',
    capabilities,
    setExtraDirs: async (dirs: string[]) => {
      observed.read = dirs;
    },
    setWritableDirs: async (dirs: string[]) => {
      observed.write = dirs;
    },
  } as unknown as Session;
  await setProjectDirectories(`local:${main}`, [{ path: output, access: 'write' }], () => {});
  expect(observed.write).toEqual([]); // Saving alone cannot change the running turn.
  await applyProjectDirectoriesForTurn(session);
  expect(observed).toEqual({ read: [reference], write: [output] });
  await setProjectDirectories(`local:${main}`, [{ path: output, access: 'read' }], () => {});
  expect(observed.write).toEqual([output]);
  await applyProjectDirectoriesForTurn(session);
  expect(observed).toEqual({ read: [reference, output], write: [] });
  await setProjectDirectories(`local:${main}`, [], () => {});
  await applyProjectDirectoriesForTurn(session);
  expect(observed).toEqual({ read: [reference], write: [] });
  expect(h.row.extraDirs).toBe(JSON.stringify([reference]));
});
// Unit regression for #11511: turn-only tests missed a picker update replacing the live project's roots.
it('keeps the running project grant when adding or removing a task directory', async () => {
  h.row!.extraDirs = '[]';
  let live: string[] = [];
  const session = {
    id: 'task', capabilities, setExtraDirs: vi.fn(),
    setWritableDirs: async (dirs: string[]) => { live = dirs; },
  } as unknown as Session;
  const persist = vi.fn(async (patch: { writableDirs?: string[] }) => {
    h.row!.writableDirs = JSON.stringify(patch.writableDirs);
  });
  const update = (dirs: string[]) => applyRemoteDirectoryGrantUpdate('writableDirs', dirs, {
    setWritableDirs: createTaskWritableDirsUpdater(session), setExtraDirs: vi.fn(),
  }, {
    validate: async (valid) => ({ valid, rejected: [] }),
    readExtraDirs: async () => [],
    readWritableDirs: async () => JSON.parse(String(h.row!.writableDirs)),
    excludeConflicts: async (candidates) => [...candidates],
    persist,
    terminate: vi.fn(),
  });
  await setProjectDirectories(`local:${main}`, [{ path: output, access: 'write' }], () => {});
  await applyProjectDirectoriesForTurn(session);
  await update([reference]);
  expect(live).toEqual([output]);
  expect(h.row!.writableDirs).toBe(JSON.stringify([reference]));
  await applyProjectDirectoriesForTurn(session);
  expect(live).toEqual([reference, output]);
  persist.mockRejectedValueOnce(new Error('save failed'));
  await expect(update([])).rejects.toThrow('save failed');
  expect(live).toEqual([reference, output]);
  await update([]);
  expect(live).toEqual([output]);
  expect(h.row!.writableDirs).toBe('[]');
  await update([reference]);
  expect(live).toEqual([output]);
});

it('never promotes a pre-existing read-only task override through project defaults', async () => {
  const observed: string[][] = [];
  await setProjectDirectories(`local:${main}`, [{ path: reference, access: 'write' }], () => {});
  await applyProjectDirectoriesForTurn({
    id: 'task',
    capabilities,
    setExtraDirs: async () => {},
    setWritableDirs: async (dirs: string[]) => {
      observed.push(dirs);
    },
  } as unknown as Session);
  expect(observed).toEqual([[]]);
});
// Unit regression for #11511: disjoint grants do not exercise source retention after tree overlap.
it.each(['task parent', 'project parent'] as const)('preserves independently granted roots when adding and removing a %s', async (order) => {
  const child = path.join(output, 'shared');
  await mkdir(child, { recursive: true });
  const [taskDir, projectDir] = order === 'task parent' ? [output, child] : [child, output];
  await setProjectDirectories(`local:${main}`, [{ path: projectDir, access: 'write' }], () => {});
  let live: string[] = [];
  const session = {
    id: 'task', capabilities, setExtraDirs: vi.fn(),
    setWritableDirs: async (dirs: string[]) => { live = dirs; },
  } as unknown as Session;
  await applyProjectDirectoriesForTurn(session);
  expect(live).toEqual([projectDir]);
  await createTaskWritableDirsUpdater(session)([taskDir]);
  expect(live).toEqual([projectDir]);
  h.row!.writableDirs = JSON.stringify([taskDir]);
  await applyProjectDirectoriesForTurn(session);
  const before = [...live];
  expect(before).toEqual(order === 'task parent' ? [taskDir, projectDir] : [projectDir]);
  const edit = createTaskWritableDirsUpdater(session);
  await edit([]);
  expect(live).toEqual([projectDir]);
  await edit([taskDir]); // Roll back the same edit.
  expect(live).toEqual(before);
  const readOnlySibling = path.join(output, 'read-only');
  await mkdir(readOnlySibling, { recursive: true });
  h.row!.extraDirs = JSON.stringify([readOnlySibling]);
  await applyProjectDirectoriesForTurn(session);
  expect(live).toEqual([child]); // The read-only sibling blocks the parent regardless of who granted it.
  h.row!.extraDirs = '[]';
  await setProjectDirectories(`local:${main}`, [], () => {});
  await applyProjectDirectoriesForTurn(session);
  expect(live).toEqual([taskDir]);
});
it('old hosts remain compatible while malformed directory payloads cannot become write grants', () => {
  expect(
    resolveProjectDirectories(
      parseHostProjectAliasesSnapshot({ aliases: [], platform: 'linux' })!,
      `local:${main}`,
    ),
  ).toBeUndefined();
  const snapshot = parseHostProjectAliasesSnapshot({
    aliases: [],
    platform: 'linux',
    directories: {
      [`local:${main}`]: [{ path: output, access: 'write' }],
      'local:/bad': [{ path: 'relative', access: 'write' }],
    },
  });
  expect(resolveProjectDirectories(snapshot!, `local:${main}`)).toEqual([
    { path: output, access: 'write' },
  ]);
  expect(resolveProjectDirectories(snapshot!, 'local:/bad')).toBeUndefined();
});

// Unit regression: legacy paths on the controller must not be relabeled as SSH grants.
it('labels only the saved project subset for the matching SSH host, including revocation', async () => {
  configureProjectDirectoryProbe(async (_host, path) => path);
  h.row = { ...h.row, projectDir: '/srv/project', workingDir: '/srv/project',
    remoteHostId: 'ssh-1', extraDirs: '["/controller/reference"]', writableDirs: '["/controller/output"]' };
  const key = 'remote:ssh-1:/srv/project';
  await setProjectDirectories(key, [{ path: '/srv/reference', access: 'read' }, { path: '/srv/output', access: 'write' }], () => {});
  const setExtraDirs = vi.fn(async () => {}), setWritableDirs = vi.fn(async () => {});
  const session = { id: 'ssh-task', capabilities, setExtraDirs, setWritableDirs } as unknown as Session;
  await applyProjectDirectoriesForTurn(session);
  expect(setExtraDirs).toHaveBeenLastCalledWith(expect.any(Array), null,
    { hostId: 'ssh-1', directories: ['/srv/reference'] });
  expect(setWritableDirs).toHaveBeenLastCalledWith(expect.any(Array),
    { hostId: 'ssh-1', directories: ['/srv/output'] });
  await setProjectDirectories(key, [], () => {});
  await applyProjectDirectoriesForTurn(session);
  expect(setExtraDirs).toHaveBeenLastCalledWith(expect.any(Array), null, { hostId: 'ssh-1', directories: [] });
  expect(setWritableDirs).toHaveBeenLastCalledWith(expect.any(Array), { hostId: 'ssh-1', directories: [] });
});

// Unit: select two ordinary fixture directories through an SSH alias. The grant stays on its
// confirmed target and the turn hook stops before installing a target that now resolves elsewhere.
it('resolves SSH selections on their host and checks the saved physical path at each turn', async () => {
  const key = 'remote:build:/work/project';
  const targets: Record<string, string> = { '/links/art': '/data/art' };
  configureProjectDirectoryProbe(async (host, name) => {
    expect(host).toBe('build');
    return targets[name] ?? name;
  });
  const input = [{ path: '/links/art', access: 'write' as const }];
  await expect(validateProjectDirectories(key, input)).rejects.toThrow('/data/art');
  const saved = await validateProjectDirectories(key, input, true);
  expect(saved).toEqual([{ path: '/data/art', access: 'write' }]);
  targets['/work/project/child'] = '/data/other';
  await expect(validateProjectDirectories(key, [{ path: '/work/project/child', access: 'read' }], true)).rejects.toThrow('overlap');
  await setProjectDirectories(key, saved, () => {});
  h.row = { ...h.row, projectDir: '/work/project', workingDir: '/work/project', remoteHostId: 'build', extraDirs: null };
  const setWritableDirs = vi.fn();
  const session = { id: 'remote-task', capabilities, setWritableDirs, setExtraDirs: vi.fn() } as unknown as Session;
  targets['/links/art'] = '/data/other';
  await applyProjectDirectoriesForTurn(session);
  expect(setWritableDirs).toHaveBeenLastCalledWith(['/data/art'], { hostId: 'build', directories: ['/data/art'] });
  targets['/data/art'] = '/data/other';
  setWritableDirs.mockClear();
  await expect(applyProjectDirectoriesForTurn(session)).rejects.toThrow('TARGET_CHANGED');
  expect(setWritableDirs).not.toHaveBeenCalled();
});
