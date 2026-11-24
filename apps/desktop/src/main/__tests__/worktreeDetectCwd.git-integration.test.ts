import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AcpAgent, type AcpLineTransport, type Logger } from '@cindy/maker-core';

import { createCheckoutService } from '../worktree/checkout';
import '../worktree/WorktreeManagerPorts.desktop';
import { awaitBackgroundCheckout, createWorktree, detectCwd } from '../worktree/WorktreeManager';
import { createWorkerWorktree } from '../maker-ipc/orcaWorkerProject';
import { app } from 'electron';
import type { WorktreeMeta } from '../worktree/types';

const metadata = vi.hoisted(() => new Map<string, WorktreeMeta>());
vi.mock('../worktree/worktreeStore', () => ({
  get: (id: string) => metadata.get(id),
  getAll: () => [...metadata.values()],
  getAllPaths: () => [...metadata.values()].map((m) => m.path),
  set: async (id: string, meta: WorktreeMeta) => {
    metadata.set(id, meta);
  },
  del: (id: string) => metadata.delete(id),
}));
vi.mock('../worktree/runtimeLeases', () => ({
  acquireWorktreeRuntimeLease: async () => ({}),
  recordWorktreeRuntimeLeaseChild: () => {},
  releaseWorktreeRuntimeLease: async () => {},
}));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const exec = promisify(execFile);
let fixture: string | undefined;

// #11157: createWorktree must preserve repository/inherited hooks and Git's unset
// default. Mocked creation tests cannot observe shared config or hook execution.
// Minimal failure: a repo with core.hooksPath=.custom-hooks, then one creation.
// Real Git config + main/sibling/new-checkout commits belong in git-integration.
it.each(['relative', 'absolute', 'inherited', 'unset'] as const)(
  'preserves hooks configuration and execution when creating a worktree: %s',
  async (mode) => {
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-create-hooks-'));
    vi.spyOn(app, 'getPath').mockReturnValue(fixture);
    const repo = path.join(fixture, 'repo');
    await fs.mkdir(repo);
    const globalConfig = path.join(fixture, 'global-config');
    await fs.writeFile(globalConfig, '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    const git = async (cwd: string, ...args: string[]) =>
      (await exec('git', args, { cwd, windowsHide: true, timeout: 10_000 })).stdout.trim();
    await git(repo, 'init', '--initial-branch=main');
    await git(repo, 'config', 'user.name', 'Test');
    await git(repo, 'config', 'user.email', 'test@example.invalid');
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'fixture');
    await git(repo, 'add', 'tracked.txt');
    const hooks = mode === 'unset' ? path.join(repo, '.git', 'hooks')
      : mode === 'relative' ? path.join(repo, '.custom-hooks') : path.join(fixture, 'custom hooks');
    await fs.mkdir(hooks, { recursive: true });
    await fs.writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\nprintf ran > hook-ran\n', { mode: 0o755 });
    if (mode !== 'unset') {
      await git(repo, 'config', mode === 'inherited' ? '--global' : '--local',
        'core.hooksPath', mode === 'relative' ? '.custom-hooks' : hooks);
    }
    if (mode === 'relative') {
      await git(repo, 'add', '.custom-hooks/pre-commit');
      await git(repo, 'update-index', '--chmod=+x', '.custom-hooks/pre-commit');
    }
    await git(repo, 'commit', '--allow-empty', '-m', 'fixture');
    expect(await fs.readFile(path.join(repo, 'hook-ran'), 'utf8')).toBe('ran');
    await fs.unlink(path.join(repo, 'hook-ran'));
    const sibling = path.join(fixture, 'sibling');
    await git(repo, 'worktree', 'add', '-b', 'sibling', sibling);
    const configBefore = await fs.readFile(path.join(repo, '.git', 'config'), 'utf8');
    const globalBefore = await fs.readFile(globalConfig, 'utf8');
    const created = await createWorktree(
      { sessionId: `hooks-${mode}`, baseRepo: repo, name: `hooks-${mode}`, sourceBranch: 'main' },
      { awaitFullCheckout: true },
    );
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) return;
    expect(await fs.readFile(path.join(repo, '.git', 'config'), 'utf8')).toBe(configBefore);
    expect(await fs.readFile(globalConfig, 'utf8')).toBe(globalBefore);
    for (const cwd of [repo, sibling, created.meta.path]) {
      await git(cwd, 'commit', '--allow-empty', '-m', 'verify hook');
      expect(await fs.readFile(path.join(cwd, 'hook-ran'), 'utf8')).toBe('ran');
    }
  },
  30_000,
);

