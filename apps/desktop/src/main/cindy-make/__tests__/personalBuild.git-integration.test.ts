import { createHash, randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { brandExecutableName } from '@cindy/maker-shared/brand-identity';
import {
  personalVersionId,
  readPersonalVersion,
  runnableBundlePaths,
  versionDirectory,
} from '../versionStore';
import {
  buildCindyPersonal,
  personalArtifactPath,
  type runPersonalPackageCommand,
} from '../personalBuild';
import { makeSourceCheckoutPath, makeTaskBranch, makeTaskWorktreePath } from '../sourcePaths';
import { manageCindyMakeWorkspace } from '../taskCleanup';
import { collectCindyMakeChanges } from '../completion';
import { createCindyMakeWorktree } from '../taskWorkspace';
import { runSourceGit } from '../sourceGit';
import type { runSourcePnpm } from '../sourcePnpm';

async function fixture() {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'cindy-personal-git-'));
  const source = makeSourceCheckoutPath(userData);
  const workingDir = makeTaskWorktreePath(userData, 'run');
  const signal = AbortSignal.timeout(90_000);
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_GLOBAL: path.join(userData, 'empty.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (args: string[], cwd = source, indexFile?: string) =>
    runSourceGit(
      { ...env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) },
      args,
      cwd,
      signal,
    );
  try {
    await writeFile(env.GIT_CONFIG_GLOBAL, '');
    await mkdir(path.join(source, 'scripts'), { recursive: true });
    await git(['init', '--initial-branch=cindy-personal']);
    await git(['config', 'user.name', 'Test']);
    await git(['config', 'user.email', 'test@example.invalid']);
    await git(['config', 'commit.gpgSign', 'false']);
    await writeFile(path.join(source, 'scripts/desktop-restart-runner.mjs'), '// fixture');
    await writeFile(path.join(source, 'shared.txt'), 'base');
    await writeFile(path.join(source, '.gitignore'), 'apps/desktop/release/\n');
    await git(['add', '.']);
    await git(['commit', '-s', '-m', 'base']);
    // A tag checkout has origin/main but no local main branch.
    await git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await createCindyMakeWorktree(userData, 'run', signal, { processEnvironment: env });
    await writeFile(path.join(workingDir, 'feature.txt'), 'task change');

    await writeFile(path.join(source, 'personal.txt'), 'existing personal change');

    const facts = await collectCindyMakeChanges(git, userData, workingDir);
    const task = {
      userData,
      workingDir,
      runId: 'run',
      completionId: 'completion',
      commit: facts.commit!,
      tree: facts.tree,
    };
    const history = await git(['rev-list', '--all', '--count']);
    const pnpm = vi.fn<typeof runSourcePnpm>(async (_env, _args, cwd) => {
      expect(cwd).toBe(source);
      expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).toBe('cindy-personal');
      // The task commit is merged into personal before the first build command.
      expect(await readFile(path.join(cwd, 'feature.txt'), 'utf8')).toBe('task change');
      expect(await readFile(path.join(cwd, 'personal.txt'), 'utf8')).toBe(
        'existing personal change',
      );
    });
    const pack = async (_node: string, args: string[], cwd: string) => {
      expect(cwd).toBe(source);
      expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).toBe('cindy-personal');
      expect(args).not.toContain('--skip-smoke');
      expect(args).not.toContain('--version');
      const candidate = await git(['rev-parse', 'HEAD'], cwd);
      expect(candidate).toBe(await git(['rev-parse', 'HEAD']));
      const artifacts = path.join(
        cwd,
        'apps/desktop/release/artifacts/global/unversioned',
        process.platform + '-' + process.arch,
      );
      await mkdir(artifacts, { recursive: true });
      await writeFile(path.join(artifacts, 'Cindy.exe'), 'installer');
      await writeFile(
        path.join(artifacts, 'build-info.json'),
        JSON.stringify({
          product: 'cindy-desktop',
          versionless: true,
          version: null,
          commitSha: candidate,
          region: 'global',
          platform: process.platform,
          arch: process.arch,
          files: [
            {
              role: 'installer',
              name: 'Cindy.exe',
              sha256: createHash('sha256').update('installer').digest('hex'),
            },
          ],
        }),
      );
    };
    const packageCommand = vi.fn<typeof runPersonalPackageCommand>(pack);
    const run = (buildSignal = signal) =>
      buildCindyPersonal(
        task,
        process.execPath,
        env,
        'global',
        buildSignal,
        async () => {},
        () => {},
        async (operation) => operation(),
        { pnpm, packageCommand },
      );
    return {
      userData,
      source,
      workingDir,
      task,
      git,
      pnpm,
      pack,
      packageCommand,
      run,
      history,
      env,
      signal,
    };
  } catch (error) {
    await rm(userData, { recursive: true, force: true });
    throw error;
  }
}

