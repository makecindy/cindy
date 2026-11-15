/** Unit tier. Project settings must survive reload/account switches and apply at the next
 * turn without overwriting legacy task grants. Existing icon tests cover neither scope nor
 * filesystem permissions. Minimal inputs: two directories, a worktree task, then revoke. */
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
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
import { validateProjectDirectories } from '../projectDirectoryValidation';
import { applyProjectDirectoriesForTurn } from '../projectDirectoryRuntime';
import {
  parseHostProjectAliasesSnapshot,
  resolveProjectDirectories,
} from '@cindy/maker-shared/project-alias-sync';
let main: string, reference: string, output: string;
beforeAll(async () => {
  h.root = await mkdtemp(path.join(os.tmpdir(), 'cindy-project-directories-'));
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
  ).resolves.toBeUndefined();
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
