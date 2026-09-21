import path from 'node:path';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import type {
  CindyMakeMergeError,
  CindyMakeMergeState,
  MakeFeatureMergePlan,
} from '../../shared/cindyMakeMerge.js';
import { CINDY_PERSONAL_BRANCH, makeSourceCheckoutPath, makeSourceRoot } from './sourcePaths.js';

import {
  snapshotContent,
  applyContent,
  PERSONAL_UPSTREAM_REF,
  type ContentGit,
} from './sourceContent.js';
import {
  assertNoGitOperation,
  commitLocalFiles,
  commitPersonalFiles,
  gitOperationExists,
  MAKE_GIT_IDENTITY,
} from './localHistory.js';

export type MergeGit = ContentGit;
function ownedGit(git: MergeGit, isCurrent: () => boolean): MergeGit {
  return (args, cwd, indexFile) => {
    if (!isCurrent()) throw mergeError('busy');
    return git(args, cwd, indexFile);
  };
}
const COMMIT = /^[0-9a-f]{40}$/i;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const mergeError = (code: CindyMakeMergeError) => Object.assign(new Error(code), { code });
const samePath = (a: string, b: string) =>
  process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);

export function mergeWorktree(userData: string, id: string): string {
  if (!ID.test(id)) throw mergeError('unavailable');
  return path.join(makeSourceRoot(userData), 'merge-worktrees', id);
}
export const mergeBranch = (id: string) => {
  if (!ID.test(id)) throw mergeError('unavailable');
  return `cindy-merge/${id}`;
};

async function assertSource(userData: string, git: MergeGit): Promise<string> {
  const source = makeSourceCheckoutPath(userData);
  if (
    !samePath(await realpath(source), source) ||
    !samePath((await git(['rev-parse', '--show-toplevel'], source)).trim(), source) ||
    (await git(['branch', '--show-current'], source)).trim() !== CINDY_PERSONAL_BRANCH
  ) {
    throw mergeError('unavailable');
  }
  return source;
}

/** The candidate must belong to this managed repository and its dedicated merge branch. */
export async function verifyMergeWorktree(
  userData: string,
  state: CindyMakeMergeState,
  git: MergeGit,
): Promise<string> {
  const worktree = mergeWorktree(userData, state.id);
  if (
    !state.baselineCommit ||
    !COMMIT.test(state.baselineCommit) ||
    !COMMIT.test(state.upstreamCommit)
  )
    throw mergeError('unavailable');
  const source = makeSourceCheckoutPath(userData);
  let branch = (await git(['branch', '--show-current'], worktree)).trim();
  if (!branch && state.strategy === 'rebase') {
    for (const backend of ['rebase-merge', 'rebase-apply']) {
      const nameFile = (
        await git(
          ['rev-parse', '--path-format=absolute', '--git-path', backend + '/head-name'],
          worktree,
        )
      ).trim();
      const name = await readFile(nameFile, 'utf8').catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      });
      if (name.trim() === 'refs/heads/' + mergeBranch(state.id)) branch = mergeBranch(state.id);
    }
  }
  if (
    !samePath(await realpath(worktree), worktree) ||
    !samePath(
      (await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], worktree)).trim(),
      path.join(source, '.git'),
    ) ||
    branch !== mergeBranch(state.id)
  ) {
    throw mergeError('unavailable');
  }
  return worktree;
}

/** Remove a completed candidate worktree and its disposable branch ref. */
export async function cleanupMergedCandidate(
  userData: string,
  state: CindyMakeMergeState,
  git: MergeGit,
): Promise<boolean> {
  if (
    state.status !== 'merged' ||
    state.sessionId ||
    !state.commit ||
    !COMMIT.test(state.commit) ||
    !state.tree ||
    !/^[0-9a-f]{40,64}$/i.test(state.tree)
  )
    return false;
  const worktree = mergeWorktree(userData, state.id);
  const branchRef = 'refs/heads/' + mergeBranch(state.id);
  const source = await assertSource(userData, git);
  const tip = (await git(['rev-parse', '--verify', branchRef + '^{commit}'], source)).trim();
  if (tip !== state.commit) return false;
  await git(['merge-base', '--is-ancestor', tip, CINDY_PERSONAL_BRANCH], source);
  const workspace = await lstat(worktree).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (workspace) {
    await verifyMergeWorktree(userData, state, git);
    await assertNoGitOperation(git, worktree);
    if (
      (await snapshotContent(git, worktree)) !== state.tree ||
      (await git(['rev-parse', 'HEAD'], worktree)).trim() !== tip
    )
      return false;
    // Git also refuses tracked/untracked edits made after the snapshot check.
    await git(['worktree', 'remove', worktree], source);
  }

  // A prior cleanup may have removed the directory already. Never delete a ref
  // still checked out elsewhere, or a tip changed after the adoption check.
  const worktrees = await git(['worktree', 'list', '--porcelain', '-z'], source);
  if (worktrees.split('\0').includes('branch ' + branchRef)) return false;
  await git(['update-ref', '--no-deref', '-d', branchRef, tip], source);
  return true;
}