it('rolls back failed generations, preserves concurrent edits and keeps successful retries idempotent', async () => {
  const h = await fixture();
  try {
    const baseline = await h.git(['rev-parse', 'HEAD']);
    h.pnpm.mockRejectedValueOnce(new Error('checks failed'));
    await expect(h.run()).rejects.toMatchObject({ code: 'checksFailed' });
    const personalCommit = await h.git(['rev-parse', 'HEAD']);
    // Existing uncommitted personal edits are saved before integrating the task.
    expect(personalCommit).not.toBe(baseline);
    expect(await h.git(['show', 'HEAD:personal.txt'])).toBe('existing personal change');
    await expect(
      h.git(['merge-base', '--is-ancestor', h.task.commit, personalCommit]),
    ).rejects.toThrow();
    await expect(access(path.join(h.source, 'feature.txt'))).rejects.toThrow();
    expect(await readFile(path.join(h.workingDir, 'feature.txt'), 'utf8')).toBe('task change');
    expect(
      await h.git(['for-each-ref', '--format=%(refname)', 'refs/cindy-make/tasks/run/integrated']),
    ).toBe('');
    const failedCommit = (
      await h.git(['for-each-ref', '--format=%(objectname)', 'refs/cindy-make/failed-builds/'])
    ).split('\n')[0];
    expect(await h.git(['show', failedCommit + ':feature.txt'])).toBe('task change');
    h.packageCommand.mockRejectedValueOnce(new Error('packaging failed'));
    await expect(h.run()).rejects.toThrow('packaging failed');
    expect(await h.git(['rev-parse', 'HEAD'])).toBe(personalCommit);
    await expect(access(path.join(h.source, 'feature.txt'))).rejects.toThrow();
    h.packageCommand.mockImplementationOnce(async (...args) => {
      await h.pack(args[0], args[1], args[2]);
      await writeFile(path.join(h.source, 'concurrent.txt'), 'another completed personal change');
    });
    await expect(h.run()).rejects.toMatchObject({ code: 'cleanupFailed' });
    expect(await readFile(path.join(h.source, 'concurrent.txt'), 'utf8')).toBe(
      'another completed personal change',
    );
    expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe('task change');
    const artifact = await h.run();
    expect(await h.git(['rev-parse', 'HEAD'])).toBe(artifact.commit);
    const adoptedHistory = await h.git(['rev-list', '--all', '--count']);
    expect(Number(adoptedHistory)).toBeGreaterThan(Number(h.history));
    expect(await h.git(['status', '--porcelain'])).toBe('');
    expect(await h.git(['status', '--porcelain'], h.workingDir)).toBe('');
    expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe('task change');
    expect(
      await readFile(await personalArtifactPath(h.userData, 'completion', artifact), 'utf8'),
    ).toBe('installer');
    expect(await h.git(['rev-parse', 'HEAD'], h.workingDir)).toBe(h.task.commit);
    expect(await readFile(path.join(h.workingDir, 'feature.txt'), 'utf8')).toBe('task change');
    const worktrees = await h.git(['worktree', 'list', '--porcelain']);
    expect(worktrees.match(/^worktree /gm)).toHaveLength(2);
    expect(worktrees).not.toContain('cindy-make-merge-');
    await expect(
      manageCindyMakeWorkspace(h.userData, 'run', 'inspect', h.env, h.signal),
    ).resolves.toBe(true);
    await expect(
      manageCindyMakeWorkspace(h.userData, 'run', 'archive', h.env, h.signal),
    ).resolves.toBe(false);
    await expect(access(h.workingDir)).resolves.toBeUndefined();
    // A second generation is idempotent, and future tasks inherit committed personal features.
    await h.run();
    // A crash after applying files but before writing the receipt is also recoverable.
    await h.git(['update-ref', '-d', 'refs/cindy-make/tasks/run/integrated']);
    await h.run();
    const next = await createCindyMakeWorktree(h.userData, 'next', h.signal, {
      processEnvironment: h.env,
    });
    expect(await readFile(path.join(next.path, 'feature.txt'), 'utf8')).toBe('task change');
    expect(await readFile(path.join(next.path, 'personal.txt'), 'utf8')).toBe(
      'existing personal change',
    );
    expect(await h.git(['rev-list', '--all', '--count'])).toBe(adoptedHistory);
    // Continuing the same task integrates only its new file changes.
    await writeFile(path.join(h.workingDir, 'feature.txt'), 'task change continued');
    await expect(
      manageCindyMakeWorkspace(h.userData, 'run', 'inspect', h.env, h.signal),
    ).resolves.toBe(false);
    Object.assign(h.task, await collectCindyMakeChanges(h.git, h.userData, h.workingDir));
    h.pnpm.mockImplementation(async () => {});
    await h.run();
    expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe(
      'task change continued',
    );
    await expect(
      manageCindyMakeWorkspace(h.userData, 'run', 'finish', h.env, h.signal),
    ).resolves.toBe(true);
    await expect(access(h.workingDir)).rejects.toThrow();
    expect(await readFile(path.join(h.source, 'concurrent.txt'), 'utf8')).toBe(
      'another completed personal change',
    );
    expect(await h.git(['merge-base', '--is-ancestor', h.task.commit, 'cindy-personal'])).toBe('');
    h.task.workingDir = next.path;
    h.task.runId = 'next';
    await writeFile(path.join(next.path, 'second.txt'), 'next task feature');
    Object.assign(h.task, await collectCindyMakeChanges(h.git, h.userData, next.path));
    await h.run();
    expect(await readFile(path.join(h.source, 'second.txt'), 'utf8')).toBe('next task feature');
    expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe(
      'task change continued',
    );
    expect(await h.git(['status', '--porcelain'])).toBe('');
    expect(await h.git(['merge-base', '--is-ancestor', h.task.commit, 'cindy-personal'])).toBe('');
  } finally {
    await rm(h.userData, { recursive: true, force: true });
  }
}, 90_000);

