import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createGroupProjectCheckouts, type GitResult, type GroupCheckoutDeps } from '../groupProjectCheckout.js';

/**
 * bot-group-chat.md §7.5: a group's repository that is not a registered project is fetched by Cindy
 * itself. Unit: the real module over a fake disk and a scripted git; no process is started.
 */
const root = path.resolve('/cindy/projects/github');
const dir = path.join(root, 'makecindy', 'cindy');
const ok: GitResult = { exitCode: 0, stdout: '', stderr: '' };

function setup(options: { signedIn?: boolean; clone?: 'ok' | 'denied'; git?: boolean; signInFinishes?: boolean } = {}) {
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
      if (args[0] === 'remote') return { ...ok, stdout: 'https://github.com/makecindy/cindy.git\n' };
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
    expect(await checkouts.ensure('makecindy/cindy', request)).toEqual({ status: 'ready', dir });
    const clone = calls.find(args => args.includes('clone'))!;
    expect(clone).toEqual(expect.arrayContaining(['--depth', '1', 'https://github.com/makecindy/cindy.git']));
    expect(clone.join(' ')).toContain("credential.https://github.com.helper=!'/opt/bin/gh' auth git-credential");
    expect(disk.has(path.join(dir, 'AGENTS.md'))).toBe(true);
    expect(deps.register).toHaveBeenCalledExactlyOnceWith(dir);
    // The next request finds it there and fetches nothing again.
    expect(await checkouts.ensure('makecindy/cindy', request)).toEqual({ status: 'ready', dir });
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
    await expect(checkouts.ensure('makecindy/cindy', { signIn: true, isCurrent: () => current })).rejects.toThrow('OWNER_CHANGED');
    expect(deps.register).not.toHaveBeenCalled();
    expect(disk.has(path.join(dir, '.git'))).toBe(true);
  });

  it.each([
    ['opens GitHub sign-in and clones once it is finished', true, true, { status: 'ready', dir }],
    ['says sign-in is needed when it is not finished in time', true, false, { status: 'sign-in-required', signInOpened: true }],
    ['never opens sign-in for a request that may not ask for it', false, false, { status: 'sign-in-required' }],
  ] as const)('not signed in: %s', async (_case, signIn, signInFinishes, result) => {
    // A private repository: the clone is refused until Cindy is signed in to GitHub.
    const { checkouts, deps, disk } = setup({ signedIn: false, signInFinishes, clone: signInFinishes ? 'ok' : 'denied' });
    expect(await checkouts.ensure('makecindy/cindy', { signIn, isCurrent: () => true })).toEqual(result);
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
    expect(await checkouts.ensure('makecindy/cindy', request)).toEqual({ status });
    expect(deps.register).not.toHaveBeenCalled();
    if (existing.length) {
      expect(calls.some(args => args.includes('clone'))).toBe(false);
      expect(disk.has(existing[0]!)).toBe(true);
    }
  });

  it('refuses a name that is not a plain owner/name', () => {
    const { checkouts } = setup();
    expect(checkouts.ensure('../../etc', request)).toBeNull();
    expect(checkouts.ensure('makecindy/cindy.git', request)).toBeNull();
  });
});
