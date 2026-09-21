import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { runSourceGit } from '../sourceGit';
import { createCindyMakeWorktree } from '../taskWorkspace';
import { collectCindyMakeChanges } from '../completion';
import { manageCindyMakeWorkspace } from '../taskCleanup';
import {
  prepareFeatureMerge,
  applyFeatureMerge,
  mergeWorktree,
  prepareUpstreamMerge,
  applyUpstreamMerge,
} from '../upstreamMerge';
import { makeSourceCheckoutPath } from '../sourcePaths';
import { planFeatureChange } from '../featurePlan';
import { CindyMakeHistoryStore } from '../historyStore';
import { historyBuildRollback } from '../buildRollback';
import type { MakeFeatureAction } from '../../../shared/cindyMakeHistory';
import type { CindyMakeMergeState } from '../../../shared/cindyMakeMerge';

async function fixture() {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'cindy-feature-history-'));
  const source = makeSourceCheckoutPath(userData);
  const remote = path.join(userData, 'official');
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(userData, 'gitconfig'),
  };
  const git = (args: string[], cwd = source, indexFile?: string) =>
    runSourceGit(
      { ...env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) },
      args.map((arg) => (arg === 'https://github.com/makecindy/cindy.git' ? remote : arg)),
      cwd,
      AbortSignal.timeout(30000),
    );
  const commit = async (cwd: string, title: string) => {
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
        title,
      ],
      cwd,
    );
  };
  const clean = () => rm(userData, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  try {
    await writeFile(env.GIT_CONFIG_GLOBAL, '');
    await mkdir(remote);
    await git(['init', '--initial-branch=main'], remote);
    await writeFile(path.join(remote, 'a.txt'), 'base-a\n');
    await writeFile(path.join(remote, 'b.txt'), 'base-b\n');
    await commit(remote, 'base');
    await mkdir(path.dirname(source), { recursive: true });
    await git(['clone', remote, source], userData);
    await git(['checkout', '-b', 'cindy-personal']);
    const store = new CindyMakeHistoryStore(path.join(userData, 'history'));
    const task = async (runId: string, file: string, content: string) => {
      const worktree = await createCindyMakeWorktree(userData, runId, AbortSignal.timeout(30000), {
        processEnvironment: env,
      });
      store.seed({
        runId,
        sessionId: runId + '-session',
        title: runId,
        request: runId,
        createdAt: 1,
        updatedAt: 1,
      });
      await writeFile(path.join(worktree.path, file), content);
      const facts = await collectCindyMakeChanges(git, userData, worktree.path);
      store.completion(runId, { ...facts, id: randomUUID(), reportedAt: Date.now() });
      return worktree;
    };
    const record = (state: CindyMakeMergeState) => {
      if (state.status !== 'merged') return;
      store.receipt(state.feature!.runId, {
        id: state.id,
        action: state.feature!.action,
        at: Date.now(),
        baselineCommit: state.baselineCommit!,
        commit: state.commit!,
        beforeTree: state.baselineTree!,
        tree: state.tree!,
        taskTree: state.feature!.taskTree,
      });
    };
    const action = async (runId: string, action: MakeFeatureAction) => {
      const history = store.read(runId)!;
      const state = await prepareFeatureMerge(
        userData,
        { id: randomUUID(), status: 'merging', ref: 'personal', upstreamCommit: '' },
        planFeatureChange(history, action, history.completions.at(-1)),
        git,
        async () => {},
      );
      record(state);
      return state;
    };
    return { userData, source, remote, env, git, store, task, commit, clean, action, record };
  } catch (error) {
    await clean();
    throw error;
  }
}

