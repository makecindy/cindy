import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { LocalWorktreeReference } from '../localDb/worker/worktreeReferences';
import type { WorktreeMeta } from '../worktree/types';

const state = vi.hoisted(() => ({
  root: '',
  rows: [] as LocalWorktreeReference[],
  metas: [] as WorktreeMeta[],
}));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('../logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({ readLocalWorktreeReferences: async () => state.rows }),
}));
vi.mock('../worktree/runtimeLeases', () => ({ readWorktreeRuntimePaths: async () => new Set() }));
vi.mock('../worktree/worktreeStore', () => ({ getAll: () => state.metas }));

import { hasLiveSessionReference, loadLiveSessionPathKeys } from '../worktree/liveSessionRefs';
import { readPiSubagentWorktreeReferences } from '../worktree/piSubagentReferences';

describe('detached Pi Subagent worktree references', () => {
  let worktree: string;
  const runRoot = (sessionId = 'parent') => path.join(
    state.root, 'pi-agent-home', 'runtime', 'pi-subagent-runs', sessionId,
  );
  const writeRun = async (sessionId = 'parent', config: unknown = { version: 1, cwd: worktree, tasks: [{}] }) => {
    const directory = path.join(runRoot(sessionId), 'durable-generation');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify(config));
    return directory;
  };
  const livePaths = () => loadLiveSessionPathKeys({ excludeSessionId: 'parent', isSessionRuntimeAlive: () => false });
  const protects = async (target = worktree) => hasLiveSessionReference({ path: target }, await livePaths());

  beforeEach(async () => {
    state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-worktree-pi-refs-'));
    worktree = path.join(state.root, 'repo', '.cindy-worktrees', 'original');
    await fs.mkdir(worktree, { recursive: true });
    state.rows = [{
      id: 'parent', status: 'archived', source: 'desktop', currentDatabase: true,
      workingDir: worktree, worktreePath: worktree,
    }];
    state.metas = [];
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(state.root, { recursive: true, force: true });
  });

  it('allows the excluded terminal parent without durable runs to be recycled', async () => {
    expect(await protects()).toBe(false);
    await fs.mkdir(runRoot(), { recursive: true });
    expect(await protects()).toBe(false);
  });

  it('keeps an excluded archived parent after its root runtime lease has gone', async () => {
    await writeRun();
    expect(await protects()).toBe(true);
  });

  it.each(['completed', 'failed', 'cancelled'])('does not use %s or dead pid as proof that every child stopped', async (status) => {
    const run = await writeRun();
    await fs.writeFile(path.join(run, 'status.json'), JSON.stringify({ state: status, pid: 99999999, heartbeatAt: 0 }));
    expect(await protects()).toBe(true);
  });

  it('protects the old and child-specific cwd after the parent switches to an ordinary directory', async () => {
    const childDir = path.join(state.root, 'other-repo', '.xdt-worktrees', 'child');
    const currentDir = path.join(state.root, 'ordinary-project');
    state.rows[0] = { ...state.rows[0], workingDir: currentDir, worktreePath: null };
    await writeRun('parent', { version: 1, cwd: worktree, tasks: [{ cwd: childDir }] });
    expect(await protects()).toBe(true);
    expect(await protects(childDir)).toBe(true);
    expect(await protects(currentDir)).toBe(true);
  });

  it('preserves current and registered parent paths as well as the durable cwd', async () => {
    const registered = path.join(state.root, 'repo', '.cindy-worktrees', 'registered');
    state.metas = [{
      sessionId: 'parent', path: registered, name: 'registered', baseRepo: path.dirname(path.dirname(registered)),
      branch: 'cindy/registered', sourceBranch: 'main', createdAt: '2026-09-08T00:00:00.000Z',
    }];
    await writeRun('parent', { version: 1, cwd: path.join(state.root, 'old-project'), tasks: [{}] });
    expect(await protects()).toBe(true);
    expect(await protects(registered)).toBe(true);
  });

  it('keeps durable cwd even when no parent database or registry row remains', async () => {
    state.rows = [];
    await writeRun('orphaned-parent');
    expect(await protects()).toBe(true);
  });

  it('keeps terminal parent references from another local database', async () => {
    state.rows[0] = { ...state.rows[0], currentDatabase: false, status: 'deleted' };
    await writeRun('parent', { version: 1, cwd: path.join(state.root, 'other-cwd'), tasks: [{}] });
    expect(await protects()).toBe(true);
  });

  it.each([
    { version: 2, cwd: '/unknown-format', tasks: [] },
    { version: 1, cwd: 'relative-cwd', tasks: [] },
    { version: 1, tasks: [] },
    { version: 1, cwd: '/root', tasks: [{ cwd: 42 }] },
  ])('preserves all worktrees when a durable config cannot establish every cwd', async (config) => {
    await writeRun('parent', config);
    expect(await livePaths()).toBeNull();
    expect(await protects()).toBe(true);
  });

  it('reads past the host launch fence and the staging file a crash leaves in the run root', async () => {
    const root = path.dirname(runRoot());
    await fs.mkdir(root, { recursive: true });
    const fence = JSON.stringify({ version: 1, hostPid: 4_194_303, hostStartTimeSec: 1, createdAt: 0 });
    const staging = '.launch-fence-4194303.json.tmp-4194303-89aea6ae-a2c7-4fa4-8856-82503af66389';
    await fs.writeFile(path.join(root, '.launch-fence-4194303.json'), fence);
    await fs.writeFile(path.join(root, staging), fence);
    await fs.writeFile(path.join(root, '.launch-fence.json.tmp-4194303-89aea6ae-a2c7-4fa4-8856-82503af66389'), '{"vers');

    // No session holds a reference, so the recycle may go on to its own checks.
    expect(await readPiSubagentWorktreeReferences()).toEqual(new Map());
    expect(await livePaths()).not.toBeNull();
    expect(await protects()).toBe(false);

    // And a real reference beside the debris is still read in full.
    await writeRun();
    expect(await readPiSubagentWorktreeReferences()).toEqual(new Map([['parent', [worktree]]]));
    expect(await protects()).toBe(true);
  });

  it.each(['directory', 'link'])('preserves when a fence-named entry is a %s', async (shape) => {
    await writeRun();
    const entry = path.join(path.dirname(runRoot()), '.launch-fence-4194303.json.tmp-4194303-89aea6ae-a2c7-4fa4-8856-82503af66389');
    if (shape === 'directory') {
      await fs.mkdir(entry);
    } else {
      const target = path.join(state.root, 'link-target');
      if (process.platform === 'win32') await fs.mkdir(target);
      else await fs.writeFile(target, '{}');
      // Junctions exercise the same lstat link guard without requiring Windows symlink privileges.
      await fs.symlink(target, entry, process.platform === 'win32' ? 'junction' : undefined);
      expect((await fs.lstat(entry)).isSymbolicLink()).toBe(true);
    }
    const followingStat = vi.spyOn(fs, 'stat');
    expect(await livePaths()).toBeNull();
    // A directory junction must not hide a regression that follows the entry before rejecting it.
    expect(followingStat.mock.calls.some(([target]) => target === entry)).toBe(false);
  });

  it.each(['notes.txt', '.launch-fence-backup.json', '.launch-fence-.json'])(
    'preserves when a plain file it does not know (%s) sits in the run root',
    async (name) => {
      await writeRun();
      await fs.writeFile(path.join(path.dirname(runRoot()), name), 'x');
      expect(await livePaths()).toBeNull();
    },
  );

  it('does not filter out unfinished or malformed run directories', async () => {
    await fs.mkdir(path.join(runRoot(), 'not-a-uuid'), { recursive: true });
    expect(await livePaths()).toBeNull();
  });

  it('preserves when the durable directory cannot be read', async () => {
    await writeRun();
    const readdir = fs.readdir;
    vi.spyOn(fs, 'readdir').mockImplementation(((directory: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
      if (String(directory) === runRoot()) {
        return Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
      }
      return Reflect.apply(readdir, fs, [directory, ...args]);
    }) as typeof fs.readdir);
    expect(await livePaths()).toBeNull();
  });

  it('preserves when config disappears or becomes corrupt during the read', async () => {
    const run = await writeRun();
    await fs.writeFile(path.join(run, 'config.json'), '{');
    expect(await readPiSubagentWorktreeReferences()).toBeNull();
    await fs.unlink(path.join(run, 'config.json'));
    expect(await readPiSubagentWorktreeReferences()).toBeNull();
  });

  it.each(['root', 'session', 'run'])('preserves when a %s directory redirects through a junction', async (level) => {
    const redirected = level === 'root' ? path.dirname(runRoot())
      : level === 'session' ? runRoot() : path.join(runRoot(), 'durable-generation');
    const target = path.join(state.root, 'redirect-target');
    await fs.mkdir(target);
    await fs.mkdir(path.dirname(redirected), { recursive: true });
    await fs.symlink(target, redirected, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await livePaths()).toBeNull();
  });

  it('preserves when the config path is a link', async () => {
    const run = await writeRun();
    const configFile = path.join(run, 'config.json');
    const lstat = fs.lstat;
    vi.spyOn(fs, 'lstat').mockImplementation((async (file: Parameters<typeof fs.lstat>[0]) => {
      const stat = await lstat(file);
      if (String(file) === configFile) stat.isSymbolicLink = () => true;
      return stat;
    }) as typeof fs.lstat);
    expect(await livePaths()).toBeNull();
  });

  it.each(['root', 'session', 'run'])('preserves when %s entries change while being read', async (level) => {
    const run = await writeRun();
    const changedDirectory = level === 'root' ? path.dirname(runRoot()) : level === 'session' ? runRoot() : run;
    const readdir = fs.readdir;
    let reads = 0;
    vi.spyOn(fs, 'readdir').mockImplementation(((directory: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
      if (String(directory) === changedDirectory && ++reads === 2) {
        return Promise.resolve(['changed-after-first-read']);
      }
      return Reflect.apply(readdir, fs, [directory, ...args]);
    }) as typeof fs.readdir);
    expect(await livePaths()).toBeNull();
  });

  it('does not confuse a root disappearing during enumeration with an absent root', async () => {
    await writeRun();
    const root = path.dirname(runRoot());
    const readdir = fs.readdir;
    vi.spyOn(fs, 'readdir').mockImplementation(((directory: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
      if (String(directory) === root) return Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }));
      return Reflect.apply(readdir, fs, [directory, ...args]);
    }) as typeof fs.readdir);
    expect(await livePaths()).toBeNull();
  });

  it('does not treat a redirected agent home without a run root as absence', async () => {
    const target = path.join(state.root, 'redirect-target');
    await fs.mkdir(target);
    await fs.symlink(target, path.join(state.root, 'pi-agent-home'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await livePaths()).toBeNull();
  });
});
