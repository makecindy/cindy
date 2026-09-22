import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  applyUpstreamMerge,
  cleanupMergedCandidate,
  cancelUpstreamMerge,
  discardFeatureMerge,
  prepareFeatureMerge,
  prepareUpstreamMerge,
  mergeWorktree,
  mergeBranch,
} from '../upstreamMerge';
import { PERSONAL_UPSTREAM_REF } from '../sourceContent';
import { makeSourceCheckoutPath } from '../sourcePaths';
import { runSourceGit } from '../sourceGit';
import type { CindyMakeMergeState } from '../../../shared/cindyMakeMerge';

async function fixture(conflict: boolean) {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'cindy-upstream-merge-'));
  const source = makeSourceCheckoutPath(userData);
  const remote = path.join(userData, 'official');
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_GLOBAL: path.join(userData, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const run = (args: string[], cwd: string, indexFile?: string) =>
    runSourceGit(
      { ...env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) },
      args,
      cwd,
      AbortSignal.timeout(30_000),
    );
  const git = (args: string[], cwd: string, indexFile?: string) =>
    run(
      args.map((arg) => (arg === 'https://github.com/makecindy/cindy.git' ? remote : arg)),
      cwd,
      indexFile,
    );
  const commit = async (cwd: string, message: string) => {
    await git(['add', '.'], cwd);
    await git(
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
  const clean = () => rm(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  try {
    await writeFile(env.GIT_CONFIG_GLOBAL, '');
    await mkdir(remote);
    await mkdir(path.dirname(source), { recursive: true });
    await git(['init', '--initial-branch=main'], remote);
    await writeFile(path.join(remote, 'feature.txt'), 'base\n');
    await commit(remote, 'base');
    await git(['clone', remote, source], userData);
    await git(['checkout', '-b', 'cindy-personal'], source);
    await writeFile(path.join(source, 'feature.txt'), 'local feature\n');

    const baselineCommit = (await git(['rev-parse', 'HEAD'], source)).trim();
    await writeFile(path.join(remote, conflict ? 'feature.txt' : 'upstream.txt'), 'upstream fix\n');
    await commit(remote, 'official update');
    const upstreamCommit = (await git(['rev-parse', 'HEAD'], remote)).trim();
    const state: CindyMakeMergeState = {
      id: randomUUID(),
      status: 'fetching',
      ref: 'main',
      upstreamCommit,
    };
    return { userData, source, remote, git, commit, clean, state, baselineCommit };
  } catch (error) {
    await clean();
    throw error;
  }
}

it.each(['ahead', 'diverged'] as const)(
  'keeps local main and personal files when main is %s of the sync target',
  async (relation) => {
    const h = await fixture(false);
    try {
      // Ahead reproduces a Dev main accidentally compared with an older release.
      if (relation === 'ahead') {
        await h.git(['fetch', h.remote, h.state.upstreamCommit], h.source);
        await h.git(['branch', '--force', 'main', h.state.upstreamCommit], h.source);
      } else {
        await h.commit(h.source, 'local main changes');
        await h.git(['branch', '--force', 'main', 'HEAD'], h.source);
        await writeFile(path.join(h.source, 'feature.txt'), 'keep uncommitted edits\n');
      }
      const beforeMain = await h.git(['rev-parse', 'main'], h.source);
      const beforePersonal = await h.git(['rev-parse', 'cindy-personal'], h.source);
      const beforeFiles = await readFile(path.join(h.source, 'feature.txt'), 'utf8');
      await expect(
        prepareUpstreamMerge(
          h.userData,
          {
            ...h.state,
            upstreamCommit: relation === 'ahead' ? h.baselineCommit : h.state.upstreamCommit,
          },
          h.git,
          async () => {},
        ),
      ).rejects.toMatchObject({ code: relation === 'ahead' ? 'localMainAhead' : 'localMain' });
      expect(await h.git(['rev-parse', 'main'], h.source)).toBe(beforeMain);
      expect(await h.git(['rev-parse', 'cindy-personal'], h.source)).toBe(beforePersonal);
      expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe(beforeFiles);
      expect(await h.git(['branch', '--list', mergeBranch(h.state.id)], h.source)).toBe('');
    } finally {
      await h.clean();
    }
  },
);

it.each([false, true])(
  'discards only the confirmed feature candidate and keeps original changes (partial Windows residue=%s)',
  async (residue) => {
    const h = await fixture(true);
    try {
      await h.git(['fetch', h.remote, h.state.upstreamCommit], h.source);
      const taskTree = (
        await h.git(['rev-parse', h.state.upstreamCommit + '^{tree}'], h.source)
      ).trim();
      const state = await prepareFeatureMerge(
        h.userData,
        h.state,
        {
          runId: 'original',
          taskSessionId: 'original-task',
          action: 'integrate',
          taskTree,
          mergeCommit: h.state.upstreamCommit,
          steps: [],
          nextStep: 0,
        },
        h.git,
        async () => {},
      );
      expect(state.status).toBe('conflict');
      const stopped = { ...state, sessionId: 'resolver', cancellationRequested: true };
      const worktree = mergeWorktree(h.userData, state.id);
      await writeFile(path.join(worktree, 'temporary-edit.txt'), 'temporary resolver work');
      const external = path.join(h.userData, 'shared-dependencies');
      await mkdir(external);
      await writeFile(path.join(external, 'keep.txt'), 'shared data');
      if (residue) {
        // Reproduce Git removing registration but leaving dependency junctions.
        await h.git(['worktree', 'remove', '--force', worktree], h.source);
        await mkdir(path.join(worktree, 'node_modules'), { recursive: true });
        await symlink(
          external,
          path.join(worktree, 'node_modules', 'shared'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }
      expect(await discardFeatureMerge(h.userData, stopped, h.git, () => false)).toBe(false);
      expect(await stat(worktree)).toBeTruthy();
      expect(await discardFeatureMerge(h.userData, stopped, h.git, () => true)).toBe(true);
      expect(await discardFeatureMerge(h.userData, stopped, h.git, () => true)).toBe(true);
      await expect(stat(worktree)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        h.git(['rev-parse', '--verify', 'refs/heads/' + mergeBranch(state.id)], h.source),
      ).rejects.toBeTruthy();
      expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe('local feature\n');
      expect(await readFile(path.join(h.remote, 'feature.txt'), 'utf8')).toBe('upstream fix\n');
      expect(await readFile(path.join(external, 'keep.txt'), 'utf8')).toBe('shared data');
    } finally {
      await h.clean();
    }
  },
  30_000,
);

it.each([true, false])(
  'cancels only the task-owned source candidate and preserves source and task files (conflict=%s)',
  async (conflict) => {
    const h = await fixture(conflict);
    try {
      const task = path.join(h.userData, 'original-task');
      await h.git(['worktree', 'add', '-b', 'original-task', task, h.baselineCommit], h.source);
      await writeFile(path.join(task, 'task-edit.txt'), 'keep task edits');
      const state = await prepareUpstreamMerge(
        h.userData,
        { ...h.state, taskOwned: true },
        h.git,
        async () => {},
      );
      expect(state).toMatchObject({ taskOwned: true, status: conflict ? 'conflict' : 'merged' });
      const worktree = mergeWorktree(h.userData, state.id);
      if (conflict) expect(await h.git(['branch', '--show-current'], worktree)).toBe('');
      await writeFile(path.join(worktree, 'resolver-edit.txt'), 'disposable resolver edits');
      await writeFile(path.join(h.source, 'personal-edit.txt'), 'keep new personal edits');
      const head = await h.git(['rev-parse', 'HEAD'], h.source);
      expect(await discardFeatureMerge(h.userData, state, h.git, () => true)).toBe(false);
      const stopped = { ...state, sessionId: 'resolver', cancellationRequested: true };
      expect(await discardFeatureMerge(h.userData, stopped, h.git, () => false)).toBe(false);
      expect(await readFile(path.join(worktree, 'resolver-edit.txt'), 'utf8')).toBe(
        'disposable resolver edits',
      );
      expect(await discardFeatureMerge(h.userData, stopped, h.git, () => true)).toBe(true);
      expect(await discardFeatureMerge(h.userData, stopped, h.git, () => true)).toBe(true);
      await expect(stat(worktree)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await h.git(['branch', '--list', mergeBranch(state.id)], h.source)).toBe('');
      expect(await h.git(['rev-parse', 'HEAD'], h.source)).toBe(head);
      expect(await h.git(['rev-parse', 'HEAD'], task)).toBe(h.baselineCommit);
      expect(await readFile(path.join(task, 'task-edit.txt'), 'utf8')).toBe('keep task edits');
      expect(await readFile(path.join(h.source, 'personal-edit.txt'), 'utf8')).toBe(
        'keep new personal edits',
      );
      expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe('local feature\n');
      if (!conflict) {
        expect(await h.git(['rev-parse', PERSONAL_UPSTREAM_REF], h.source)).toBe(
          h.state.upstreamCommit,
        );
        expect(await readFile(path.join(h.source, 'upstream.txt'), 'utf8')).toBe('upstream fix\n');
      }
    } finally {
      await h.clean();
    }
  },
  30_000,
);

it('does not force through a lock on a stopped feature candidate', async () => {
  const h = await fixture(true);
  try {
    await h.git(['fetch', h.remote, h.state.upstreamCommit], h.source);
    const taskTree = (
      await h.git(['rev-parse', h.state.upstreamCommit + '^{tree}'], h.source)
    ).trim();
    const state = await prepareFeatureMerge(
      h.userData,
      h.state,
      {
        runId: 'original',
        taskSessionId: 'original-task',
        action: 'integrate',
        taskTree,
        mergeCommit: h.state.upstreamCommit,
        steps: [],
        nextStep: 0,
      },
      h.git,
      async () => {},
    );
    const worktree = mergeWorktree(h.userData, state.id);
    await h.git(['worktree', 'lock', worktree], h.source);
    await expect(
      discardFeatureMerge(h.userData, { ...state, cancellationRequested: true }, h.git, () => true),
    ).rejects.toBeTruthy();
    expect(await stat(worktree)).toBeTruthy();
    expect(await h.git(['rev-parse', '--verify', mergeBranch(state.id)], h.source)).toBeTruthy();
  } finally {
    await h.clean();
  }
}, 30_000);

it('rebases locally committed personal changes onto the latest official main and leaves both checkouts clean', async () => {
  const h = await fixture(false);
  try {
    const result = await prepareUpstreamMerge(h.userData, h.state, h.git, async () => {});
    expect(result.status).toBe('merged');
    expect((await h.git(['rev-parse', 'HEAD'], h.source)).trim()).toBe(result.commit);
    expect((await h.git(['rev-parse', 'main'], h.source)).trim()).toBe(h.state.upstreamCommit);
    expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe('local feature\n');
    expect(await readFile(path.join(h.source, 'upstream.txt'), 'utf8')).toBe('upstream fix\n');
    expect(result.commit).not.toBe(h.baselineCommit);
    expect(await h.git(['merge-base', 'main', 'cindy-personal'], h.source)).toBe(
      h.state.upstreamCommit,
    );
    expect(await h.git(['diff', '--name-only', 'main..cindy-personal'], h.source)).toBe(
      'feature.txt',
    );
    expect(await h.git(['rev-list', 'main..cindy-personal', '--count'], h.source)).toBe('1');
    expect(await h.git(['rev-list', 'main..cindy-personal', '--merges'], h.source)).toBe('');
    expect(await h.git(['status', '--porcelain'], h.source)).toBe('');
    expect(await h.git(['log', '-1', '--format=%B'], h.source)).toContain(
      'Signed-off-by: Cindy Make <cindy-make@localhost.invalid>',
    );
    expect(
      await h.git(['rev-parse', 'refs/cindy-make/backups/' + h.state.id + '/personal'], h.source),
    ).toBe(result.baselineCommit);
    expect(await cleanupMergedCandidate(h.userData, result, h.git)).toBe(true);
    await expect(h.git(['rev-parse', mergeBranch(h.state.id)], h.source)).rejects.toBeTruthy();
    await expect(stat(mergeWorktree(h.userData, h.state.id))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await h.git(['rev-parse', 'cindy-personal'], h.source)).toBe(result.commit);
    expect(
      await h.git(['rev-parse', 'refs/cindy-make/backups/' + h.state.id + '/personal'], h.source),
    ).toBe(result.baselineCommit);
  } finally {
    await h.clean();
  }
}, 30_000);

it('preserves unfinished or session-owned candidates, new files and commits added after adoption', async () => {
  const h = await fixture(false);
  try {
    const result = await prepareUpstreamMerge(h.userData, h.state, h.git, async () => {});
    const worktree = mergeWorktree(h.userData, h.state.id);
    expect(await cleanupMergedCandidate(h.userData, { ...result, status: 'conflict' }, h.git)).toBe(
      false,
    );
    expect(
      await cleanupMergedCandidate(h.userData, { ...result, sessionId: 'active-task' }, h.git),
    ).toBe(false);
    await writeFile(path.join(worktree, 'later.txt'), 'new work\n');
    expect(await cleanupMergedCandidate(h.userData, result, h.git)).toBe(false);
    expect(await readFile(path.join(worktree, 'later.txt'), 'utf8')).toBe('new work\n');
    await h.commit(worktree, 'later work');
    const later = await h.git(['rev-parse', 'HEAD'], worktree);
    expect(await cleanupMergedCandidate(h.userData, result, h.git)).toBe(false);
    expect(await h.git(['rev-parse', mergeBranch(h.state.id)], h.source)).toBe(later);
  } finally {
    await h.clean();
  }
}, 30_000);

it('reclaims an adopted resolution task and its ignored dependencies only after shutdown authorization', async () => {
  const h = await fixture(false);
  try {
    const result = {
      ...(await prepareUpstreamMerge(h.userData, h.state, h.git, async () => {})),
      sessionId: 'completed-resolution',
    };
    const worktree = mergeWorktree(h.userData, h.state.id);
    await writeFile(path.join(h.source, '.git', 'info', 'exclude'), 'node_modules/\n');
    await mkdir(path.join(worktree, 'node_modules'));
    await writeFile(path.join(worktree, 'node_modules', 'dependency.js'), 'generated dependency');
    expect(await cleanupMergedCandidate(h.userData, result, h.git, () => false)).toBe(false);
    expect(await cleanupMergedCandidate(h.userData, result, h.git, () => true)).toBe(true);
    await expect(stat(worktree)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await h.git(['branch', '--list', mergeBranch(result.id)], h.source)).toBe('');
    expect(await h.git(['rev-parse', 'cindy-personal'], h.source)).toBe(result.commit);
    expect(await cleanupMergedCandidate(h.userData, result, h.git, () => true)).toBe(true);
  } finally {
    await h.clean();
  }
}, 30_000);

it('finishes deferred cleanup after packaging rolled back while retaining the adopted commit', async () => {
  const h = await fixture(false);
  try {
    const result = await prepareUpstreamMerge(h.userData, h.state, h.git, async () => {});
    const recoveryRef = 'refs/cindy-make/failed-builds/' + result.commit;
    await h.git(['update-ref', recoveryRef, result.commit!], h.source);
    await h.git(['reset', '--hard', result.baselineCommit!], h.source);
    expect(await cleanupMergedCandidate(h.userData, result, h.git)).toBe(true);
    expect(await h.git(['rev-parse', recoveryRef], h.source)).toBe(result.commit);
    expect(await h.git(['rev-parse', 'cindy-personal'], h.source)).toBe(result.baselineCommit);
  } finally {
    await h.clean();
  }
}, 30_000);

it('removes ignored workspace dependency links without leaving a deregistered directory', async (ctx) => {
  const h = await fixture(false);
  try {
    const result = await prepareUpstreamMerge(h.userData, h.state, h.git, async () => {});
    const worktree = mergeWorktree(h.userData, h.state.id);
    const app = path.join(worktree, 'apps', 'desktop');
    const shared = path.join(worktree, 'packages', 'shared');
    const outside = path.join(h.userData, 'shared-dependency');
    await writeFile(path.join(h.source, '.git', 'info', 'exclude'), 'node_modules/\n');
    for (const dir of [app, shared])
      await mkdir(path.join(dir, 'node_modules'), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(outside, 'keep.txt'), 'shared dependency');
    try {
      await symlink(shared, path.join(app, 'node_modules', 'shared'), 'junction');
      await symlink(app, path.join(shared, 'node_modules', 'desktop'), 'junction');
      await symlink(outside, path.join(shared, 'node_modules', 'external'), 'junction');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        ctx.skip();
        return;
      }
      throw error;
    }
    expect(await cleanupMergedCandidate(h.userData, result, h.git)).toBe(true);
    await expect(stat(worktree)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('shared dependency');
    expect(await h.git(['branch', '--list', mergeBranch(result.id)], h.source)).toBe('');
  } finally {
    await h.clean();
  }
}, 30_000);

it('finishes branch cleanup after directory removal but preserves a branch checked out elsewhere', async () => {
  const h = await fixture(false);
  try {
    const result = await prepareUpstreamMerge(h.userData, h.state, h.git, async () => {});
    await h.git(['worktree', 'remove', mergeWorktree(h.userData, h.state.id)], h.source);
    const other = path.join(h.userData, 'other-worktree');
    await h.git(['worktree', 'add', other, mergeBranch(h.state.id)], h.source);
    expect(await cleanupMergedCandidate(h.userData, result, h.git)).toBe(false);
    expect(await h.git(['rev-parse', 'HEAD'], other)).toBe(result.commit);
    await h.git(['worktree', 'remove', other], h.source);
    expect(await cleanupMergedCandidate(h.userData, result, h.git)).toBe(true);
    expect(await h.git(['branch', '--list', mergeBranch(h.state.id)], h.source)).toBe('');
  } finally {
    await h.clean();
  }
}, 30_000);

it('recovers old cleanup residue after ref deletion and rollback, preserving any remaining file', async () => {
  const h = await fixture(false);
  try {
    const result = await prepareUpstreamMerge(h.userData, h.state, h.git, async () => {});
    const worktree = mergeWorktree(h.userData, h.state.id);
    await h.git(['worktree', 'remove', worktree], h.source);
    await h.git(
      ['update-ref', '-d', 'refs/heads/' + mergeBranch(result.id), result.commit!],
      h.source,
    );
    const recoveryRef = 'refs/cindy-make/failed-builds/' + result.commit;
    await h.git(['update-ref', recoveryRef, result.commit!], h.source);
    await h.git(['reset', '--hard', result.baselineCommit!], h.source);
    await mkdir(path.join(worktree, 'apps', 'desktop', 'node_modules'), { recursive: true });
    const unexpected = path.join(worktree, 'keep.txt');
    await writeFile(unexpected, 'unadopted work');
    expect(await cleanupMergedCandidate(h.userData, result, h.git)).toBe(false);
    expect(await readFile(unexpected, 'utf8')).toBe('unadopted work');
    await unlink(unexpected);
    expect(await cleanupMergedCandidate(h.userData, result, h.git)).toBe(true);
    await expect(stat(worktree)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await cleanupMergedCandidate(h.userData, result, h.git)).toBe(true);
    expect(await h.git(['rev-parse', recoveryRef], h.source)).toBe(result.commit);
    expect(await h.git(['rev-parse', 'cindy-personal'], h.source)).toBe(result.baselineCommit);
  } finally {
    await h.clean();
  }
}, 30_000);

it('finishes a partial Git removal before deleting the exact branch', async () => {
  const h = await fixture(false);
  try {
    const result = await prepareUpstreamMerge(h.userData, h.state, h.git, async () => {});
    const worktree = mergeWorktree(h.userData, h.state.id);
    const partialGit: typeof h.git = async (args, cwd, indexFile) => {
      if (args[0] === 'update-ref' && args.includes('-d'))
        await expect(stat(worktree)).rejects.toMatchObject({ code: 'ENOENT' });
      const output = await h.git(args, cwd, indexFile);
      if (args.includes('worktree') && args.includes('remove')) {
        await mkdir(path.join(worktree, 'node_modules', 'empty'), { recursive: true });
        throw Object.assign(new Error('partial removal'), { exitCode: 1 });
      }
      return output;
    };
    expect(await cleanupMergedCandidate(h.userData, result, partialGit)).toBe(true);
    await expect(stat(worktree)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await h.git(['branch', '--list', mergeBranch(result.id)], h.source)).toBe('');
  } finally {
    await h.clean();
  }
}, 30_000);

it('refuses to delete a branch moved between cleanup verification and ref deletion', async () => {
  const h = await fixture(false);
  try {
    const result = await prepareUpstreamMerge(h.userData, h.state, h.git, async () => {});
    const ref = 'refs/heads/' + mergeBranch(h.state.id);
    const racingGit: typeof h.git = async (args, cwd, indexFile) => {
      if (args[0] === 'update-ref' && args.includes('-d') && args.includes(ref))
        await h.git(['update-ref', ref, h.baselineCommit], h.source);
      return h.git(args, cwd, indexFile);
    };
    await expect(cleanupMergedCandidate(h.userData, result, racingGit)).rejects.toBeTruthy();
    expect(await h.git(['rev-parse', ref], h.source)).toBe(h.baselineCommit);
    expect(await h.git(['rev-parse', 'cindy-personal'], h.source)).toBe(result.commit);
  } finally {
    await h.clean();
  }
}, 30_000);

it('moves a personal branch with no custom changes exactly to the official commit without an empty commit', async () => {
  const h = await fixture(false);
  try {
    await writeFile(path.join(h.source, 'feature.txt'), 'base\n');
    const result = await prepareUpstreamMerge(h.userData, h.state, h.git, async () => {});
    expect(result.status).toBe('merged');
    expect(result.commit).toBe(h.state.upstreamCommit);
    expect(await h.git(['rev-parse', 'main'], h.source)).toBe(h.state.upstreamCommit);
    expect(await h.git(['rev-parse', 'cindy-personal'], h.source)).toBe(h.state.upstreamCommit);
    expect(await h.git(['status', '--porcelain'], h.source)).toBe('');
    expect(await readFile(path.join(h.source, 'upstream.txt'), 'utf8')).toBe('upstream fix\n');
  } finally {
    await h.clean();
  }
}, 30_000);

it('cancels a conflicting update without merging or losing personal edits and can update again', async () => {
  const h = await fixture(true);
  try {
    const result = await prepareUpstreamMerge(h.userData, h.state, h.git, async () => {});
    expect(result.status).toBe('conflict');
    const worktree = mergeWorktree(h.userData, result.id);
    await writeFile(path.join(h.source, 'new-personal.txt'), 'work added while deciding\n');
    await writeFile(path.join(worktree, 'keep.txt'), 'unexpected work\n');
    // Ordinary worktree removal must refuse unexpected files, with no force-delete fallback.
    await expect(cancelUpstreamMerge(h.userData, result, h.git)).rejects.toBeTruthy();
    expect(await readFile(path.join(worktree, 'keep.txt'), 'utf8')).toBe('unexpected work\n');
    await rm(path.join(worktree, 'keep.txt'));
    await cancelUpstreamMerge(h.userData, result, h.git);
    await expect(stat(worktree)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await h.git(['branch', '--list', mergeBranch(result.id)], h.source)).toBe('');
    expect(await h.git(['rev-parse', 'HEAD'], h.source)).toBe(result.baselineCommit);
    expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe('local feature\n');
    expect(await readFile(path.join(h.source, 'new-personal.txt'), 'utf8')).toBe(
      'work added while deciding\n',
    );
    expect(await h.git(['rev-parse', 'main'], h.source)).toBe(result.upstreamCommit);
    expect(
      await h.git(['rev-parse', 'refs/cindy-make/backups/' + result.id + '/personal'], h.source),
    ).toBe(result.baselineCommit);
    // A retry after a crash between deletion and saving the cancelled state is harmless.
    await cancelUpstreamMerge(h.userData, result, h.git);
    const next = await prepareUpstreamMerge(
      h.userData,
      { ...h.state, id: randomUUID() },
      h.git,
      async () => {},
    );
    expect(next.status).toBe('conflict');
    expect(await readFile(path.join(h.source, 'new-personal.txt'), 'utf8')).toBe(
      'work added while deciding\n',
    );
  } finally {
    await h.clean();
  }
}, 30_000);

it('isolates conflicts, preserves personal files, and applies a resolved merge idempotently', async () => {
  const h = await fixture(true);
  try {
    const result = await prepareUpstreamMerge(h.userData, h.state, h.git, async () => {});
    expect(result.status).toBe('conflict');
    expect((await h.git(['rev-parse', 'HEAD'], h.source)).trim()).toBe(result.baselineCommit);
    expect(await h.git(['rev-parse', 'main'], h.source)).toBe(h.state.upstreamCommit);
    expect(await h.git(['status', '--porcelain'], h.source)).toBe('');
    expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe('local feature\n');
    const worktree = mergeWorktree(h.userData, h.state.id);
    expect(await h.git(['diff', '--name-only', '--diff-filter=U'], worktree)).toContain(
      'feature.txt',
    );
    await expect(applyUpstreamMerge(h.userData, result, h.git)).rejects.toMatchObject({
      code: 'dirty',
    });
    await writeFile(path.join(worktree, 'feature.txt'), 'local feature\nupstream fix\n');
    await h.git(['add', '.'], worktree);
    const applied = await applyUpstreamMerge(h.userData, result, h.git);
    expect(applied.status).toBe('merged');
    expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe(
      'local feature\nupstream fix\n',
    );
    expect(await applyUpstreamMerge(h.userData, result, h.git)).toEqual(applied);
    expect(await h.git(['merge-base', 'main', 'cindy-personal'], h.source)).toBe(
      h.state.upstreamCommit,
    );
    expect(await h.git(['status', '--porcelain'], h.source)).toBe('');
  } finally {
    await h.clean();
  }
}, 30_000);

it('preserves personal work added during resolution and refuses to overwrite concurrent uncommitted edits', async () => {
  const h = await fixture(true);
  try {
    const result = await prepareUpstreamMerge(h.userData, h.state, h.git, async () => {});
    const worktree = mergeWorktree(h.userData, h.state.id);
    await writeFile(path.join(worktree, 'feature.txt'), 'local feature\nupstream fix\n');
    await h.git(['add', '.'], worktree);
    await writeFile(path.join(h.source, 'new-personal.txt'), 'new feature\n');

    await expect(applyUpstreamMerge(h.userData, result, h.git)).rejects.toMatchObject({
      code: 'baselineChanged',
    });
    expect(await readFile(path.join(h.source, 'new-personal.txt'), 'utf8')).toBe('new feature\n');
  } finally {
    await h.clean();
  }
}, 30_000);

it.each([false, true])(
  'adopts and safely cleans a retained legacy candidate without blocking later updates (MERGE_HEAD=%s)',
  async (pendingMerge) => {
    const h = await fixture(true);
    try {
      // Represent an existing installation whose personal features already have history.
      await h.commit(h.source, 'legacy personal feature');
      const baselineCommit = await h.git(['rev-parse', 'HEAD'], h.source);
      await h.git(['fetch', '--no-tags', h.remote, h.state.upstreamCommit], h.source);
      const state = {
        ...h.state,
        baselineCommit,
        ...(pendingMerge
          ? {}
          : { baselineTree: await h.git(['rev-parse', 'HEAD^{tree}'], h.source) }),
        hasWorkspace: true,
        status: 'conflict' as const,
      };
      const worktree = mergeWorktree(h.userData, h.state.id);
      await mkdir(path.dirname(worktree), { recursive: true });
      await h.git(
        ['worktree', 'add', '-b', mergeBranch(state.id), worktree, baselineCommit],
        h.source,
      );
      if (pendingMerge) {
        const mergeHead = await h.git(
          ['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'],
          worktree,
        );
        await writeFile(mergeHead.trim(), h.state.upstreamCommit + '\n');
      }
      await writeFile(path.join(worktree, 'feature.txt'), 'local feature\nupstream fix\n');
      await h.git(['add', '.'], worktree);
      const count = await h.git(['rev-list', '--all', h.state.upstreamCommit, '--count'], h.source);
      const result = await applyUpstreamMerge(h.userData, state, h.git);
      expect(result.status).toBe('merged');
      expect(await h.git(['rev-parse', 'HEAD'], h.source)).toBe(result.commit);
      expect(Number(await h.git(['rev-list', '--all', '--count'], h.source))).toBe(
        Number(count) + 1,
      );
      expect(await h.git(['merge-base', h.state.upstreamCommit, 'HEAD'], h.source)).toBe(
        h.state.upstreamCommit,
      );
      expect(await h.git(['status', '--porcelain'], h.source)).toBe('');
      expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe(
        'local feature\nupstream fix\n',
      );
      expect(await applyUpstreamMerge(h.userData, state, h.git)).toEqual(result);
      expect(await h.git(['rev-parse', 'HEAD'], worktree)).not.toBe(result.commit);
      // A new edit arriving after the cleanup snapshot must not be committed or removed.
      let changed = false;
      const racingGit: typeof h.git = async (args, cwd, indexFile) => {
        if (cwd === worktree && args.at(-1) === 'rebase-merge' && !changed) {
          changed = true;
          await writeFile(path.join(worktree, 'feature.txt'), 'new user edit\n');
        }
        return h.git(args, cwd, indexFile);
      };
      await expect(cleanupMergedCandidate(h.userData, result, racingGit)).rejects.toMatchObject({
        code: 'baselineChanged',
      });
      expect(await h.git(['rev-parse', 'HEAD'], worktree)).toBe(baselineCommit);
      expect(await readFile(path.join(worktree, 'feature.txt'), 'utf8')).toBe('new user edit\n');
      await writeFile(path.join(worktree, 'feature.txt'), 'local feature\nupstream fix\n');
      expect(await cleanupMergedCandidate(h.userData, result, h.git)).toBe(true);
      await expect(stat(worktree)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await h.git(['branch', '--list', mergeBranch(state.id)], h.source)).toBe('');
      const retained = await h.git(
        [
          'for-each-ref',
          '--format=%(objectname)',
          'refs/cindy-make/backups/' + state.id + '/legacy-merge/',
        ],
        h.source,
      );
      expect(await h.git(['rev-parse', retained.trim() + '^{tree}'], h.source)).toBe(result.tree);
      expect(await h.git(['rev-parse', 'HEAD'], h.source)).toBe(result.commit);
      const next = await prepareUpstreamMerge(
        h.userData,
        { ...h.state, id: randomUUID() },
        h.git,
        async () => {},
      );
      expect(next.status).toBe('merged');
      expect(await cleanupMergedCandidate(h.userData, next, h.git)).toBe(true);
    } finally {
      await h.clean();
    }
  },
  30_000,
);

it('migrates old applied-but-uncommitted official files and keeps only personal commits through subsequent updates', async () => {
  const h = await fixture(false);
  try {
    await h.git(['fetch', '--no-tags', h.remote, h.state.upstreamCommit], h.source);
    await h.git(['branch', '--force', 'main', h.state.upstreamCommit], h.source);
    await writeFile(path.join(h.source, 'upstream.txt'), 'upstream fix\n');
    await h.git(['update-ref', PERSONAL_UPSTREAM_REF, h.state.upstreamCommit], h.source);
    expect(await h.git(['status', '--porcelain'], h.source)).toContain('upstream.txt');
    const first = await prepareUpstreamMerge(h.userData, h.state, h.git, async () => {});
    expect(first.status).toBe('merged');
    expect(await h.git(['status', '--porcelain'], h.source)).toBe('');
    expect(await h.git(['diff', '--name-only', 'main..cindy-personal'], h.source)).toBe(
      'feature.txt',
    );
    expect(await h.git(['rev-list', 'main..cindy-personal', '--count'], h.source)).toBe('1');
    await writeFile(path.join(h.remote, 'another.txt'), 'next official fix');
    await h.commit(h.remote, 'another official update');
    const upstreamCommit = await h.git(['rev-parse', 'HEAD'], h.remote);
    const second = await prepareUpstreamMerge(
      h.userData,
      { ...h.state, id: randomUUID(), upstreamCommit },
      h.git,
      async () => {},
    );
    expect(await h.git(['merge-base', 'main', 'cindy-personal'], h.source)).toBe(upstreamCommit);
    expect(await h.git(['diff', '--name-only', 'main..cindy-personal'], h.source)).toBe(
      'feature.txt',
    );
    expect(await h.git(['rev-list', 'main..cindy-personal', '--count'], h.source)).toBe('1');
    expect(await h.git(['status', '--porcelain'], h.source)).toBe('');
    expect(await h.git(['rev-parse', 'HEAD'], h.source)).toBe(second.commit);
  } finally {
    await h.clean();
  }
}, 60_000);