/** Discard only an unassigned update candidate, never the personal checkout or a task's work. */
export async function cancelUpstreamMerge(
  userData: string,
  state: CindyMakeMergeState,
  git: MergeGit,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (
    state.feature ||
    state.sessionId ||
    !['conflict', 'failed', 'cancelled'].includes(state.status)
  )
    throw mergeError('unavailable');
  git = ownedGit(git, isCurrent);
  const worktree = mergeWorktree(userData, state.id);
  const source = await assertSource(userData, git);
  const branchRef = 'refs/heads/' + mergeBranch(state.id);
  const workspace = await lstat(worktree).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  let tip: string;
  if (workspace) {
    await verifyMergeWorktree(userData, state, git);
    if (
      (await gitOperationExists(git, worktree, 'rebase-merge')) ||
      (await gitOperationExists(git, worktree, 'rebase-apply'))
    ) {
      await git(['rebase', '--abort'], worktree);
    } else if (await gitOperationExists(git, worktree, 'MERGE_HEAD')) {
      await git(['merge', '--abort'], worktree);
    }
    await assertNoGitOperation(git, worktree);
    tip = (await git(['rev-parse', 'HEAD'], worktree)).trim();
    // No force: unexpected edits, untracked files and worktree locks must survive.
    await git(['worktree', 'remove', worktree], source);
  } else {
    // A crash may leave only the branch, or may have completed both cleanup steps.
    tip = (
      await git(['rev-parse', '--verify', branchRef + '^{commit}'], source).catch((error) => {
        if ((error as { exitCode?: number }).exitCode === 128) return '';
        throw error;
      })
    ).trim();
    if (!tip) return;
  }
  if (!COMMIT.test(tip)) throw mergeError('unavailable');
  const worktrees = await git(['worktree', 'list', '--porcelain', '-z'], source);
  if (worktrees.split('\0').includes('branch ' + branchRef)) throw mergeError('busy');
  await git(['update-ref', '--no-deref', '-d', branchRef, tip], source);
}