it('builds the latest cindy-personal HEAD after acquiring the project lock, even from an old completion', async () => {
  const h = await fixture();
  try {
    const first = await h.run();
    let latest = '';
    h.packageCommand.mockImplementationOnce(async (...args) => {
      expect(await h.git(['rev-parse', 'HEAD'], args[2])).toBe(latest);
      expect(await readFile(path.join(args[2], 'latest.txt'), 'utf8')).toBe(
        'newer personal change',
      );
      await h.pack(args[0], args[1], args[2]);
    });
    const next = await buildCindyPersonal(
      { mode: 'personal', userData: h.userData, completionId: h.task.completionId },
      process.execPath,
      h.env,
      'global',
      h.signal,
      async () => {},
      () => {},
      async (run) => {
        // Another completed modification can arrive while this build waits for the source lock.
        await writeFile(path.join(h.source, 'latest.txt'), 'newer personal change');
        await h.git(['add', 'latest.txt']);
        await h.git(['commit', '-s', '-m', 'another personal change']);
        latest = await h.git(['rev-parse', 'cindy-personal']);
        return run();
      },
      { pnpm: h.pnpm, packageCommand: h.packageCommand },
    );
    expect(latest).not.toBe(first.commit);
    expect(next.commit).toBe(latest);
    expect(next.tree).toBe(await h.git(['rev-parse', 'cindy-personal^{tree}']));
    expect(await h.git(['rev-parse', 'HEAD'], h.workingDir)).toBe(h.task.commit);
    expect(await h.git(['status', '--porcelain'])).toBe('');
  } finally {
    await rm(h.userData, { recursive: true, force: true });
  }
}, 90_000);

