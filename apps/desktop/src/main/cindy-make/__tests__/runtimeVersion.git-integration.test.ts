import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { resolveMakeRuntime, type RuntimeGit } from '../runtimeVersion';

it('uses real ancestry for a running Dev build, including unmerged heads, branches and reverts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-runtime-source-'));
  const signal = new AbortController().signal;
  const environment = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: root,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Runtime Test',
    GIT_AUTHOR_EMAIL: 'runtime@example.invalid',
    GIT_COMMITTER_NAME: 'Runtime Test',
    GIT_COMMITTER_EMAIL: 'runtime@example.invalid',
  };
  const git: RuntimeGit = (cwd, args, abortSignal) =>
    new Promise((resolve) => {
      execFile(
        'git',
        args,
        { cwd, env: environment, signal: abortSignal, encoding: 'utf8', windowsHide: true },
        (error, stdout) => {
          resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout });
        },
      );
    });
  const run = async (args: string[]) => {
    const result = await git(root, args, signal);
    expect(result.code).toBe(0);
    return result.stdout.trim();
  };
  const snapshot = (commit: string) =>
    resolveMakeRuntime(
      { packaged: false, version: '0.0.0' },
      signal,
      { commit, dirty: false, root },
      git,
    );
  try {
    await run(['init', '--initial-branch=main']);
    await run(['commit', '--allow-empty', '--no-gpg-sign', '-m', 'base']);
    const base = await run(['rev-parse', 'HEAD']);
    await run(['checkout', '-b', 'feature']);
    await writeFile(path.join(root, 'feature.txt'), 'feature\n');
    await run(['add', 'feature.txt']);
    await run(['commit', '--no-gpg-sign', '-m', 'feature']);
    const feature = await run(['rev-parse', 'HEAD']);
    const personal = await snapshot(feature);
    expect(await personal.containsCommit(feature)).toBe('included');
    expect(await personal.containsCommit(base)).toBe('included');
    await run(['checkout', 'main']);
    expect(await personal.isCurrent()).toBe(false);
    expect(await personal.containsCommit(feature)).toBe('unknown');
    const previous = await snapshot(base);
    expect(await previous.containsCommit(feature)).toBe('notIncluded');
    await run(['commit', '--allow-empty', '--no-gpg-sign', '-m', 'main changes']);
    const divergent = await snapshot(await run(['rev-parse', 'HEAD']));
    expect(await divergent.containsCommit(feature)).toBe('unknown');
    await run(['merge', '--no-edit', '--no-gpg-sign', 'feature']);
    const merged = await snapshot(await run(['rev-parse', 'HEAD']));
    expect(await merged.containsCommit(feature)).toBe('included');
    await run(['revert', '--no-edit', '--no-gpg-sign', feature]);
    const reverted = await snapshot(await run(['rev-parse', 'HEAD']));
    expect(await reverted.containsCommit(feature)).toBe('unknown');
    await writeFile(path.join(root, 'uncommitted.txt'), 'local override');
    expect(await reverted.isCurrent()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30_000);