/** Rebase only in the retained candidate, then move the clean personal checkout to its result. */
export async function applyUpstreamMerge(
  userData: string,
  state: CindyMakeMergeState,
  git: MergeGit,
  isCurrent: () => boolean = () => true,
): Promise<CindyMakeMergeState> {
  if (!isCurrent()) throw mergeError('busy');
  const worktree = await verifyMergeWorktree(userData, state, git);
  if (state.feature) return applyFeatureMerge(userData, state, git, isCurrent);
  if (state.strategy === 'rebase') {
    if ((await git(['ls-files', '--unmerged'], worktree)).trim()) throw mergeError('dirty');
    if (
      (await gitOperationExists(git, worktree, 'rebase-merge')) ||
      (await gitOperationExists(git, worktree, 'rebase-apply'))
    ) {
      try {
        await git([...MAKE_GIT_IDENTITY, 'rebase', '--continue'], worktree);
      } catch (error) {
        if ((await git(['ls-files', '--unmerged'], worktree)).trim())
          return { ...state, status: 'conflict', error: undefined };
        throw error;
      }
    }
    const result = await commitLocalFiles(git, worktree, 'Cindy Make: resolve upstream rebase');
    await git(['merge-base', '--is-ancestor', state.upstreamCommit, result.commit], worktree);
    try {
      await git(['diff', '--check', state.upstreamCommit, result.commit], worktree);
    } catch {
      throw mergeError('checksFailed');
    }
    const source = await assertSource(userData, git);
    await assertNoGitOperation(git, source);
    const head = (await git(['rev-parse', 'HEAD'], source)).trim();
    const tree = await snapshotContent(git, source);
    const alreadyApplied = head === result.commit && tree === result.tree;
    if (
      !alreadyApplied &&
      (head !== state.baselineCommit ||
        tree !== state.baselineTree ||
        (await git(['status', '--porcelain', '--untracked-files=all'], source)).trim())
    )
      throw mergeError('baselineChanged');
    if (!isCurrent()) throw mergeError('busy');
    if (!alreadyApplied) await git(['reset', '--keep', result.commit], source);
    if ((await snapshotContent(git, source)) !== result.tree) throw mergeError('baselineChanged');
    await git(['update-ref', PERSONAL_UPSTREAM_REF, state.upstreamCommit], source);
    return {
      ...state,
      status: 'merged',
      commit: result.commit,
      tree: result.tree,
      error: undefined,
    };
  }
  const commit = (await git(['rev-parse', 'HEAD'], worktree)).trim();
  if (state.baselineTree && commit !== state.baselineCommit) throw mergeError('baselineChanged');
  // Legacy candidates may already contain historical commits. Preserve them as file content.
  if (!state.baselineTree) {
    await git(['merge-base', '--is-ancestor', state.baselineCommit!, commit], worktree);
    const pending = (
      await git(['rev-parse', '--verify', 'MERGE_HEAD'], worktree).catch(() => '')
    ).trim();
    if (pending !== state.upstreamCommit)
      await git(['merge-base', '--is-ancestor', state.upstreamCommit, commit], worktree);
  }
  const tree = await snapshotContent(git, worktree);
  const before =
    state.baselineTree ??
    (await git(['rev-parse', state.baselineCommit + '^{tree}'], worktree)).trim();
  try {
    await git(['diff', '--check', before, tree], worktree);
  } catch {
    throw mergeError('checksFailed');
  }
  const source = await assertSource(userData, git);
  const sourceHead = (await git(['rev-parse', 'HEAD'], source)).trim();
  const sourceTree = await snapshotContent(git, source);
  let legacyAlreadyApplied = !state.baselineTree && sourceHead === commit && sourceTree === tree;
  if (
    sourceTree === tree &&
    (await git(['rev-parse', '--verify', PERSONAL_UPSTREAM_REF], source).catch(() => '')).trim() ===
      state.upstreamCommit
  ) {
    try {
      await git(['merge-base', '--is-ancestor', state.upstreamCommit, sourceHead], source);
      legacyAlreadyApplied = true;
    } catch (error) {
      if ((error as { exitCode?: number }).exitCode !== 1) throw error;
    }
  }
  if (
    !legacyAlreadyApplied &&
    (sourceHead !== state.baselineCommit || (sourceTree !== before && sourceTree !== tree))
  )
    throw mergeError('baselineChanged');
  if (!isCurrent()) throw mergeError('busy');
  if (sourceTree !== tree) await applyContent(git, source, before, tree);
  await git(['update-ref', PERSONAL_UPSTREAM_REF, state.upstreamCommit], source);
  const adopted = await commitPersonalFiles(git, source);
  return {
    ...state,
    status: 'merged',
    commit: adopted.commit,
    tree: adopted.tree,
    error: undefined,
  };
}

/** Work through retained deltas. A conflict advances only after its resolved files are committed. */
async function runFeatureSteps(
  userData: string,
  initial: CindyMakeMergeState,
  git: MergeGit,
  publish: (state: CindyMakeMergeState) => Promise<void>,
): Promise<CindyMakeMergeState> {
  let state = initial;
  const worktree = await verifyMergeWorktree(userData, state, git);
  let feature = { ...state.feature! };
  if (feature.awaitingResolution) {
    if ((await git(['ls-files', '--unmerged'], worktree)).trim())
      return { ...state, status: 'conflict' };
    await commitLocalFiles(git, worktree, 'Cindy Make: resolve feature conflict', true);
    feature = { ...feature, awaitingResolution: false, nextStep: feature.nextStep + 1 };
    state = { ...state, feature };
    await publish(state);
  }
  const count = feature.mergeCommit ? 1 : feature.steps.length;
  for (let index = feature.nextStep; index < count; index += 1) {
    try {
      if (feature.mergeCommit) {
        if (await gitOperationExists(git, worktree, 'MERGE_HEAD')) {
          if ((await git(['rev-parse', 'MERGE_HEAD'], worktree)).trim() !== feature.mergeCommit)
            throw mergeError('baselineChanged');
          // A previous commit hook can fail after merge applied its files. Finalize that merge.
        } else
          await git(
            [...MAKE_GIT_IDENTITY, 'merge', '--no-commit', '--no-ff', feature.mergeCommit],
            worktree,
          );
      } else
        await applyContent(
          git,
          worktree,
          feature.steps[index].before,
          feature.steps[index].after,
          true,
        );
      await commitLocalFiles(
        git,
        worktree,
        'Cindy Make: ' + feature.action + ' ' + feature.runId,
        true,
      );
    } catch (error) {
      if (!(await git(['ls-files', '--unmerged'], worktree)).trim()) throw error;
      state = {
        ...state,
        status: 'conflict',
        feature: { ...feature, nextStep: index, awaitingResolution: true },
      };
      await publish(state);
      return state;
    }
    feature = { ...feature, nextStep: index + 1 };
    state = { ...state, feature };
    await publish(state);
  }
  return state;
}