it('replaces the single personal application only after a successful build and retains it on later failure', async () => {
  const h = await fixture();
  try {
    await writeFile(
      path.join(h.source, '.gitignore'),
      'apps/desktop/release/\napps/desktop/out/\n',
    );
    const appName = brandExecutableName('global');
    h.packageCommand.mockImplementation(async (...args) => {
      await h.pack(args[0], args[1], args[2]);
      const packaged = path.join(
        h.source,
        'apps',
        'desktop',
        'out',
        `${appName}-${process.platform}-${process.arch}`,
      );
      const bundle =
        process.platform === 'darwin' ? path.join(packaged, appName + '.app') : packaged;
      const { executable, resources } = runnableBundlePaths(bundle, appName);
      await mkdir(path.dirname(executable), { recursive: true });
      await mkdir(path.join(resources, 'drizzle'), { recursive: true });
      await writeFile(executable, 'fixture executable');
      await writeFile(path.join(resources, 'app.asar'), 'fixture application');
      await writeFile(path.join(resources, 'drizzle', '0000_base.sql'), 'SELECT 1;');
      await writeFile(
        path.join(resources, 'cindy-version-protocol.json'),
        JSON.stringify({ version: 1 }),
      );
      await writeFile(
        path.join(resources, 'cindy-source.json'),
        JSON.stringify({
          sourceCommit: await h.git(['rev-parse', 'HEAD']),
          builtAt: '2026-09-22T12:00:00+08:00',
        }),
      );
    });
    const run = () =>
      buildCindyPersonal(
        { ...h.task, profile: { userData: h.userData, appName, region: 'global', passive: false } },
        process.execPath,
        h.env,
        'global',
        h.signal,
        async () => {},
        () => {},
        async (operation) => operation(),
        { pnpm: h.pnpm, packageCommand: h.packageCommand },
      );
    const first = await run();
    expect(personalVersionId(h.userData)).toBe(first.versionId);
    h.packageCommand.mockRejectedValueOnce(new Error('packaging failed'));
    await expect(run()).rejects.toThrow('packaging failed');
    expect(personalVersionId(h.userData)).toBe(first.versionId);
    expect(readPersonalVersion(h.userData, first.versionId!).commit).toBe(first.commit);
    const second = await run();
    expect(second.versionId).not.toBe(first.versionId);
    expect(personalVersionId(h.userData)).toBe(second.versionId);
    expect(readPersonalVersion(h.userData, second.versionId!).commit).toBe(
      await h.git(['rev-parse', 'cindy-personal']),
    );
    await expect(
      access(path.join(versionDirectory(h.userData, first.versionId!), 'runtime')),
    ).rejects.toThrow();
  } finally {
    await rm(h.userData, { recursive: true, force: true });
  }
}, 90_000);

it('converts a retained file-only completion into committed personal history and keeps retries idempotent', async () => {
  const h = await fixture();
  try {
    // Recreate an old completion: the recorded HEAD precedes the retained file snapshot.
    await h.git(['reset', '--mixed', 'HEAD^'], h.workingDir);
    h.task.commit = await h.git(['rev-parse', 'HEAD'], h.workingDir);
    expect(await h.git(['status', '--porcelain'], h.workingDir)).toContain('feature.txt');
    const artifact = await h.run();
    expect(await h.git(['status', '--porcelain'])).toBe('');
    expect(await h.git(['show', 'HEAD:feature.txt'])).toBe('task change');
    expect(await h.git(['show', 'HEAD:personal.txt'])).toBe('existing personal change');
    expect(await h.git(['rev-parse', 'HEAD'])).toBe(artifact.commit);
    const repeated = await h.run();
    expect(repeated.commit).toBe(artifact.commit);
    expect(repeated.tree).toBe(artifact.tree);
    expect(await readFile(path.join(h.workingDir, 'feature.txt'), 'utf8')).toBe('task change');
  } finally {
    await rm(h.userData, { recursive: true, force: true });
  }
}, 90_000);

