import path from 'node:path';
import { mkdtemp, mkdir, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import { createGroupProjectFolders, findRepositoryFolders, folderRepositories } from '../groupProjectFolder.js';
import { describe, expect, it, vi } from 'vitest';
import { createGroupProjectCheckouts, type GitResult, type GroupCheckoutDeps } from '../groupProjectCheckout.js';

/**
 * bot-group-chat.md §7.5: a group's repository that is not a registered project is fetched by Cindy
 * itself. Unit: the real module over a fake disk and a scripted git; no process is started.
 */
const root = path.resolve('/cindy/projects');
const dir = path.join(root, 'github', 'makecindy', 'cindy');
const cindyRepo = { kind: 'github' as const, repo: 'makecindy/cindy' };
const ok: GitResult = { exitCode: 0, stdout: '', stderr: '' };

function setup(options: { signedIn?: boolean; clone?: 'ok' | 'denied'; git?: boolean; signInFinishes?: boolean; remote?: string } = {}) {
  const disk = new Set<string>();
  let signedIn = options.signedIn ?? true;
  const calls: string[][] = [];
  const deps: GroupCheckoutDeps = {
    root: () => root,
    gitAvailable: async () => options.git ?? true,
    githubHelper: async () => signedIn ? '/opt/bin/gh' : null,
    openSignIn: vi.fn(() => true),
    waitForSignIn: vi.fn(async () => { signedIn = options.signInFinishes === true; return signedIn; }),
    register: vi.fn(async () => undefined),
    git: async args => {
      calls.push(args);
      if (args.includes('clone')) {
        if ((options.clone ?? 'ok') === 'denied') return { exitCode: 128, stdout: '', stderr: 'denied' };
        const target = args.at(-1)!;
        disk.add(target); disk.add(path.join(target, '.git')); disk.add(path.join(target, 'AGENTS.md'));
        return ok;
      }
      if (args[0] === 'remote') return { ...ok, stdout: `${options.remote ?? 'https://github.com/makecindy/cindy.git'}\n` };
      if (args[0] === 'config' && args.includes('--get-all')) return { exitCode: 1, stdout: '', stderr: '' };
      return ok;
    },
    fs: {
      exists: async target => disk.has(target),
      readdir: async target => [...disk].filter(entry => path.dirname(entry) === target).map(entry => path.basename(entry)),
      mkdir: async target => { disk.add(target); },
      rename: async (from, to) => {
        for (const entry of [...disk]) if (entry === from || entry.startsWith(from + path.sep)) { disk.delete(entry); disk.add(to + entry.slice(from.length)); }
      },
      rm: async target => { for (const entry of [...disk]) if (entry === target || entry.startsWith(target + path.sep)) disk.delete(entry); },
    },
  };
  return { checkouts: createGroupProjectCheckouts(deps), deps, disk, calls };
}
const request = { signIn: true, isCurrent: () => true };

describe('group project checkout', () => {
  it('clones the repository once with Cindy\'s GitHub sign-in and registers it as a project', async () => {
    const { checkouts, deps, disk, calls } = setup();
    expect(await checkouts.ensure(cindyRepo, request)).toEqual({ status: 'ready', dir });
    const clone = calls.find(args => args.includes('clone'))!;
    expect(clone).toEqual(expect.arrayContaining(['--depth', '1', 'https://github.com/makecindy/cindy.git']));
    expect(clone.join(' ')).toContain("credential.https://github.com.helper=!'/opt/bin/gh' auth git-credential");
    expect(disk.has(path.join(dir, 'AGENTS.md'))).toBe(true);
    expect(deps.register).toHaveBeenCalledExactlyOnceWith(dir);
    // The next request finds it there and fetches nothing again.
    expect(await checkouts.ensure(cindyRepo, request)).toEqual({ status: 'ready', dir });
    expect(calls.filter(args => args.includes('clone'))).toHaveLength(1);
    expect(checkouts.isManaged(dir)).toBe(true);
    expect(checkouts.isManaged('/projects/cindy')).toBe(false);
  });

  // #10163 review (Greptile): the account switched while the clone ran. The folder stays on the first
  // account's disk; it is never registered as a project of the account now signed in.
  it('does not register a clone for an account that switched away during it', async () => {
    const { checkouts, deps, disk } = setup();
    let current = true;
    const git = deps.git;
    deps.git = async (args, options) => { const result = await git(args, options); if (args.includes('clone')) current = false; return result; };
    await expect(checkouts.ensure(cindyRepo, { signIn: true, isCurrent: () => current })).rejects.toThrow('OWNER_CHANGED');
    expect(deps.register).not.toHaveBeenCalled();
    expect(disk.has(path.join(dir, '.git'))).toBe(true);
  });

  // The group's task already works in the (empty) folder while the clone runs: the clone moves in
  // beside it and the folder itself is never replaced under the task.
  it('clones into the folder the task already uses', async () => {
    const { checkouts, deps, disk } = setup();
    disk.add(dir);
    expect(await checkouts.ensure(cindyRepo, request)).toEqual({ status: 'ready', dir });
    expect(disk.has(path.join(dir, '.git')) && disk.has(path.join(dir, 'AGENTS.md'))).toBe(true);
    expect([...disk].some(entry => entry.includes('.cloning-'))).toBe(false);
    expect(deps.register).toHaveBeenCalledExactlyOnceWith(dir);
  });

  it.each([
    ['opens GitHub sign-in and clones once it is finished', true, true, { status: 'ready', dir }],
    ['says sign-in is needed when it is not finished in time', true, false, { status: 'sign-in-required', signInOpened: true }],
    ['never opens sign-in for a request that may not ask for it', false, false, { status: 'sign-in-required' }],
  ] as const)('not signed in: %s', async (_case, signIn, signInFinishes, result) => {
    // A private repository: the clone is refused until Cindy is signed in to GitHub.
    const { checkouts, deps, disk } = setup({ signedIn: false, signInFinishes, clone: signInFinishes ? 'ok' : 'denied' });
    expect(await checkouts.ensure(cindyRepo, { signIn, isCurrent: () => true })).toEqual(result);
    expect(deps.openSignIn).toHaveBeenCalledTimes(signIn ? 1 : 0);
    // Nothing fetched leaves no folder and no project behind.
    if (result.status !== 'ready') {
      expect([...disk].some(entry => entry === dir || entry.startsWith(dir + path.sep) || entry.includes('.cloning-'))).toBe(false);
      expect(deps.register).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['git is not installed', { git: false }, [] as string[], 'git-missing'],
    ['the repository cannot be fetched', { clone: 'denied' as const }, [], 'unavailable'],
    ['the folder already holds something else', {}, [path.join(dir, 'notes.txt')], 'unavailable'],
  ] as const)('leaves the group without a folder when %s', async (_case, options, existing, status) => {
    const { checkouts, deps, disk, calls } = setup(options);
    for (const entry of existing) { disk.add(dir); disk.add(entry); }
    expect(await checkouts.ensure(cindyRepo, request)).toEqual({ status });
    expect(deps.register).not.toHaveBeenCalled();
    if (existing.length) {
      expect(calls.some(args => args.includes('clone'))).toBe(false);
      expect(disk.has(existing[0]!)).toBe(true);
    }
  });

  it('refuses a name that is not a plain owner/name', () => {
    const { checkouts } = setup();
    expect(checkouts.ensure({ kind: 'github', repo: '../../etc' }, request)).toBeNull();
    expect(checkouts.ensure({ kind: 'github', repo: 'makecindy/cindy.git' }, request)).toBeNull();
  });

  // 2026-11-14 request: GitLab (a company's own too) and CNB. Cindy has no sign-in there: the clone
  // uses this computer's own git access, and a refusal says so instead of asking for GitHub.
  it.each([
    ['a company GitLab', { kind: 'git' as const, host: 'gitlab.example.com:8443', path: 'platform/tools/cindy' },
      'https://gitlab.example.com:8443/platform/tools/cindy.git', ['gitlab.example.com', 'platform', 'tools', 'cindy'], 'git@gitlab.example.com:platform/tools/cindy.git'],
    ['CNB', { kind: 'git' as const, host: 'cnb.cool', path: 'org/name' }, 'https://cnb.cool/org/name.git', ['cnb.cool', 'org', 'name'], 'https://cnb.cool/org/name'],
  ])('clones a repository on %s with this computer\'s own git access', async (_case, repository, url, parts, remote) => {
    const target = path.join(root, ...parts);
    const { checkouts, deps, calls } = setup({ signedIn: false, remote });
    expect(checkouts.dirOf(repository)).toBe(target);
    expect(await checkouts.ensure(repository, request)).toEqual({ status: 'ready', dir: target });
    const clone = calls.find(args => args.includes('clone'))!;
    expect(clone).toEqual(expect.arrayContaining([url]));
    expect(clone.join(' ')).not.toContain('credential');
    expect(deps.openSignIn).not.toHaveBeenCalled();
    expect(await checkouts.ensure(repository, request)).toEqual({ status: 'ready', dir: target });
    const denied = setup({ clone: 'denied' });
    expect(await denied.checkouts.ensure(repository, request)).toEqual({ status: 'access-required' });
    expect(denied.deps.openSignIn).not.toHaveBeenCalled();
  });
});

// 2026-11-13 field report: a request waited ~9 minutes while the repository was cloned and pulled,
// with no task to look at, although the user's own checkout (a fork, `upstream` = the group's
// repository) was registered. Finding the folder never waits on the network now. Unit: the real
// resolver over a temporary root; git and the clone are scripted.
describe('group work folder', () => {
  const repoRoom = { id: 'group-repo', name: 'Cindy', project: { kind: 'github' as const, repo: 'makecindy/cindy' } };
  const options = { signIn: true, isCurrent: () => true };

  // A fork's `upstream` is the repository the group shares; any git host counts, a plain path does not.
  it('names a folder\'s repositories with a fork\'s upstream first', () => {
    expect(folderRepositories([
      { name: 'origin', url: 'git@github.com:me/cindy.git' }, { name: 'mirror', url: 'https://gitlab.com/me/cindy.git' },
      { name: 'upstream', url: 'https://github.com/makecindy/cindy' }, { name: 'backup', url: 'https://github.com/MakeCindy/Cindy.git' },
    ])).toEqual([cindyRepo, { kind: 'github', repo: 'me/cindy' }, { kind: 'git', host: 'gitlab.com', path: 'me/cindy' }]);
    // A company GitLab over SSH and CNB name the same repository however their address is written.
    expect(folderRepositories([{ name: 'origin', url: 'ssh://git@gitlab.example.com:2222/Platform/tools/cindy.git' }, { name: 'cnb', url: 'git@cnb.cool:org/name.git' }]))
      .toEqual([{ kind: 'git', host: 'gitlab.example.com', path: 'Platform/tools/cindy' }, { kind: 'git', host: 'cnb.cool', path: 'org/name' }]);
    expect(folderRepositories([{ name: 'origin', url: '/srv/git/cindy.git' }])).toEqual([]);
  });

  it('uses the most recently used registered checkout, a fork included', async () => {
    const read = { isMainCheckout: async () => true,
      remotes: async (dir: string) => ({ '/work/fork': ['https://github.com/me/cindy.git', 'git@github.com:makecindy/cindy.git'],
        '/work/other': ['https://github.com/someone/else.git'], '/work/older': ['https://github.com/makecindy/cindy'] } as Record<string, string[]>)[dir] ?? [] };
    expect(await findRepositoryFolders(['/work/fork', '/work/other', '/work/older'], cindyRepo, read))
      .toEqual(['/work/fork', '/work/older'].map(dir => path.resolve(dir)));
    const ensure = vi.fn();
    const folders = createGroupProjectFolders({ chosen: () => null, findRegistered: async () => ['/work/fork', '/work/older'],
      checkouts: { ensure, sync: vi.fn(), isManaged: () => false, dirOf: () => '/managed/makecindy/cindy' },
      validate: async dir => ({ ok: true as const, dir }) });
    expect(await folders.forWork(repoRoom, options)).toEqual({ dir: '/work/fork', auto: true });
    expect(ensure).not.toHaveBeenCalled();
  });

  // A company GitLab's checkout cloned over SSH is found from the HTTPS link the group keeps.
  it('finds a checkout of a GitLab repository however its remote is written', async () => {
    const read = { isMainCheckout: async () => true,
      remotes: async (dir: string) => ({ '/work/gitlab': ['git@gitlab.example.com:platform/tools/cindy.git'],
        '/work/other': ['https://gitlab.example.com/platform/tools/other.git'] } as Record<string, string[]>)[dir] ?? [] };
    expect(await findRepositoryFolders(['/work/other', '/work/gitlab'], { kind: 'git', host: 'gitlab.example.com:8443', path: 'Platform/Tools/cindy' }, read))
      .toEqual([path.resolve('/work/gitlab')]);
  });

  // 2026-11-14 field report: the group's Cindy had fetched its own copy before the user's fork was
  // recognized; used more recently, the copy kept winning over the user's checkout.
  it('prefers the user\'s own checkout over Cindy\'s copy used more recently', async () => {
    const ensure = vi.fn();
    const managed = '/managed/github/makecindy/cindy';
    const folders = (dirs: string[]) => createGroupProjectFolders({ chosen: () => null, findRegistered: async () => dirs,
      checkouts: { ensure, sync: vi.fn(), isManaged: dir => dir === managed, dirOf: () => managed },
      validate: async dir => ({ ok: true as const, dir }) });
    expect(await folders([managed, '/work/fork']).forWork(repoRoom, options)).toEqual({ dir: '/work/fork', auto: true });
    expect(await folders([managed, '/work/fork']).shown(repoRoom)).toEqual({ dir: '/work/fork', auto: true });
    expect(ensure).not.toHaveBeenCalled();
  });

  it('opens Cindy\'s folder at once and fetches the repository in the background', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'group-managed-'));
    const dir = path.join(root, 'makecindy', 'cindy');
    try {
      let finish!: (result: { status: 'sign-in-required' }) => void;
      const ensure = vi.fn(() => new Promise<{ status: 'sign-in-required' }>(resolve => { finish = resolve; }));
      const sync = vi.fn(() => new Promise<void>(() => {}));
      const owner = vi.fn(() => true);
      const folders = createGroupProjectFolders({ chosen: () => null, findRegistered: async () => [], owner,
        checkouts: { ensure, sync, isManaged: () => true, dirOf: () => dir }, validate: async d => ({ ok: true as const, dir: d }) });
      // Nothing local yet: the folder is there right away and the clone has only started.
      expect(await folders.forWork(repoRoom, options)).toEqual({ dir, auto: true, pending: { status: 'preparing' } });
      expect((await stat(dir)).isDirectory()).toBe(true);
      expect(ensure).toHaveBeenCalledWith(cindyRepo, { signIn: true, isCurrent: owner });
      // A clone that failed is what the next request hears about, while it tries again.
      finish({ status: 'sign-in-required' });
      await Promise.resolve(); await Promise.resolve();
      expect((await folders.forWork(repoRoom, options)).pending).toEqual({ status: 'sign-in-required' });
      expect(ensure).toHaveBeenCalledTimes(2);
      // With the repository there, the request goes ahead while the update runs in the background.
      await mkdir(path.join(dir, '.git'));
      expect(await folders.forWork(repoRoom, options)).toEqual({ dir, auto: true });
      expect(sync).toHaveBeenCalledWith(dir);
      expect(await folders.shown(repoRoom)).toEqual({ dir, auto: true });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

// Unit, §7.5: resolve the real folder without creating it during settings reads.
// The old resolver returned null for groups without a repository.
it('creates one workspace folder on demand and retains its binding across a rename', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'group-folder-'));
  let bound: string | null = null;
  try {
    const folders = createGroupProjectFolders({ chosen: () => null, workspaceRoot: () => ({ directory: root, isCustomized: true }),
      fallback: () => bound, bindFallback: (_, dir) => { bound = dir; },
      validate: async dir => ({ ok: true as const, dir }) });
    const room = { id: 'group-1234', name: 'Team / work' };
    const shown = await folders.shown(room);
    await expect(stat(shown.dir!)).rejects.toThrow();
    const actual = await folders.forWork(room, { signIn: false, isCurrent: () => true });
    expect(actual.dir).toBe(shown.dir);
    expect((await stat(actual.dir!)).isDirectory()).toBe(true);
    expect((await folders.forWork({ ...room, name: 'Renamed' }, { signIn: false, isCurrent: () => true })).dir).toBe(actual.dir);
    const missing = createGroupProjectFolders({ chosen: () => '/missing/user-choice', workspaceRoot: () => ({ directory: root, isCustomized: true }), validate: async () => ({ ok: false as const }) });
    await expect(missing.forWork(room, { signIn: false, isCurrent: () => true })).rejects.toThrow('WORKDIR_UNAVAILABLE');
    await rm(root, { recursive: true });
    await expect(folders.forWork(room, { signIn: false, isCurrent: () => true })).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Unit: custom roots can be offline mounts. The production resolver must not
// recursively recreate them, while app-managed defaults may be initialized.
it.each([true, false])('preserves workspace root creation policy (custom=%s)', async isCustomized => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'group-mount-'));
  const root = path.join(parent, 'missing-root');
  const bindFallback = vi.fn();
  const room = { id: 'group-mount', name: 'Team' };
  try {
    const folders = createGroupProjectFolders({ chosen: () => null,
      workspaceRoot: () => ({ directory: root, isCustomized }), bindFallback,
      validate: async dir => ({ ok: true as const, dir }) });
    const shown = await folders.shown(room);
    if (isCustomized) {
      await expect(folders.forWork(room, { signIn: false, isCurrent: () => true })).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(bindFallback).not.toHaveBeenCalled();
      await mkdir(root);
    }
    const result = await folders.forWork(room, { signIn: false, isCurrent: () => true });
    expect(result.dir).toBe(shown.dir);
    expect((await stat(result.dir!)).isDirectory()).toBe(true);
    expect(bindFallback).toHaveBeenCalledOnce();
  } finally { await rm(parent, { recursive: true, force: true }); }
});