export async function prepareFeatureMerge(
  userData: string,
  initial: CindyMakeMergeState,
  plan: MakeFeatureMergePlan,
  git: MergeGit,
  publish: (state: CindyMakeMergeState) => Promise<void>,
  isCurrent: () => boolean = () => true,
): Promise<CindyMakeMergeState> {
  git = ownedGit(git, isCurrent);
  const source = await assertSource(userData, git);
  const baseline = await commitPersonalFiles(git, source);
  const worktree = mergeWorktree(userData, initial.id);
  await mkdir(path.dirname(worktree), { recursive: true });
  if (!samePath(await realpath(path.dirname(worktree)), path.dirname(worktree)))
    throw mergeError('unavailable');
  let feature = { ...plan };
  if (
    feature.mergeCommit &&
    (await git(['rev-parse', feature.mergeCommit + '^{tree}'], source)).trim() !== feature.taskTree
  ) {
    // Upgrade a file-only completion using its preserved creation baseline.
    const before = (
      await git(['rev-parse', 'refs/cindy-make/tasks/' + feature.runId + '/base^{tree}'], source)
    ).trim();
    feature = { ...feature, mergeCommit: undefined, steps: [{ before, after: feature.taskTree }] };
  }
  const state: CindyMakeMergeState = {
    ...initial,
    upstreamCommit: baseline.commit,
    baselineCommit: baseline.commit,
    baselineTree: baseline.tree,
    ref: 'personal',
    status: 'merging',
    hasWorkspace: true,
    feature,
  };
  await publish(state);
  await git(
    ['update-ref', 'refs/cindy-make/features/' + state.id + '/before', baseline.commit],
    source,
  );
  await git(
    ['update-ref', 'refs/cindy-make/features/' + state.id + '/task', feature.taskTree],
    source,
  );
  await git(['worktree', 'add', '-b', mergeBranch(state.id), worktree, baseline.commit], source);
  const prepared = await runFeatureSteps(userData, state, git, publish);
  return prepared.status === 'conflict'
    ? prepared
    : applyFeatureMerge(userData, prepared, git, isCurrent);
}

/** Adopts only a complete candidate; source history is never rewound to undo one feature. */
export async function applyFeatureMerge(
  userData: string,
  initial: CindyMakeMergeState,
  git: MergeGit,
  isCurrent: () => boolean = () => true,
  publish: (state: CindyMakeMergeState) => Promise<void> = async () => {},
): Promise<CindyMakeMergeState> {
  git = ownedGit(git, isCurrent);
  const state = await runFeatureSteps(userData, initial, git, publish);
  if (state.status === 'conflict' && state.feature?.awaitingResolution) return state;
  const worktree = await verifyMergeWorktree(userData, state, git);
  const candidate = await commitLocalFiles(git, worktree, 'Cindy Make: resolve personal feature');
  const source = await assertSource(userData, git);
  await assertNoGitOperation(git, source);
  const head = (await git(['rev-parse', 'HEAD'], source)).trim();
  const tree = await snapshotContent(git, source);
  const applied = head === candidate.commit && tree === candidate.tree;
  if (
    !applied &&
    (head !== state.baselineCommit ||
      tree !== state.baselineTree ||
      (await git(['status', '--porcelain'], source)).trim())
  )
    throw mergeError('baselineChanged');
  await git(['merge-base', '--is-ancestor', state.baselineCommit!, candidate.commit], source);
  await git(['diff', '--check', state.baselineTree!, candidate.tree], source);
  if (!isCurrent()) throw mergeError('busy');
  await git(
    ['update-ref', 'refs/cindy-make/features/' + state.id + '/after', candidate.commit],
    source,
  );
  if (!applied) await git(['merge', '--ff-only', candidate.commit], source);
  if ((await snapshotContent(git, source)) !== candidate.tree) throw mergeError('baselineChanged');
  if (state.feature!.action !== 'revert')
    await git(
      [
        'update-ref',
        'refs/cindy-make/tasks/' + state.feature!.runId + '/integrated',
        state.feature!.taskTree,
      ],
      source,
    );
  else
    await git(
      ['update-ref', '-d', 'refs/cindy-make/tasks/' + state.feature!.runId + '/integrated'],
      source,
    );
  return {
    ...state,
    status: 'merged',
    commit: candidate.commit,
    tree: candidate.tree,
    error: undefined,
  };
}

