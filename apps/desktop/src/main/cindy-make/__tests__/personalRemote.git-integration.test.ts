import os from 'node:os';
import path from 'node:path';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  PersonalRemoteController,
  personalGitEnv,
  type PersonalRemoteGitOptions,
  type PersonalRemoteRecord,
} from '../personalRemote';
import { makeSourceCheckoutPath } from '../sourcePaths';
import { runSourceGit } from '../sourceGit';

const FORK_URL = 'https://github.com/octo/cindy.git';
const TOKEN = 'gho_fake-token-for-tests';

/** Official repository, the user's fork (a bare clone) and the managed personal checkout. */
async function fixture() {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'cindy-personal-remote-'));
  const source = makeSourceCheckoutPath(userData);
  const official = path.join(userData, 'official');
  const fork = path.join(userData, 'fork.git');
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_GLOBAL: path.join(userData, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const raw = (args: string[], cwd: string, extra: NodeJS.ProcessEnv = {}) =>
    runSourceGit({ ...env, ...extra }, args, cwd, AbortSignal.timeout(30_000));
  // The controller only knows GitHub URLs; route them to the local bare fork.
  const git = async (args: string[], cwd: string, options?: PersonalRemoteGitOptions) => {
    const output = await runSourceGit(
      personalGitEnv(env, options),
      args.map((arg) => (arg === FORK_URL ? fork : arg)),
      cwd,
      AbortSignal.timeout(30_000),
    );
    return output === fork ? FORK_URL : output;
  };
  const commit = async (cwd: string, message: string) => {
    await raw(['add', '.'], cwd);
    await raw(
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgSign=false',
        'commit',
        '-s',
        '-m',
        message,
      ],
      cwd,
    );
  };
  await writeFile(env.GIT_CONFIG_GLOBAL, '');
  await mkdir(official);
  await mkdir(path.dirname(source), { recursive: true });
  await raw(['init', '--initial-branch=main'], official);
  await writeFile(path.join(official, 'app.txt'), 'official\n');
  await commit(official, 'official base');
  await raw(['clone', '--bare', official, fork], userData);
  await raw(['clone', official, source], userData);
  await raw(['checkout', '-b', 'cindy-personal'], source);
  await writeFile(path.join(source, 'personal.txt'), 'first change\n');
  await commit(source, 'personal change');

  let record: PersonalRemoteRecord = { schema: 1 };
  const controller = new PersonalRemoteController({
    source,
    read: () => structuredClone(record),
    write: (next) => {
      record = structuredClone(next);
    },
    identity: async () => ({ status: 'connected', identity: { login: 'octo', token: TOKEN } }),
    ensureFork: async () => 'octo/cindy',
    git,
    sourceExists: () => existsSync(path.join(source, '.git')),
    withProject: (run) => run(),
    withSourceUse: (run) => run(),
    hasUnbuiltChanges: async () => false,
    findPersonalFork: async () => undefined,
    isBuilt: () => false,
    sourceSettled: () => true,
    // The official commit the personal branch was created from, as Settings reports it.
    officialBase: async () =>
      (
        await raw(['merge-base', 'refs/heads/cindy-personal', 'refs/remotes/origin/main'], source)
      ).trim(),
    sourceChanged: () => {},
    publish: () => {},
    sleep: async () => {},
    now: () => Date.now(),
  });
  const tip = (cwd: string, ref = 'refs/heads/cindy-personal') =>
    raw(['rev-parse', '--verify', ref], cwd).then((value) => value.trim());
  return {
    userData,
    source,
    fork,
    official,
    git,
    raw,
    commit,
    controller,
    tip,
    record: () => record,
    clean: () => rm(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}

it('uploads, fast-forwards and never overwrites a fork that another computer advanced', async () => {
  const h = await fixture();
  try {
    h.controller.save();
    await h.controller.settled();
    expect(h.record()).toMatchObject({ repository: 'octo/cindy', sync: 'synced' });
    expect(await h.tip(h.fork)).toBe(await h.tip(h.source));
    // The official base is published next to it for other computers.
    expect(await h.tip(h.fork, 'refs/heads/cindy-personal-base')).toBe(
      await h.tip(h.source, 'refs/remotes/origin/main'),
    );
    expect(await h.tip(h.source, 'refs/remotes/personal/cindy-personal')).toBe(
      await h.tip(h.source),
    );
    // The remote URL carries no credential and the local config holds no token.
    expect((await h.raw(['config', '--get', 'remote.personal.url'], h.source)).trim()).toBe(h.fork);
    expect(await h.raw(['config', '--list', '--local'], h.source)).not.toContain(TOKEN);

    await writeFile(path.join(h.source, 'personal.txt'), 'second change\n');
    await h.commit(h.source, 'second personal change');
    h.controller.sync();
    await h.controller.settled();
    expect(h.record().sync).toBe('synced');
    expect(await h.tip(h.fork)).toBe(await h.tip(h.source));

    // Another computer pushes a newer personal version to the same fork.
    const other = path.join(h.userData, 'other');
    await h.raw(['clone', '--branch', 'cindy-personal', h.fork, other], h.userData);
    await writeFile(path.join(other, 'other.txt'), 'from another computer\n');
    await h.commit(other, 'another computer');
    await h.raw(['push', 'origin', 'cindy-personal'], other);
    const remote = await h.tip(h.fork);
    const local = await h.tip(h.source);
    h.controller.sync();
    await h.controller.settled();
    // This computer's changes are all in the newer upload: retrieve it, never overwrite it.
    expect(h.record()).toMatchObject({ sync: 'retrieved', syncedCommit: remote });
    expect(await h.tip(h.fork)).toBe(remote);
    expect(await h.tip(h.source)).toBe(remote);
    expect(await h.tip(h.source, `refs/cindy-make/backups/personal-remote-local/${local}`)).toBe(
      local,
    );
    expect(await h.tip(h.source, 'refs/cindy-make/personal-upstream')).toBe(
      await h.tip(h.fork, 'refs/heads/cindy-personal-base'),
    );
  } finally {
    await h.clean();
  }
}, 60_000);

it('commits legacy uncommitted personal files before uploading and can disconnect', async () => {
  const h = await fixture();
  try {
    await writeFile(path.join(h.source, 'legacy.txt'), 'kept work\n');
    h.controller.save();
    await h.controller.settled();
    expect(h.record()).toMatchObject({ sync: 'synced' });
    expect((await h.raw(['status', '--porcelain'], h.source)).trim()).toBe('');
    expect((await h.raw(['log', '-1', '--format=%s'], h.source)).trim()).toBe(
      'Cindy Make: preserve personal changes',
    );
    expect((await h.raw(['show', 'refs/heads/cindy-personal:legacy.txt'], h.fork)).trim()).toBe(
      'kept work',
    );

    await h.controller.disconnect();
    expect(h.record()).toEqual({ schema: 1, choice: 'local' });
    await expect(h.raw(['config', '--get', 'remote.personal.url'], h.source)).rejects.toMatchObject(
      {
        exitCode: 1,
      },
    );
    // The fork itself is untouched.
    expect(await h.tip(h.fork)).toBe(await h.tip(h.source));
  } finally {
    await h.clean();
  }
}, 60_000);

it('replaces its own upload after an official update rewrote the history, without running hooks', async () => {
  const h = await fixture();
  try {
    h.controller.save();
    await h.controller.settled();
    const uploaded = await h.tip(h.fork);

    // A repository hook that records the environment it sees whenever Git runs it.
    const marker = path.join(h.userData, 'hook-env');
    const hook = path.join(h.source, '.git', 'hooks', 'reference-transaction');
    await writeFile(hook, `#!/bin/sh\nenv >> "${marker.split(path.sep).join('/')}"\n`);
    await chmod(hook, 0o755);
    await h.raw(['update-ref', 'refs/cindy-make/hook-probe', 'HEAD'], h.source);
    const hooksWork = existsSync(marker);
    await rm(marker, { force: true });

    // Official update: the personal commit is replayed onto a newer official base.
    const official = path.join(h.userData, 'official');
    await writeFile(path.join(official, 'app.txt'), 'official update\n');
    await h.commit(official, 'official update');
    await h.raw(['fetch', official, '+main:refs/remotes/origin/main'], h.source);
    await h.raw(
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'core.hooksPath=' + path.join(h.userData, 'no-hooks'),
        'rebase',
        '--onto',
        'refs/remotes/origin/main',
        'HEAD~1',
      ],
      h.source,
    );
    const rebased = await h.tip(h.source);
    expect(rebased).not.toBe(uploaded);

    h.controller.sync();
    await h.controller.settled();
    expect(h.record()).toMatchObject({ sync: 'synced', syncedCommit: rebased });
    expect(await h.tip(h.fork)).toBe(rebased);
    expect(await h.tip(h.source, `refs/cindy-make/backups/personal-remote/${uploaded}`)).toBe(
      uploaded,
    );
    // Local ref updates may run hooks; commands that carry the credential never do.
    expect(hooksWork).toBe(true);
    const seen = existsSync(marker) ? await readFile(marker, 'utf8') : '';
    expect(seen).not.toContain('extraheader');
    expect(seen).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString('base64'));
  } finally {
    await h.clean();
  }
}, 60_000);