it('restores a failed build to the saved version and can generate the same task changes again', async () => {
  const h = await fixture();
  try {
    const first = await h.task('aaaa', 'a.txt', 'saved-feature\n');
    const saved = await h.action('aaaa', 'integrate');
    h.store.version('aaaa', { operationId: saved.id, commit: saved.commit! });
    await writeFile(path.join(first.path, 'a.txt'), 'next-round\n');
    h.store.completion('aaaa', {
      ...(await collectCindyMakeChanges(h.git, h.userData, first.path)),
      id: randomUUID(),
      reportedAt: Date.now(),
    });
    await h.action('aaaa', 'integrate');
    const second = await h.task('bbbb', 'b.txt', 'new-feature\n');
    const pending = await h.action('bbbb', 'integrate');
    const rollback = historyBuildRollback(h.store, h.source);
    await rollback.prepareRollback({ commit: pending.commit!, tree: pending.tree! }, h.git)();
    expect(await h.git(['rev-parse', 'HEAD'])).toBe(saved.commit);
    expect(await readFile(path.join(h.source, 'a.txt'), 'utf8')).toBe('saved-feature\n');
    expect(await readFile(path.join(h.source, 'b.txt'), 'utf8')).toBe('base-b\n');
    expect(await readFile(path.join(first.path, 'a.txt'), 'utf8')).toBe('next-round\n');
    expect(await readFile(path.join(second.path, 'b.txt'), 'utf8')).toBe('new-feature\n');
    expect(h.store.read('aaaa')?.receipts).toHaveLength(1);
    expect(h.store.read('bbbb')?.receipts).toEqual([]);
    expect((await h.action('aaaa', 'integrate')).status).toBe('merged');
    expect((await h.action('bbbb', 'integrate')).status).toBe('merged');
    expect(await readFile(path.join(h.source, 'a.txt'), 'utf8')).toBe('next-round\n');
    expect(await readFile(path.join(h.source, 'b.txt'), 'utf8')).toBe('new-feature\n');
    expect(await h.git(['status', '--porcelain'])).toBe('');
  } finally {
    await h.clean();
  }
}, 120000);

it('keeps history and undoable changes after ending a worktree, preserves another feature, and reapplies explicitly', async () => {
  const h = await fixture();
  try {
    const a = await h.task('aaaa', 'a.txt', 'feature-a\n');
    expect((await h.action('aaaa', 'integrate')).status).toBe('merged');
    await h.task('bbbb', 'b.txt', 'feature-b\n');
    await h.action('bbbb', 'integrate');
    await manageCindyMakeWorkspace(h.userData, 'aaaa', 'end', h.env, AbortSignal.timeout(30000));
    h.store.end('aaaa');
    expect(h.store.list()).toHaveLength(2);
    expect(h.store.read('aaaa')?.endedAt).toBeTypeOf('number');
    await expect(readFile(path.join(a.path, 'a.txt'))).rejects.toThrow();
    expect((await h.action('aaaa', 'revert')).status).toBe('merged');
    expect(await readFile(path.join(h.source, 'a.txt'), 'utf8')).toBe('base-a\n');
    expect(await readFile(path.join(h.source, 'b.txt'), 'utf8')).toBe('feature-b\n');
    expect((await h.action('aaaa', 'reapply')).status).toBe('merged');
    expect(await readFile(path.join(h.source, 'a.txt'), 'utf8')).toBe('feature-a\n');
    expect(await h.git(['status', '--porcelain'])).toBe('');
  } finally {
    await h.clean();
  }
}, 90000);

