import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  applyUpstreamMerge,
  cleanupMergedCandidate,
  cancelUpstreamMerge,
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

it('converts a retained legacy MERGE_HEAD into a local personal commit on the official base without losing original history', async () => {
  const h = await fixture(true);
  try {
    // Represent an existing installation whose personal features already have history.
    await h.commit(h.source, 'legacy personal feature');
    const baselineCommit = await h.git(['rev-parse', 'HEAD'], h.source);
    await h.git(['fetch', '--no-tags', h.remote, h.state.upstreamCommit], h.source);
    const state = { ...h.state, baselineCommit, hasWorkspace: true, status: 'conflict' as const };
    const worktree = mergeWorktree(h.userData, h.state.id);
    await mkdir(path.dirname(worktree), { recursive: true });
    await h.git(
      ['worktree', 'add', '-b', mergeBranch(state.id), worktree, baselineCommit],
      h.source,
    );
    const mergeHead = await h.git(
      ['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'],
      worktree,
    );
    await writeFile(mergeHead.trim(), h.state.upstreamCommit + '\n');
    await writeFile(path.join(worktree, 'feature.txt'), 'local feature\nupstream fix\n');
    await h.git(['add', '.'], worktree);
    const count = await h.git(['rev-list', '--all', h.state.upstreamCommit, '--count'], h.source);
    const result = await applyUpstreamMerge(h.userData, state, h.git);
    expect(result.status).toBe('merged');
    expect(await h.git(['rev-parse', 'HEAD'], h.source)).toBe(result.commit);
    expect(Number(await h.git(['rev-list', '--all', '--count'], h.source))).toBe(Number(count) + 1);
    expect(await h.git(['merge-base', h.state.upstreamCommit, 'HEAD'], h.source)).toBe(
      h.state.upstreamCommit,
    );
    expect(await h.git(['status', '--porcelain'], h.source)).toBe('');
    expect(await readFile(path.join(h.source, 'feature.txt'), 'utf8')).toBe(
      'local feature\nupstream fix\n',
    );
    expect(await applyUpstreamMerge(h.userData, state, h.git)).toEqual(result);
  } finally {
    await h.clean();
  }
}, 30_000);

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