it('rejects files edited after the completion snapshot before packaging or integration', async () => {
  const h = await fixture();
  try {
    await writeFile(path.join(h.workingDir, 'feature.txt'), 'later edit');
    await expect(h.run()).rejects.toMatchObject({ code: 'changed' });
    expect(h.packageCommand).not.toHaveBeenCalled();
    await expect(access(path.join(h.source, 'feature.txt'))).rejects.toThrow();
    expect(await readFile(path.join(h.workingDir, 'feature.txt'), 'utf8')).toBe('later edit');
  } finally {
    await rm(h.userData, { recursive: true, force: true });
  }
}, 90_000);

it('rolls back an interrupted generation and retries without losing task or personal edits', async () => {
  const h = await fixture();
  try {
    const abort = new AbortController();
    h.pnpm.mockImplementationOnce(async (_env, _args, cwd) => {
      expect(cwd).toBe(h.source);
      expect(await readFile(path.join(cwd, 'feature.txt'), 'utf8')).toBe('task change');
      abort.abort();
    });
    await expect(h.run(AbortSignal.any([h.signal, abort.signal]))).rejects.toMatchObject({
      code: 'interrupted',
    });
    expect(h.packageCommand).not.toHaveBeenCalled();
    await expect(access(path.join(h.source, 'feature.txt'))).rejects.toThrow();
    expect(await readFile(path.join(h.source, 'personal.txt'), 'utf8')).toBe(
      'existing personal change',
    );
    expect(await readFile(path.join(h.workingDir, 'feature.txt'), 'utf8')).toBe('task change');
    expect(
      await h.git(['for-each-ref', '--format=%(refname)', 'refs/cindy-make/tasks/run/integrated']),
    ).toBe('');
    await writeFile(path.join(h.workingDir, 'continued.txt'), 'continued after cancellation');
    Object.assign(h.task, await collectCindyMakeChanges(h.git, h.userData, h.workingDir));
    await h.run();
    expect(await readFile(path.join(h.source, 'continued.txt'), 'utf8')).toBe(
      'continued after cancellation',
    );
    expect(await h.git(['diff', '--cached'])).toBe('');
    expect(await h.git(['status', '--porcelain'])).toBe('');
    expect(await h.git(['merge-base', '--is-ancestor', h.task.commit, 'cindy-personal'])).toBe('');
  } finally {
    await rm(h.userData, { recursive: true, force: true });
  }
}, 90_000);

it('integrates large binary content, deletions, and renamed files without truncating patches', async () => {
  const h = await fixture();
  try {
    const binary = randomBytes(90_000);
    await writeFile(path.join(h.workingDir, 'asset.bin'), binary);
    await rename(
      path.join(h.workingDir, 'shared.txt'),
      path.join(h.workingDir, 'renamed file.txt'),
    );
    const facts = await collectCindyMakeChanges(h.git, h.userData, h.workingDir);
    expect(facts.changedFiles).toBe(4);
    Object.assign(h.task, facts);
    await h.run();
    expect(await readFile(path.join(h.source, 'asset.bin'))).toEqual(binary);
    expect(await readFile(path.join(h.source, 'renamed file.txt'), 'utf8')).toBe('base');
    await expect(access(path.join(h.source, 'shared.txt'))).rejects.toThrow();
    expect(await h.git(['merge-base', '--is-ancestor', facts.commit!, 'cindy-personal'])).toBe('');
    expect(await h.git(['diff', '--cached'])).toBe('');
  } finally {
    await rm(h.userData, { recursive: true, force: true });
  }
}, 90_000);