it('undoes all rounds of one make after an official rebase without removing the newer official files', async () => {
  const h = await fixture();
  try {
    const a = await h.task('aaaa', 'a.txt', 'feature-a\n');
    await h.action('aaaa', 'integrate');
    await h.task('bbbb', 'b.txt', 'feature-b\n');
    await h.action('bbbb', 'integrate');
    await writeFile(path.join(a.path, 'a.txt'), 'feature-a-updated\n');
    h.store.completion('aaaa', {
      ...(await collectCindyMakeChanges(h.git, h.userData, a.path)),
      id: randomUUID(),
      reportedAt: Date.now(),
    });
    await h.action('aaaa', 'integrate');
    await writeFile(path.join(h.remote, 'official.txt'), 'new official content\n');
    await h.commit(h.remote, 'official update');
    const upstreamCommit = await h.git(['rev-parse', 'HEAD'], h.remote);
    expect(
      (
        await prepareUpstreamMerge(
          h.userData,
          { id: randomUUID(), status: 'fetching', ref: 'main', upstreamCommit },
          h.git,
          async () => {},
        )
      ).status,
    ).toBe('merged');
    expect((await h.action('aaaa', 'revert')).status).toBe('merged');
    expect(await readFile(path.join(h.source, 'a.txt'), 'utf8')).toBe('base-a\n');
    expect(await readFile(path.join(h.source, 'b.txt'), 'utf8')).toBe('feature-b\n');
    expect(await readFile(path.join(h.source, 'official.txt'), 'utf8')).toBe(
      'new official content\n',
    );
    expect((await h.action('aaaa', 'reapply')).status).toBe('merged');
    expect(await readFile(path.join(h.source, 'a.txt'), 'utf8')).toBe('feature-a-updated\n');
    expect(await h.git(['status', '--porcelain'])).toBe('');
  } finally {
    await h.clean();
  }
}, 120000);

it('adopts a later conflicting selection against the preserved unbuilt prefix', async () => {
  const h = await fixture();
  try {
    await h.task('aaaa', 'a.txt', 'first-selection\n');
    await h.task('bbbb', 'a.txt', 'second-selection\n');
    const first = await h.action('aaaa', 'integrate');
    expect(first.status).toBe('merged');
    const pending = await h.action('bbbb', 'integrate');
    expect(pending).toMatchObject({ status: 'conflict', baselineCommit: first.commit });
    expect(h.store.read('aaaa')?.versions).toEqual([]);
    expect(await h.git(['rev-parse', 'HEAD'])).toBe(first.commit);
    const worktree = mergeWorktree(h.userData, pending.id);
    await writeFile(path.join(worktree, 'a.txt'), 'both-selections\n');
    await h.git(['add', '.'], worktree);
    const resolved = await applyFeatureMerge(h.userData, pending, h.git);
    expect(resolved.status).toBe('merged');
    h.record(resolved);
    expect(h.store.read('aaaa')?.receipts).toHaveLength(1);
    expect(h.store.read('bbbb')?.receipts).toHaveLength(1);
    expect(await h.git(['merge-base', '--is-ancestor', first.commit!, 'HEAD'])).toBe('');
    expect(await readFile(path.join(h.source, 'a.txt'), 'utf8')).toBe('both-selections\n');
    expect(await h.git(['status', '--porcelain'])).toBe('');
  } finally {
    await h.clean();
  }
}, 90000);

it('isolates an undo conflict and adopts the resolved delta once without resetting later history', async () => {
  const h = await fixture();
  try {
    await h.task('aaaa', 'a.txt', 'feature-a\n');
    await h.action('aaaa', 'integrate');
    await h.task('bbbb', 'a.txt', 'feature-b-depends-on-a\n');
    await h.action('bbbb', 'integrate');
    const before = await h.git(['rev-parse', 'HEAD']);
    const pending = await h.action('aaaa', 'revert');
    expect(pending.status).toBe('conflict');
    expect(await h.git(['rev-parse', 'HEAD'])).toBe(before);
    expect(await readFile(path.join(h.source, 'a.txt'), 'utf8')).toBe('feature-b-depends-on-a\n');
    const worktree = mergeWorktree(h.userData, pending.id);
    await writeFile(path.join(worktree, 'a.txt'), 'feature-b-without-a\n');
    await h.git(['add', '.'], worktree);
    const resolved = await applyFeatureMerge(h.userData, pending, h.git);
    expect(resolved.status).toBe('merged');
    h.record(resolved);
    h.record(resolved);
    expect(h.store.read('aaaa')?.receipts).toHaveLength(2);
    expect(await h.git(['merge-base', '--is-ancestor', before, 'HEAD'])).toBe('');
    expect(await readFile(path.join(h.source, 'a.txt'), 'utf8')).toBe('feature-b-without-a\n');
    expect(await h.git(['status', '--porcelain'])).toBe('');
    expect((await applyFeatureMerge(h.userData, resolved, h.git)).commit).toBe(resolved.commit);
  } finally {
    await h.clean();
  }
}, 90000);