it('replaces its own upload that contained a feature integration merge after an official update', async () => {
  const h = await fixture();
  const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid'];
  try {
    // A completed task is integrated into the personal version as a real --no-ff merge.
    const base = await h.tip(h.source);
    await h.raw(['checkout', '-b', 'cindy-make/task'], h.source);
    await writeFile(path.join(h.source, 'feature.txt'), 'task change\n');
    await h.commit(h.source, 'task change');
    await h.raw(['checkout', 'cindy-personal'], h.source);
    await h.raw(
      [...identity, 'merge', '--no-ff', '-m', 'integrate task', 'cindy-make/task'],
      h.source,
    );
    h.controller.save();
    await h.controller.settled();
    const uploaded = await h.tip(h.fork);
    expect(h.record()).toMatchObject({ sync: 'synced', syncedCommit: uploaded });

    // The official update replays personal commits linearly; the merge commit disappears.
    const official = path.join(h.userData, 'official');
    await writeFile(path.join(official, 'app.txt'), 'official update\n');
    await h.commit(official, 'official update');
    await h.raw(['fetch', official, '+main:refs/remotes/origin/main'], h.source);
    const officialBase = (await h.raw(['rev-parse', `${base}~1`], h.source)).trim();
    await h.raw(
      [
        ...identity,
        '-c',
        'core.hooksPath=' + path.join(h.userData, 'no-hooks'),
        'rebase',
        '--onto',
        'refs/remotes/origin/main',
        officialBase,
        'cindy-personal',
      ],
      h.source,
    );
    const rebased = await h.tip(h.source);
    expect(
      (await h.raw(['rev-list', '--merges', `${officialBase}..${rebased}`], h.source)).trim(),
    ).toBe('');

    h.controller.sync();
    await h.controller.settled();
    expect(h.record()).toMatchObject({ sync: 'synced', syncedCommit: rebased });
    expect(await h.tip(h.fork)).toBe(rebased);
  } finally {
    await h.clean();
  }
}, 60_000);

