import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, expect, it } from 'vitest';

import { createBotGroupWorkDir } from '../botGroupWorkDir.js';

const exec = promisify(execFile);
let cleanupRepo: string | undefined;

afterEach(async () => {
  if (cleanupRepo) await rm(cleanupRepo, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

// bot-group-chat §7.4: committed step output must survive a clean Git status.
// Keep the real Git contract in its resource tier; unit covers the merge with
// injected Git output. This fixture needs a separate lifecycle from unit tests.
it('counts files a step committed on the plan branch as well as uncommitted ones', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'bot-group-workdir-git-'));
  cleanupRepo = repo;
  const git = async (args: readonly string[], cwd: string) => {
    const { stdout } = await exec('git', [...args], {
      cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull,
        GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });
    return stdout;
  };
  const run = (...args: string[]) => git(args, repo);
  await run('init', '-q', '-b', 'main', '--template=');
  await writeFile(path.join(repo, 'README.md'), 'a');
  await run('add', '.');
  await run('commit', '-q', '-m', 'init');
  const workDir = createBotGroupWorkDir({
    ownerRoot: () => repo,
    detectRepo: async () => ({ gitInstalled: true, isGitRepo: true }),
    prepareWorktree: async () => { throw new Error('not used'); },
    git,
    trashItem: async () => undefined,
  });
  const before = await workDir.snapshot(repo);
  await writeFile(path.join(repo, 'README.md'), 'a\nb');
  await writeFile(path.join(repo, 'hello.html'), '<p>hi</p>');
  await run('add', '.');
  await run('commit', '-q', '-m', 'step');
  await writeFile(path.join(repo, 'notes.md'), 'draft');
  expect((await workDir.changedFiles(repo, before)).sort()).toEqual(['README.md', 'hello.html', 'notes.md']);
});