/** Fetch a pinned official commit and try the merge away from the user's personal checkout. */
export async function prepareUpstreamMerge(
  userData: string,
  initial: CindyMakeMergeState,
  git: MergeGit,
  publish: (state: CindyMakeMergeState) => Promise<void>,
): Promise<CindyMakeMergeState> {
  const worktree = mergeWorktree(userData, initial.id);
  if (!COMMIT.test(initial.upstreamCommit)) throw mergeError('unavailable');
  const source = await assertSource(userData, git);
  await assertNoGitOperation(git, source);
  await git(
    ['fetch', '--no-tags', 'https://github.com/makecindy/cindy.git', initial.upstreamCommit],
    source,
  );
  if ((await git(['rev-parse', 'FETCH_HEAD^{commit}'], source)).trim() !== initial.upstreamCommit)
    throw mergeError('gitFailed');
  const main = await git(['rev-parse', '--verify', 'refs/heads/main^{commit}'], source).catch(
    () => '',
  );
  if (main.trim()) {
    // A customized local main is never reset behind the user's back.
    try {
      await git(['merge-base', '--is-ancestor', main.trim(), initial.upstreamCommit], source);
    } catch {
      throw mergeError('localMain');
    }
    await git(['update-ref', `refs/cindy-make/backups/${initial.id}/main`, main.trim()], source);
  }
  await git(['branch', '--force', 'main', initial.upstreamCommit], source);
  const personal = await commitPersonalFiles(git, source);
  const baselineCommit = personal.commit;
  const baselineTree = personal.tree;
  const previousUpstream =
    (
      await git(['rev-parse', '--verify', PERSONAL_UPSTREAM_REF + '^{commit}'], source).catch(
        (error) => {
          if ((error as { exitCode?: number }).exitCode === 128) return '';
          throw error;
        },
      )
    ).trim() || (await git(['merge-base', baselineCommit, initial.upstreamCommit], source)).trim();
  if (!COMMIT.test(previousUpstream)) throw mergeError('unavailable');
  await git(['merge-base', '--is-ancestor', previousUpstream, baselineCommit], source);
  const merges = (
    await git(['rev-list', '--merges', previousUpstream + '..' + baselineCommit], source)
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (merges.some((commit) => !COMMIT.test(commit))) throw mergeError('gitFailed');
  const rebaseReview =
    merges.length > 0 &&
    !!(await git(['show', '--remerge-diff', '--format=', '--name-only', ...merges], source)).trim();
  await git(
    ['update-ref', 'refs/cindy-make/backups/' + initial.id + '/personal', baselineCommit],
    source,
  );
  await mkdir(path.dirname(worktree), { recursive: true });
  if (!samePath(await realpath(path.dirname(worktree)), path.dirname(worktree)))
    throw mergeError('unavailable');
  const state: CindyMakeMergeState = {
    ...initial,
    baselineCommit,
    baselineTree,
    strategy: 'rebase',
    rebaseBase: previousUpstream,
    ...(rebaseReview ? { rebaseReview: true } : {}),
    status: 'merging',
    hasWorkspace: true,
  };
  // Save intent before creating the worktree so a crash cannot lose its identity.
  await publish(state);
  await git(['worktree', 'add', '-b', mergeBranch(state.id), worktree, baselineCommit], source);
  await git(['update-ref', 'refs/cindy-make/backups/' + state.id + '/files', baselineTree], source);
  try {
    await git(
      [
        ...MAKE_GIT_IDENTITY,
        '-c',
        'rebase.updateRefs=false',
        'rebase',
        '--no-autostash',
        '--no-update-refs',
        '--signoff',
        '--onto',
        state.upstreamCommit,
        previousUpstream,
      ],
      worktree,
    );
  } catch (error) {
    const conflicts = await git(['diff', '--name-only', '--diff-filter=U'], worktree);
    if (!conflicts.trim()) throw error;
    return { ...state, status: 'conflict' };
  }
  // Rebase does not replay edits introduced only in a merge commit. Never silently adopt their loss.
  if (state.rebaseReview) return { ...state, status: 'conflict' };
  return applyUpstreamMerge(userData, state, git);
}