it('commits completed task files locally but refuses to commit on main', async () => {
  const h = await fixture();
  try {
    await writeFile(path.join(h.workingDir, 'feature.txt'), 'staged-only revision');
    await h.git(['add', 'feature.txt'], h.workingDir);
    await writeFile(path.join(h.workingDir, 'feature.txt'), 'unstaged follow-up');
    const facts = await collectCindyMakeChanges(h.git, h.userData, h.workingDir);
    expect(facts.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(await h.git(['status', '--porcelain'], h.workingDir)).toBe('');
    expect(await h.git(['show', 'HEAD:feature.txt'], h.workingDir)).toBe('unstaged follow-up');
    const backupRefs = (
      await h.git(['for-each-ref', '--format=%(refname)', 'refs/cindy-make/history-backups/'])
    ).split('\n');
    const stagedCopies = await Promise.all(
      backupRefs
        .filter((ref) => ref.endsWith('/index'))
        .map((ref) => h.git(['show', ref + ':feature.txt']).catch(() => '')),
    );
    expect(stagedCopies).toContain('staged-only revision');
    expect(await h.git(['log', '-1', '--format=%B'], h.workingDir)).toContain(
      'Signed-off-by: Cindy Make <cindy-make@localhost.invalid>',
    );
    expect(await collectCindyMakeChanges(h.git, h.userData, h.workingDir)).toEqual(facts);
    await h.git(['checkout', '-b', 'main'], h.workingDir);
    const main = await h.git(['rev-parse', 'main']);
    const before = await h.git(['rev-list', '--all', '--count']);
    await expect(collectCindyMakeChanges(h.git, h.userData, h.workingDir)).rejects.toThrow(
      'Unexpected',
    );
    expect(await h.git(['rev-parse', 'main'])).toBe(main);
    expect(await h.git(['rev-list', '--all', '--count'])).toBe(before);
    expect(await readFile(path.join(h.workingDir, 'feature.txt'), 'utf8')).toBe(
      'unstaged follow-up',
    );
  } finally {
    await rm(h.userData, { recursive: true, force: true });
  }
}, 90_000);

it('resumes interrupted task inheritance without overwriting subsequent edits', async () => {
  const h = await fixture();
  try {
    let fail = true;
    const git: typeof runSourceGit = async (env, args, cwd, signal) => {
      if (fail && args[0] === 'apply') {
        fail = false;
        throw new Error('interrupted');
      }
      return runSourceGit(env, args, cwd, signal);
    };
    await expect(
      createCindyMakeWorktree(h.userData, 'retry', h.signal, { processEnvironment: h.env, git }),
    ).rejects.toThrow('interrupted');
    const resumed = await createCindyMakeWorktree(h.userData, 'retry', h.signal, {
      processEnvironment: h.env,
    });
    expect(await readFile(path.join(resumed.path, 'personal.txt'), 'utf8')).toBe(
      'existing personal change',
    );
    await writeFile(path.join(resumed.path, 'personal.txt'), 'continued editing');
    await createCindyMakeWorktree(h.userData, 'retry', h.signal, { processEnvironment: h.env });
    expect(await readFile(path.join(resumed.path, 'personal.txt'), 'utf8')).toBe(
      'continued editing',
    );
    expect(await h.git(['rev-list', '--all', '--count'])).toBe(h.history);
  } finally {
    await rm(h.userData, { recursive: true, force: true });
  }
}, 90_000);

it('retains both sets of personal and task commits on feature merge conflict', async () => {
  const h = await fixture();
  try {
    await writeFile(path.join(h.source, 'shared.txt'), 'personal edit');

    await writeFile(path.join(h.workingDir, 'shared.txt'), 'task edit');

    Object.assign(h.task, await collectCindyMakeChanges(h.git, h.userData, h.workingDir));
    const baseline = await h.git(['rev-parse', 'HEAD']);
    await expect(h.run()).rejects.toMatchObject({ code: 'conflict' });
    expect(h.pnpm).not.toHaveBeenCalled();
    expect(h.packageCommand).not.toHaveBeenCalled();
    expect(await h.git(['merge-base', '--is-ancestor', baseline, 'HEAD'])).toBe('');
    expect(await h.git(['status', '--porcelain'])).toBe('');
    expect(await readFile(path.join(h.source, 'shared.txt'), 'utf8')).toBe('personal edit');
    expect(await readFile(path.join(h.workingDir, 'shared.txt'), 'utf8')).toBe('task edit');
    expect(await h.git(['status', '--porcelain'], h.workingDir)).toBe('');
    expect(await h.git(['rev-parse', 'HEAD'], h.workingDir)).toBe(h.task.commit);
    expect((await h.git(['worktree', 'list', '--porcelain'])).match(/^worktree /gm)).toHaveLength(
      2,
    );
  } finally {
    await rm(h.userData, { recursive: true, force: true });
  }
}, 90_000);