afterEach(async () => {
  vi.restoreAllMocks();
  metadata.clear();
  vi.unstubAllEnvs();
  if (fixture) await fs.rm(fixture, { recursive: true, force: true });
});

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GIT_')) vi.stubEnv(key, undefined);
  }
  vi.stubEnv('GIT_CONFIG_GLOBAL', process.platform === 'win32' ? 'NUL' : os.devNull);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

it('preserves real Git snapshots for attached, detached, unborn, missing and nested directories', async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-detect-cwd-'));
  const repo = path.join(fixture, 'repo');
  await fs.mkdir(repo);
  const git = (...args: string[]) => exec('git', args, { cwd: repo, windowsHide: true });
  await git('init', '--initial-branch=main');
  const unborn = await detectCwd(repo);
  expect(unborn.currentBranch).toBeUndefined();
  expect(await createCheckoutService(async () => []).status(repo)).toMatchObject({ current: 'HEAD', head: '' });
  expect(unborn).toMatchObject({
    isGitRepo: true,
    isInsideWorktree: false,
    gitInstalled: true,
  });
  await git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'fixture',
  );
  expect(await detectCwd(repo)).toMatchObject({ currentBranch: 'main', isInsideWorktree: false });

  const linked = path.join(fixture, 'linked');
  await git('worktree', 'add', '-b', 'feature', linked);
  const snapshot = await detectCwd(linked);
  expect(snapshot).toMatchObject({
    isGitRepo: true,
    isInsideWorktree: true,
    currentBranch: 'feature',
  });
  const subdir = path.join(linked, 'nested');
  await fs.mkdir(subdir);
  expect(await detectCwd(subdir)).toEqual(snapshot);
  await git('-C', linked, 'checkout', '--detach');
  expect(await detectCwd(linked)).toEqual({ ...snapshot, currentBranch: undefined });
  await git('worktree', 'remove', '--force', linked);
  await git('checkout', '--detach');
  const detached = await detectCwd(repo);
  expect(detached.isGitRepo).toBe(true);
  expect(detached.currentBranch).toBeUndefined();
  expect(await detectCwd(linked)).toMatchObject({
    isGitRepo: false,
    isInsideWorktree: false,
    gitInstalled: true,
  });
  expect(await detectCwd(fixture)).toMatchObject({
    isGitRepo: false,
    isInsideWorktree: false,
    gitInstalled: true,
  });

  if (process.platform !== 'win32') {
    const spaced = path.join(fixture, 'repo ');
    await fs.mkdir(spaced);
    await git('-C', spaced, 'init', '--initial-branch=main');
    expect((await detectCwd(spaced)).repoRoot).toBe(await fs.realpath(spaced));
    await git(
      '-C',
      spaced,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'fixture',
    );
    expect((await detectCwd(spaced)).repoRoot).toBe(await fs.realpath(spaced));
    const newlinePath = path.join(fixture, 'line\nbreak');
    await git('worktree', 'add', '--detach', newlinePath);
    const newlineSnapshot = await detectCwd(newlinePath);
    expect(newlineSnapshot).toMatchObject({ isGitRepo: true, isInsideWorktree: true });
    expect(newlineSnapshot.repoRoot).toBe(await fs.realpath(newlinePath));
  }
}, 30_000);

// #6409: existing snapshots never crossed a directory symlink. Exercise detectCwd
// with A/link -> B/workspace/project, where Git can mix absolute git-dir and
// physical-cwd-relative common-dir. Real Git belongs in the git-integration tier.
it.for(['unborn', 'committed'] as const)(
  'does not label a symlink into a %s ordinary repository as a linked worktree',
  async (state, context) => {
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-detect-cwd-symlink-'));
    const repoA = path.join(fixture, 'A');
    const repoB = path.join(fixture, 'B');
    const nested = path.join(repoB, 'workspace', 'project');
    await fs.mkdir(repoA);
    await fs.mkdir(nested, { recursive: true });
    const git = (...args: string[]) => exec('git', args, { cwd: repoB, windowsHide: true });
    await git('-C', repoA, 'init', '--initial-branch=main');
    await git('init', '--initial-branch=main');
    if (state === 'committed') {
      await git(
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'fixture',
      );
    }
    const link = path.join(repoA, 'link');
    try {
      await fs.symlink(nested, link, 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        context.skip();
        return;
      }
      throw error;
    }
    expect(await detectCwd(link)).toMatchObject({
      isGitRepo: true,
      isInsideWorktree: false,
      gitInstalled: true,
      repoRoot: await fs.realpath(repoB),
    });
  },
);