it('starts a new computer from the personal version another computer saved', async () => {
  const h = await fixture();
  try {
    h.controller.save();
    await h.controller.settled();
    const saved = await h.tip(h.fork);

    // A second computer prepares a fresh official checkout and connects the same account.
    const otherData = path.join(h.userData, 'second-computer');
    const otherSource = makeSourceCheckoutPath(otherData);
    await mkdir(path.dirname(otherSource), { recursive: true });
    await h.raw(['clone', h.official, otherSource], h.userData);
    await h.raw(['checkout', '-b', 'cindy-personal'], otherSource);
    let record: PersonalRemoteRecord = { schema: 1 };
    const second = new PersonalRemoteController({
      source: otherSource,
      read: () => structuredClone(record),
      write: (next) => {
        record = structuredClone(next);
      },
      identity: async () => ({ status: 'connected', identity: { login: 'octo', token: TOKEN } }),
      ensureFork: async () => 'octo/cindy',
      findPersonalFork: async () => 'octo/cindy',
      git: h.git,
      sourceExists: () => existsSync(path.join(otherSource, '.git')),
      withProject: (run) => run(),
      withSourceUse: (run) => run(),
      hasUnbuiltChanges: async () => false,
      isBuilt: () => false,
      sourceSettled: () => true,
      officialBase: async () => h.tip(otherSource, 'refs/remotes/origin/main'),
      sourceChanged: () => {},
      publish: () => {},
      sleep: async () => {},
      now: () => Date.now(),
    });
    expect((await second.refresh()).existingPersonal).toBe('octo/cindy');
    second.save();
    await second.settled();
    expect(record).toMatchObject({
      repository: 'octo/cindy',
      sync: 'retrieved',
      syncedCommit: saved,
    });
    expect(await h.tip(otherSource)).toBe(saved);
    expect((await readFile(path.join(otherSource, 'personal.txt'), 'utf8')).trim()).toBe(
      'first change',
    );
    expect(await h.tip(h.fork)).toBe(saved);
  } finally {
    await h.clean();
  }
}, 60_000);

