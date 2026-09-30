import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { runSourceGit } from '../sourceGit.js';
import { readSourceRevisions } from '../sourceRevisions.js';
import type { MakeToolchainEnvironment } from '../toolchainEnvironment.js';

it('reads real Git ancestry and divergence without moving personal or main branches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-source-revisions-'));
  const processEnvironment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: root,
    GIT_CONFIG_GLOBAL: path.join(root, '.git', 'empty.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Source Test',
    GIT_AUTHOR_EMAIL: 'source-test@example.invalid',
    GIT_COMMITTER_NAME: 'Source Test',
    GIT_COMMITTER_EMAIL: 'source-test@example.invalid',
  };
  const env = { processEnvironment: () => processEnvironment } as MakeToolchainEnvironment;
  const signal = new AbortController().signal;
  const git = (args: string[]) => runSourceGit(processEnvironment, args, root, signal);
  const commit = async (message: string) => {
    await git(['commit', '--allow-empty', '--no-gpg-sign', '-m', message]);
    return git(['rev-parse', 'HEAD']);
  };
  try {
    await git(['init', '--initial-branch=main']);
    await writeFile(processEnvironment.GIT_CONFIG_GLOBAL!, '');
    const base = await commit('base');
    await git(['checkout', '-b', 'cindy-personal']);
    const personal = await commit('personal');
    await git(['checkout', 'main']);
    await commit('upstream one');
    const remote = await commit('upstream two');
    await git(['update-ref', 'refs/remotes/origin/main', remote]);
    await git(['checkout', 'cindy-personal']);
    await git(['branch', '--force', 'main', base]);
    const read = () => readSourceRevisions(env, root, personal, remote, signal);
    await expect(read()).resolves.toEqual({
      baseCommit: base,
      currentBranch: 'cindy-personal',
      mainCommit: base,
      mainRemoteCommit: remote,
      mainAhead: 0,
      mainBehind: 2,
      personalAhead: 1,
      personalBehind: 0,
    });
    await git(['checkout', 'main']);
    const local = await commit('local main only');
    await expect(read()).resolves.toMatchObject({ currentBranch: 'main' });
    await git(['checkout', 'cindy-personal']);
    await expect(read()).resolves.toMatchObject({
      baseCommit: base,
      mainCommit: local,
      mainRemoteCommit: remote,
      mainAhead: 1,
      mainBehind: 2,
      personalAhead: 1,
      personalBehind: 1,
    });
    expect(await git(['rev-parse', 'HEAD'])).toBe(personal);
    expect(await git(['rev-parse', 'main'])).toBe(local);
    await git(['checkout', '--detach', personal]);
    await expect(read()).resolves.toMatchObject({ currentBranch: null });
    await git(['checkout', 'cindy-personal']);
    await git(['branch', '--delete', '--force', 'main']);
    const withoutMain = await read();
    expect(withoutMain.baseCommit).toBe(base);
    expect(withoutMain.mainCommit).toBeUndefined();
    expect(withoutMain.mainBehind).toBeUndefined();
    await git(['branch', 'main', remote]);
    await expect(read()).resolves.toMatchObject({ mainAhead: 0, mainBehind: 0 });
    await git(['merge', '--no-edit', '--no-gpg-sign', 'main']);
    const updatedPersonal = await git(['rev-parse', 'HEAD']);
    await expect(
      readSourceRevisions(env, root, updatedPersonal, remote, signal),
    ).resolves.toMatchObject({
      baseCommit: remote,
    });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);