// Rule C: Desktop creation refreshes its selected remote default before checkout;
// automatic/mobile paths keep the old behavior. Existing detection tests never
// exercised the created tree. Real Git + local bare remote, git-integration tier.
// #11956 / git-integration: HEAD alone is insufficient. Have a synthetic
// ACP endpoint read a file absent from the base checkout on its first prompt,
// and exercise a real Git checkout error after ref resolution succeeds.
it.each(['fresh', 'offline', 'other-source', 'legacy', 'checkout-fails'] as const)(
  'creates from the expected source with default refresh: %s',
  async (mode) => {
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-create-default-'));
    vi.spyOn(app, 'getPath').mockReturnValue(fixture);
    const remote = path.join(fixture, 'remote.git');
    const seed = path.join(fixture, 'seed');
    const repo = path.join(fixture, 'repo');
    await fs.mkdir(seed);
    const git = async (cwd: string, ...args: string[]) =>
      (await exec('git', args, { cwd, windowsHide: true })).stdout.trim();
    await git(seed, 'init', '--initial-branch=main');
    await git(seed, 'config', 'user.name', 'Test');
    await git(seed, 'config', 'user.email', 'test@example.invalid');
    await fs.writeFile(path.join(seed, 'tracked.txt'), 'old');
    await git(seed, 'add', '.');
    await git(seed, 'commit', '-m', 'old');
    await git(fixture, 'clone', '--bare', seed, remote);
    await git(fixture, 'clone', remote, repo);
    const old = await git(repo, 'rev-parse', 'HEAD');
    await git(repo, 'switch', '-c', 'feature');
    await fs.writeFile(path.join(seed, 'tracked.txt'), 'new');
    await fs.writeFile(path.join(seed, 'marker.txt'), 'selected branch only');
    await fs.writeFile(path.join(seed, '.gitattributes'), 'marker.txt filter=fixture-marker\n');
    await git(seed, 'add', 'marker.txt', '.gitattributes');
    await git(seed, 'commit', '-am', 'new');
    await git(seed, 'push', remote, 'main');
    const latest = await git(seed, 'rev-parse', 'HEAD');
    if (mode === 'offline')
      await git(repo, 'remote', 'set-url', 'origin', path.join(fixture, 'missing.git'));
    // A fork's upstream must never silently replace the selected origin default.
    await git(repo, 'remote', 'add', 'upstream', path.join(fixture, 'missing-upstream.git'));
    if (mode === 'checkout-fails') {
      await git(repo, 'config', 'filter.fixture-marker.smudge', 'false');
      await git(repo, 'config', 'filter.fixture-marker.required', 'true');
    }
    const sourceBranch = mode === 'other-source' ? 'feature' : 'refs/remotes/origin/main';
    const created = await createWorktree(
      { sessionId: mode, baseRepo: repo, name: mode, sourceBranch },
      {
        refreshDefaultSource: mode !== 'legacy',
        awaitFullCheckout: true,
      },
    );
    await expect(fs.access(path.join(repo, 'marker.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git(repo, 'branch', '--show-current')).toBe('feature');
    if (mode === 'checkout-fails') {
      expect(created).toMatchObject({ ok: false, error: { rawStderr: expect.stringContaining('fixture-marker') } });
      expect(metadata.has(mode)).toBe(false);
      return;
    }
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) return;
    const expected = mode === 'fresh' ? latest : old;
    expect(await git(created.meta.path, 'rev-parse', 'HEAD')).toBe(expected);
    expect(await fs.readFile(path.join(created.meta.path, 'tracked.txt'), 'utf8')).toBe(
      mode === 'fresh' ? 'new' : 'old',
    );
    if (mode === 'fresh') {
      const read = Promise.withResolvers<{ cwd: string; prompt: unknown; marker: string }>();
      const logger: Logger = {
        trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger,
      };
      let onLine: ((line: string) => void) | undefined;
      let pluginCwd: string;
      const transport: AcpLineTransport = {
        write(line) {
          const { id, method, params } = JSON.parse(line);
          const reply = (result: object) => queueMicrotask(() => {
            onLine?.(JSON.stringify({ jsonrpc: '2.0', id, result }));
          });
          if (method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
          if (method === 'session/new') {
            pluginCwd = params.cwd;
            reply({ sessionId: 'fixture-session' });
          }
          if (method === 'session/prompt') {
            void fs.readFile(path.join(pluginCwd, 'marker.txt'), 'utf8').then((marker) => {
              read.resolve({ cwd: pluginCwd, prompt: params.prompt, marker });
              reply({ stopReason: 'end_turn' });
            }, read.reject);
          }
        },
        onLine(listener) {
          onLine = listener;
          return () => { onLine = undefined; };
        },
        onClose: () => () => {},
        close: async () => {},
      };
      const agent = new AcpAgent({
        auth: {
          getState: async () => ({ authenticated: true }),
          triggerLogin: async () => ({ authenticated: true }),
          logout: async () => {},
          getAuthEnv: async () => ({}),
        },
        binaryPath: '', runtimeConfig: {}, logger, clientInfo: { name: 'fixture', version: '1' },
        endpoints: { connect: async () => transport },
      });
      const session = await agent.startSession({
        workingDir: created.meta.path, providerId: 'acp-plugin:fixture:marker', model: '',
      });
      try {
        await session.send({ type: 'user', content: 'Read marker.txt' });
        await expect(read.promise).resolves.toEqual({
          cwd: created.meta.path,
          prompt: [{ type: 'text', text: 'Read marker.txt' }],
          marker: 'selected branch only',
        });
      } finally {
        await session.close();
      }
    } else {
      await expect(fs.readFile(path.join(created.meta.path, 'marker.txt'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(created.meta.sourceBranch).toBe(sourceBranch);
  },
  30_000,
);

// Orca Workers based on the origin default used to skip the refresh, so whole
// batches started behind main. Tool calls name it as `origin/main`, which the
// Desktop-only refresh did not recognize. Minimal failure: the remote advances
// after the local fetch. Real Git + local bare remote, git-integration tier.
it('creates an Orca Worker from the freshly fetched origin default', async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-worker-default-'));
  vi.spyOn(app, 'getPath').mockReturnValue(fixture);
  const remote = path.join(fixture, 'remote.git');
  const seed = path.join(fixture, 'seed');
  const repo = path.join(fixture, 'repo');
  await fs.mkdir(seed);
  const git = async (cwd: string, ...args: string[]) =>
    (await exec('git', args, { cwd, windowsHide: true, timeout: 10_000 })).stdout.trim();
  await git(seed, 'init', '--initial-branch=main');
  await git(seed, 'config', 'user.name', 'Test');
  await git(seed, 'config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(seed, 'tracked.txt'), 'old');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'old');
  await git(fixture, 'clone', '--bare', seed, remote);
  await git(fixture, 'clone', remote, repo);
  const old = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'branch', 'origin/main');
  await fs.writeFile(path.join(seed, 'tracked.txt'), 'new');
  await git(seed, 'commit', '-am', 'new');
  await git(seed, 'push', remote, 'main');
  const latest = await git(seed, 'rev-parse', 'HEAD');

  // #12391 review: a colliding local branch made the short remote name
  // ambiguous at checkout. A full local ref must still select the local branch.
  const localWorker = await createWorkerWorktree('orca-local', repo, 'refs/heads/origin/main');
  await awaitBackgroundCheckout('orca-local');
  expect(await git(localWorker, 'rev-parse', 'HEAD')).toBe(old);
  expect(await git(repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(old);

  const workerDir = await createWorkerWorktree('orca-worker', repo, 'origin/main');
  await awaitBackgroundCheckout('orca-worker');
  expect(await git(workerDir, 'rev-parse', 'HEAD')).toBe(latest);
  expect(await fs.readFile(path.join(workerDir, 'tracked.txt'), 'utf8')).toBe('new');
  expect(metadata.get('orca-worker')?.sourceBranch).toBe('refs/remotes/origin/main');
}, 30_000);

// #6792: createWorktree must populate the linked worktree's full index after
// background checkout. Existing checks use ordinary repositories. Reproduce
// with a local submodule and inherited recursion before its linked gitdir exists.
// Real Git configuration and index behavior belong in git-integration.
it('completes staged checkout with inherited submodule recursion', async () => {
  fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-submodule-trial-'));
  vi.spyOn(app, 'getPath').mockReturnValue(fixture);
  const git = async (cwd: string, ...args: string[]) =>
    (await exec('git', args, { cwd, timeout: 10_000 })).stdout.trim();
  const repo = path.join(fixture, 'repo');
  const sub = path.join(fixture, 'sub');
  for (const dir of [repo, sub]) {
    await fs.mkdir(dir);
    await git(dir, 'init', '-b', 'main');
    await git(dir, 'config', 'user.name', 'Cindy fixture');
    await git(dir, 'config', 'user.email', 'fixture@example.invalid');
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), 'fixture\n');
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'fixture\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', 'fixture');
  }
  await git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', sub, 'deps/sub');
  await git(repo, 'commit', '-m', 'add local fixture submodule');
  await git(repo, 'config', 'submodule.recurse', 'true');
  const result = await createWorktree(
    { sessionId: 'submodule', baseRepo: repo, name: 'submodule', sourceBranch: 'main' },
    { trackBackgroundCheckout: true },
  );
  await awaitBackgroundCheckout('submodule');
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(await git(result.meta.path, 'ls-files')).toBe(
    await git(repo, 'ls-tree', '-r', '--name-only', 'HEAD'),
  );
  expect(await git(result.meta.path, 'status', '--porcelain=v1')).toBe('');
  expect(await fs.readFile(path.join(result.meta.path, 'tracked.txt'), 'utf8')).toBe('fixture\n');
  expect(await git(repo, 'config', '--local', 'submodule.recurse')).toBe('true');
});