it('combines new changes from two computers and keeps a conflicting pair untouched', async () => {
  const h = await fixture();
  try {
    h.controller.save();
    await h.controller.settled();
    const other = path.join(h.userData, 'other');
    await h.raw(['clone', '--branch', 'cindy-personal', h.fork, other], h.userData);

    // Each computer adds a different change on the same official base.
    await writeFile(path.join(other, 'other.txt'), 'from another computer\n');
    await h.commit(other, 'another computer');
    await h.raw(['push', 'origin', 'cindy-personal'], other);
    const remote = await h.tip(h.fork);
    await writeFile(path.join(h.source, 'mine.txt'), 'from this computer\n');
    await h.commit(h.source, 'this computer');
    const local = await h.tip(h.source);

    h.controller.sync();
    await h.controller.settled();
    const combined = await h.tip(h.source);
    expect(h.record()).toMatchObject({ sync: 'retrieved', syncedCommit: combined });
    expect(await h.tip(h.fork)).toBe(combined);
    // The combined version builds on the fork's version and keeps both changes and the author.
    expect((await h.raw(['rev-parse', `${combined}^`], h.source)).trim()).toBe(remote);
    expect((await h.raw(['show', `${combined}:other.txt`], h.source)).trim()).toBe(
      'from another computer',
    );
    expect((await h.raw(['show', `${combined}:mine.txt`], h.source)).trim()).toBe(
      'from this computer',
    );
    expect((await h.raw(['log', '-1', '--format=%an <%ae>%n%B', combined], h.source)).trim()).toBe(
      'Test <test@example.invalid>\nthis computer\n\nSigned-off-by: Test <test@example.invalid>',
    );
    expect((await h.raw(['status', '--porcelain'], h.source)).trim()).toBe('');
    expect(await h.tip(h.source, `refs/cindy-make/backups/personal-remote-local/${local}`)).toBe(
      local,
    );

    // Both computers now edit the same line: nothing moves and both sides are reported.
    await h.raw(['pull', '--ff-only', 'origin', 'cindy-personal'], other);
    await writeFile(path.join(other, 'personal.txt'), 'edited over there\n');
    await h.commit(other, 'conflicting change over there');
    await h.raw(['push', 'origin', 'cindy-personal'], other);
    const theirs = await h.tip(h.fork);
    await writeFile(path.join(h.source, 'personal.txt'), 'edited here\n');
    await h.commit(h.source, 'conflicting change here');
    const ours = await h.tip(h.source);
    h.controller.sync();
    await h.controller.settled();
    // Overlapping edits wait for the user to start a combine; nothing is chosen for them.
    expect(h.record().sync).toBe('needsMerge');
    expect(await h.tip(h.source)).toBe(ours);
    expect(await h.tip(h.fork)).toBe(theirs);
    expect((await readFile(path.join(h.source, 'personal.txt'), 'utf8')).trim()).toBe(
      'edited here',
    );
  } finally {
    await h.clean();
  }
}, 60_000);