it('retries a merge whose commit hook failed without attempting a second merge over MERGE_HEAD', async () => {
  const h = await fixture();
  try {
    await h.task('aaaa', 'a.txt', 'feature-a');
    const hooks = path.join(h.userData, 'hooks');
    await mkdir(hooks);
    const hook = path.join(hooks, 'pre-commit');
    await writeFile(hook, ['#!/bin/sh', 'exit 1', ''].join(String.fromCharCode(10)), {
      mode: 0o755,
    });
    await h.git(['config', 'core.hooksPath', hooks]);
    let saved: CindyMakeMergeState | undefined;
    const record = h.store.read('aaaa')!;
    await expect(
      prepareFeatureMerge(
        h.userData,
        { id: randomUUID(), status: 'merging', ref: 'personal', upstreamCommit: '' },
        planFeatureChange(record, 'integrate', record.completions.at(-1)),
        h.git,
        async (state) => {
          saved = state;
        },
      ),
    ).rejects.toThrow();
    expect(await h.git(['rev-parse', 'HEAD'])).toBe(saved!.baselineCommit);
    await writeFile(hook, ['#!/bin/sh', 'exit 0', ''].join(String.fromCharCode(10)));
    const result = await applyFeatureMerge(h.userData, saved!, h.git);
    expect(result.status).toBe('merged');
    expect(await readFile(path.join(h.source, 'a.txt'), 'utf8')).toBe('feature-a');
    expect(await h.git(['status', '--porcelain'])).toBe('');
  } finally {
    await h.clean();
  }
}, 90000);

it('holds an otherwise clean official rebase for review when a previous merge introduced additional code', async () => {
  const h = await fixture();
  try {
    await h.task('aaaa', 'a.txt', 'feature-a');
    await h.git([
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'merge',
      '--no-commit',
      '--no-ff',
      'cindy-make/aaaa',
    ]);
    await writeFile(path.join(h.source, 'merge-only.txt'), 'preserve this merge resolution');
    await h.commit(h.source, 'manual integration with additional code');
    const original = await h.git(['rev-parse', 'HEAD']);
    await writeFile(path.join(h.remote, 'official.txt'), 'latest official content');
    await h.commit(h.remote, 'official update');
    const upstreamCommit = await h.git(['rev-parse', 'HEAD'], h.remote);
    const state = await prepareUpstreamMerge(
      h.userData,
      { id: randomUUID(), status: 'fetching', ref: 'main', upstreamCommit },
      h.git,
      async () => {},
    );
    expect(state).toMatchObject({ status: 'conflict', rebaseReview: true });
    expect(await h.git(['rev-parse', 'HEAD'])).toBe(original);
    expect(await readFile(path.join(h.source, 'merge-only.txt'), 'utf8')).toBe(
      'preserve this merge resolution',
    );
    const worktree = mergeWorktree(h.userData, state.id);
    await writeFile(path.join(worktree, 'merge-only.txt'), 'preserve this merge resolution');
    const result = await applyUpstreamMerge(h.userData, state, h.git);
    expect(result.status).toBe('merged');
    expect(await readFile(path.join(h.source, 'merge-only.txt'), 'utf8')).toBe(
      'preserve this merge resolution',
    );
    expect(await readFile(path.join(h.source, 'official.txt'), 'utf8')).toBe(
      'latest official content',
    );
  } finally {
    await h.clean();
  }
}, 90000);
