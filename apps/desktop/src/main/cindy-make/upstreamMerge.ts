import path from 'node:path';
import { lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import type {
  CindyMakeMergeError,
  CindyMakeMergeState,
  MakeFeatureMergePlan,
} from '../../shared/cindyMakeMerge.js';
import { CINDY_PERSONAL_BRANCH, makeSourceCheckoutPath, makeSourceRoot } from './sourcePaths.js';
import { removeMergeWorktreeResidue } from './mergeCleanupResidue.js';
import { PERSONAL_TRACKING_REF } from './personalRemote.js';

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
/** Both strategies replay commits with `git rebase` in the retained candidate. */
const rebases = (state: CindyMakeMergeState) =>
  state.strategy === 'rebase' || state.strategy === 'combine';
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
  if (!branch && rebases(state)) {
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
  canCleanup: () => boolean = () => !state.sessionId,
): Promise<boolean> {
  if (
    state.status !== 'merged' ||
    !canCleanup() ||
    !state.commit ||
    !COMMIT.test(state.commit) ||
    !state.tree ||
    !/^[0-9a-f]{40,64}$/i.test(state.tree)
  )
    return false;
  git = ownedGit(git, canCleanup);
  const worktree = mergeWorktree(userData, state.id);
  const branchRef = 'refs/heads/' + mergeBranch(state.id);
  const source = await assertSource(userData, git);
  const exists = (target: string) =>
    lstat(target).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
  const branchTip = async () => {
    try {
      return (
        await git(['rev-parse', '--verify', '--quiet', branchRef + '^{commit}'], source)
      ).trim();
    } catch (error) {
      if ((error as { exitCode?: number }).exitCode !== 1) throw error;
      return undefined;
    }
  };
  const unregistered = async () =>
    !(await git(['worktree', 'list', '--porcelain', '-z'], source))
      .split('\0')
      .some(
        (entry) =>
          entry === 'branch ' + branchRef ||
          (entry.startsWith('worktree ') && samePath(entry.slice(9), worktree)),
      );
  const workspace = await exists(worktree);
  let tip = await branchTip();
  const legacy = !state.strategy && !state.feature;
  if (!workspace && !tip) return unregistered();
  if (tip && tip !== state.commit && !legacy) return false;
  if ((await git(['rev-parse', state.commit + '^{tree}'], source)).trim() !== state.tree)
    return false;
  try {
    await git(['merge-base', '--is-ancestor', state.commit, CINDY_PERSONAL_BRANCH], source);
  } catch (error) {
    if ((error as { exitCode?: number }).exitCode !== 1) throw error;
    // Packaging may already have restored the source while a Windows file lock deferred cleanup.
    const retained = (
      await git(['rev-parse', '--verify', 'refs/cindy-make/failed-builds/' + state.commit], source)
    ).trim();
    if (retained !== state.commit) return false;
  }
  let removalError: unknown;
  const marker = path.join(worktree, '.git');
  const retainLegacyTip = async () => {
    if (legacy && tip)
      await git(
        ['update-ref', 'refs/cindy-make/backups/' + state.id + '/legacy-merge/' + tip, tip],
        source,
      );
  };
  if (workspace && (await exists(marker))) {
    if (!tip) return false;
    await verifyMergeWorktree(userData, state, git);
    if (
      (await snapshotContent(git, worktree)) !== state.tree ||
      (await git(['rev-parse', 'HEAD'], worktree)).trim() !== tip
    )
      return false;
    if (legacy) {
      // Old file-only adoption committed in the personal checkout, leaving the
      // candidate dirty and sometimes still in its original merge. Finish only
      // that already-adopted tree, retaining its distinct history before removal.
      if (
        (await gitOperationExists(git, worktree, 'MERGE_HEAD')) &&
        (await git(['rev-parse', 'MERGE_HEAD'], worktree)).trim() !== state.upstreamCommit
      )
        return false;
      const normalized = await commitLocalFiles(
        git,
        worktree,
        'Cindy Make: preserve completed legacy merge',
        true,
        state.tree,
      );
      tip = normalized.commit;
      await retainLegacyTip();
    } else await assertNoGitOperation(git, worktree);
    // Git also refuses tracked/untracked edits made after the snapshot check.
    try {
      await git(['-c', 'core.longpaths=true', 'worktree', 'remove', worktree], source);
    } catch (error) {
      removalError = error;
    }
  }

  if (!(await unregistered()) || (await exists(marker))) {
    if (removalError) throw removalError;
    return false;
  }
  // A successful Git exit does not prove the physical directory is gone. Older
  // cleanups could also delete the ref first; adoption still has to be retained.
  if ((await exists(worktree)) && !(await removeMergeWorktreeResidue(worktree, canCleanup)))
    return false;
  if (!(await unregistered())) return false;
  // Keep the exact branch until the directory is gone, and preserve a changed tip.
  await retainLegacyTip();
  if (tip) await git(['update-ref', '--no-deref', '-d', branchRef, tip], source);
  else if (await branchTip()) return false;
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

/** Discard a confirmed, stopped build candidate. Original task/source checkouts are never removed. */
export async function discardFeatureMerge(
  userData: string,
  state: CindyMakeMergeState,
  git: MergeGit,
  canCleanup: () => boolean,
): Promise<boolean> {
  if (!(state.feature || state.taskOwned) || !state.cancellationRequested || !canCleanup())
    return false;
  git = ownedGit(git, canCleanup);
  const source = await assertSource(userData, git);
  const worktree = mergeWorktree(userData, state.id);
  const branchRef = 'refs/heads/' + mergeBranch(state.id);
  const exists = (target: string) =>
    lstat(target).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
  const tip = (
    await git(['rev-parse', '--verify', '--quiet', branchRef + '^{commit}'], source).catch(
      (error) => {
        if ((error as { exitCode?: number }).exitCode === 1) return '';
        throw error;
      },
    )
  ).trim();
  const marker = path.join(worktree, '.git');
  let removalError: unknown;
  if (await exists(marker)) {
    if (!COMMIT.test(tip)) return false;
    await verifyMergeWorktree(userData, state, git);
    // Conflict edits are disposable only on this explicit cancellation path,
    // after the resolver has exited. A single force still respects worktree locks.
    try {
      await git(['-c', 'core.longpaths=true', 'worktree', 'remove', '--force', worktree], source);
    } catch (error) {
      removalError = error;
    }
  }
  const unregistered = async () =>
    !(await git(['worktree', 'list', '--porcelain', '-z'], source))
      .split('\0')
      .some(
        (entry) =>
          entry === 'branch ' + branchRef ||
          (entry.startsWith('worktree ') && samePath(entry.slice(9), worktree)),
      );
  if (!(await unregistered()) || (await exists(marker))) {
    if (removalError) throw removalError;
    return false;
  }
  if ((await exists(worktree)) && !(await removeMergeWorktreeResidue(worktree, canCleanup)))
    return false;
  if (!(await unregistered())) return false;
  if (tip) await git(['update-ref', '--no-deref', '-d', branchRef, tip], source);
  return true;
}

/** At most this many uncarried changes are named in the state and the task prompt. */
const MAX_NAMED_MISSING = 50;
const IDENTITY_FORMAT = '%an%x00%ae%x00%at%x00%s';

/** `git log` lines for `args`; Git output cut at the capture limit is never trusted. */
async function listedCommits(git: MergeGit, cwd: string, args: string[]): Promise<string[]> {
  const lines = (await git(['log', ...args], cwd)).split(/\r?\n/).filter(Boolean);
  const count = Number(
    (
      await git(['rev-list', '--count', ...args.filter((arg) => !arg.startsWith('--format='))], cwd)
    ).trim(),
  );
  if (!Number.isSafeInteger(count) || count !== lines.length) throw mergeError('checksFailed');
  return lines;
}

/**
 * Applying `base..commit` onto `result` changes nothing: its content is already there.
 * Git 2.40 answers with `merge-tree`; older Git (for example the one macOS ships) checks
 * that the change applies in reverse to the result, in a private index under the
 * candidate's own Git directory.
 */
async function alreadyCarried(
  git: MergeGit,
  cwd: string,
  base: string,
  commit: string,
  result: string,
  resultTree: string,
): Promise<boolean> {
  try {
    const merged = await git(
      ['merge-tree', '--write-tree', '--no-messages', `--merge-base=${base}`, result, commit],
      cwd,
    );
    return merged.split(/\r?\n/)[0]?.trim() === resultTree;
  } catch (error) {
    // Exit 1 is a conflict: not carried. Anything else is an older Git without --merge-base.
    if ((error as { exitCode?: number }).exitCode === 1) return false;
  }
  const scratch = (
    await git(['rev-parse', '--path-format=absolute', '--git-path', 'cindy-make-carried'], cwd)
  ).trim();
  try {
    await mkdir(scratch, { recursive: true });
    const patch = path.join(scratch, 'change.patch');
    const index = path.join(scratch, 'index');
    await git(
      ['diff', '--binary', '--no-ext-diff', '--no-color', '--no-renames', `--output=${patch}`, base, commit],
      cwd,
    );
    await git(['read-tree', result], cwd, index);
    await git(['apply', '--cached', '--check', '--reverse', patch], cwd, index);
    return true;
  } catch {
    return false;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Whether every edit of `commit` survived into `result`: each added line's words
 * still all sit within one line of the file it was added to (a resolution that merged
 * both sides' edits into one line keeps the content, even when the patch changed),
 * and each removed line is gone from that file. A resolution that kept just part of
 * the change does not pass.
 */
async function editsSurvive(
  git: MergeGit,
  cwd: string,
  commit: string,
  result: string,
): Promise<boolean> {
  const diff = await git(
    ['show', '-U0', '--no-color', '--no-ext-diff', '--no-renames', '--format=', commit],
    cwd,
  );
  // Output at the capture limit may be cut: a partial verdict never counts as kept.
  if (diff.length >= 60 * 1024) return false;
  const hunks = diff.split(/\r?\n/);
  // A binary change has no lines to compare; only the strict checks may vouch for it.
  if (hunks.some((line) => line.startsWith('Binary files ') || line.startsWith('GIT binary patch')))
    return false;
  const edits = new Map<string, { added: string[]; removed: string[]; lines: number }>();
  const deleted: string[] = [];
  const modes = new Map<string, string>();
  let file: string | undefined;
  let previous: string | undefined;
  let pendingMode: string | undefined;
  for (const line of hunks) {
    const modeLine = /^(?:new file mode|new mode) (\d{6})$/.exec(line.trim());
    if (modeLine) {
      // The mode header precedes its file's `---`/`+++` pair.
      pendingMode = modeLine[1];
      continue;
    }
    if (line.startsWith('--- ')) {
      const source = line.slice(4).trim();
      previous = source.startsWith('a/') || source.startsWith('b/') ? source.slice(2) : undefined;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      const name = target.startsWith('a/') || target.startsWith('b/') ? target.slice(2) : undefined;
      file = name ?? previous;
      // A hunk that cannot be attributed to a file is never counted as kept.
      if (!file) return false;
      if (pendingMode) {
        modes.set(file, pendingMode);
        pendingMode = undefined;
      }
      if (target === '/dev/null') deleted.push(file);
      edits.set(file, { added: [], removed: [], lines: 0 });
      continue;
    }
    const bucket = file ? edits.get(file) : undefined;
    if (!bucket) continue;
    if (line.startsWith('+') && !line.startsWith('+++ ')) {
      bucket.lines += 1;
      const content = line.slice(1).trim();
      if (content) bucket.added.push(content);
    } else if (line.startsWith('-') && !line.startsWith('--- ')) {
      bucket.lines += 1;
      const content = line.slice(1).trim();
      if (content) bucket.removed.push(content);
    }
  }
  // Every touched file must lead to text hunks: a mode-only change or an empty-file
  // operation has none, and nothing here can prove it was kept.
  if (edits.size !== hunks.filter((line) => line.startsWith('diff --git ')).length) return false;
  for (const [name, { added, removed, lines: touched }] of edits) {
    // Blank-line edits and empty-file or mode operations have no words to compare:
    // they must be proven preserved by the strict checks, never vouched here.
    if (!added.length && !removed.length) return false;
    if (touched > added.length + removed.length) return false;
    const content = await git(['show', `${result}:${name}`], cwd).catch(() => '');
    const lines = content.split(/\r?\n/);
    const wordsOf = (line: string) => line.split(/\s+/).filter(Boolean);
    // One line carries another's content by an ordered, multiplicity-preserving
    // subsequence: an adapted line may fuse in words of the other side, but
    // reordering or dropping words is not "kept" (`return a - b` is not
    // `return b - a`), and a comparison that cannot prove the words kept their
    // order and count fails closed.
    const within = (content: string, line: string) => {
      const needed = wordsOf(content);
      if (!needed.length) return false;
      const words = wordsOf(line);
      let at = 0;
      for (const word of words) if (word === needed[at]) at += 1;
      return at === needed.length;
    };
    // A kept deletion hides behind punctuation the whitespace tokens cannot see:
    // deleted `deny();` retained as `if (deny()) { ... }` differs token-wise, so
    // the removed-line check below compares words with punctuation stripped and
    // fails closed whenever the absence of the deleted text cannot be proved.
    const bareWordsOf = (line: string) =>
      line
        .replace(/[^\p{L}\p{N}_$]+/gu, ' ')
        .split(/\s+/)
        .filter(Boolean);
    const possiblyWithin = (content: string, line: string) =>
      within(bareWordsOf(content).join(' '), bareWordsOf(line).join(' '));
    const carriers = (content: string, among: string[]) =>
      among.filter((line) => within(content, line)).length;
    // Occurrences must survive: one pre-existing line never vouches for an added
    // copy, and a line added twice must be there twice.
    const before = await git(['show', `${commit}^:${name}`], cwd).catch(() => '');
    const beforeLines = before.split(/\r?\n/);
    for (const content of new Set(added)) {
      const needed =
        carriers(content, beforeLines) + added.filter((line) => line === content).length;
      if (carriers(content, lines) < needed) return false;
    }
    // A removed line is gone only when no line of the result carries its content:
    // a resolution that kept it adapted (`deny()` as `deny() // upstream note`)
    // did not apply the deletion and must not vouch for the change. Absence must
    // be provable, so wrapped-in-punctuation keeps count as carried too.
    if (removed.some((content) => lines.some((line) => within(content, line) || possiblyWithin(content, line))))
      return false;
  }
  // A deleted path must remain absent: a resolution that restored the file with
  // other content did not apply the deletion, whatever became of its lines.
  for (const name of deleted)
    if ((await git(['ls-tree', '--name-only', result, '--', name], cwd).catch(() => name)).trim())
      return false;
  // A file's mode is part of the change: a resolution that dropped an executable
  // bit or a symlink type kept only half of it.
  for (const [name, mode] of modes) {
    const listed = (await git(['ls-tree', result, '--', name], cwd).catch(() => '')).trim();
    if (!listed.startsWith(mode + ' ')) return false;
  }
  return true;
}

/** A resolved rebase's own commit for a change vouches only for content it kept. */
async function rebaseKeptChange(
  git: MergeGit,
  cwd: string,
  commit: string,
  made: string,
  result: string,
  resultTree: string,
): Promise<boolean> {
  const own = await bareEdits(git, cwd, commit);
  if (own !== undefined && own === (await bareEdits(git, cwd, made))) return true;
  if (await alreadyCarried(git, cwd, `${commit}^`, commit, result, resultTree)) return true;
  return editsSurvive(git, cwd, commit, result);
}

/** The edits of a commit without context or line numbers: unchanged when only nearby lines moved. */
async function bareEdits(git: MergeGit, cwd: string, commit: string): Promise<string | undefined> {
  const diff = await git(
    ['show', '-U0', '--no-color', '--no-ext-diff', '--no-renames', '--format=', commit],
    cwd,
  );
  // Output at the capture limit may be cut: never compare it. Two binary diffs also
  // look identical ("Binary files … differ" after the `index` lines are dropped), so
  // they are never comparable here: only the strict checks may vouch for them.
  if (
    diff.length >= 60 * 1024 ||
    diff
      .split(/\r?\n/)
      .some((line) => line.startsWith('Binary files ') || line.startsWith('GIT binary patch'))
  )
    return undefined;
  return diff
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('index '))
    .map((line) => (line.startsWith('@@') ? '@@' : line))
    .join('\n');
}

/**
 * The replayed side's own changes (commits reachable from `replayed` but not from
 * `result`) that `result` does not carry. A change is carried
 * - with the same patch anywhere in the result;
 * - as the commit a resolved rebase made for it: with its author, author time and
 *   message, made by this rebase (`onto..result`) and not itself the same patch as a
 *   replayed change, and only after its content is checked (the same edits, the
 *   change's content already in the result, or every edit surviving into the result's
 *   files: a resolution that kept just part of the change keeps the identity too and
 *   must not vouch). Task commits share a generic identity, so the time is what tells
 *   them apart; each such commit vouches for one change only;
 * - as the kept side's own rewrite of it (another computer's earlier update of the
 *   same change): the same identity and the same edits apart from context;
 * - or because applying it to the result changes nothing.
 * A merge commit's own edits are carried when replaying the whole merge changes nothing.
 * Used for both strategies: an official update and a combine keep every personal change,
 * or the user decides (see `acceptMissing`).
 */
export async function uncarriedChanges(
  git: MergeGit,
  cwd: string,
  replayed: string,
  onto: string,
  result: string,
): Promise<string[]> {
  if (!COMMIT.test(replayed) || !COMMIT.test(onto) || !COMMIT.test(result))
    throw mergeError('checksFailed');
  const sides = `${result}...${replayed}`;
  const candidates = await listedCommits(git, cwd, [
    '--cherry-pick',
    '--right-only',
    '--no-merges',
    `--format=%H%x00${IDENTITY_FORMAT}`,
    sides,
  ]);
  const resultTree = (await git(['rev-parse', `${result}^{tree}`], cwd)).trim();
  const created = new Set(
    candidates.length
      ? (await listedCommits(git, cwd, ['--no-merges', '--format=%H', `${onto}..${result}`]))
      : [],
  );
  const missing: string[] = [];
  // Changes sharing one identity cannot be told apart by it; only their content counts.
  const keys = new Map<string, number>();
  for (const line of candidates) {
    const key = line.split('\0').slice(1).join('\0');
    keys.set(key, (keys.get(key) ?? 0) + 1);
  }
  // Result-side commits with no patch-equivalent on the replayed side, by author email.
  type Voucher = { commit: string; key: string; used: boolean };
  const vouchers = new Map<string, Voucher[]>();
  const edits = new Map<string, Promise<string | undefined>>();
  const editsOf = (commit: string) => {
    if (!edits.has(commit)) edits.set(commit, bareEdits(git, cwd, commit));
    return edits.get(commit)!;
  };
  for (const line of candidates) {
    const [commit, ...fields] = line.split('\0');
    if (!COMMIT.test(commit) || fields.length !== 4) throw mergeError('checksFailed');
    const key = fields.join('\0');
    const email = fields[1];
    let pool = vouchers.get(email);
    if (!pool) {
      pool = [];
      for (const voucher of await listedCommits(git, cwd, [
        '--cherry-pick',
        '--left-only',
        '--no-merges',
        '--fixed-strings',
        `--author=<${email}>`,
        `--format=%H%x00${IDENTITY_FORMAT}`,
        sides,
      ])) {
        const [hash, ...identity] = voucher.split('\0');
        if (!COMMIT.test(hash) || identity.length !== 4) throw mergeError('checksFailed');
        pool.push({ commit: hash, key: identity.join('\0'), used: false });
      }
      vouchers.set(email, pool);
    }
    let vouched = false;
    for (const voucher of (keys.get(key) ?? 0) > 1 ? [] : pool) {
      if (voucher.used || voucher.key !== key) continue;
      if (!created.has(voucher.commit)) {
        const own = await editsOf(commit);
        if (own === undefined || own !== (await editsOf(voucher.commit))) continue;
      } else if (!(await rebaseKeptChange(git, cwd, commit, voucher.commit, result, resultTree)))
        // A rebase-made commit keeps the author, author time and title even when the
        // resolution dropped part of the change's edits: it vouches only after the
        // change's content has been checked against the result.
        continue;
      voucher.used = true;
      vouched = true;
      break;
    }
    if (vouched) continue;
    if (!(await alreadyCarried(git, cwd, `${commit}^`, commit, result, resultTree)))
      missing.push(commit);
  }
  const merges = (await git(['rev-list', '--merges', `${result}..${replayed}`], cwd))
    .split(/\s+/)
    .filter(Boolean);
  if (merges.some((commit) => !COMMIT.test(commit))) throw mergeError('checksFailed');
  for (const merge of merges) {
    if (!(await git(['show', '--remerge-diff', '--format=', '--name-only', merge], cwd)).trim())
      continue;
    if (!(await alreadyCarried(git, cwd, `${merge}^1`, merge, result, resultTree)))
      missing.push(merge);
  }
  return missing;
}

/** The side whose own commits a rebase replays: GitHub's when this computer's is kept. */
function replayedSide(state: CindyMakeMergeState): string | undefined {
  const github = state.remote?.commit;
  return github && github !== state.upstreamCommit ? github : state.baselineCommit;
}

/** `result`: the checked result; using it anyway is bound to exactly that commit. */
const missingError = (missing: string[], result: string) =>
  Object.assign(mergeError('checksFailed'), {
    missing: { count: missing.length, commits: missing.slice(0, MAX_NAMED_MISSING), result },
  });

/** Durably record the carried content's trust facts before the source moves. */
export type MergeJournal = (merged: CindyMakeMergeState) => void;

/** Rebase only in the retained candidate, then move the clean personal checkout to its result. */
export async function applyUpstreamMerge(
  userData: string,
  state: CindyMakeMergeState,
  git: MergeGit,
  isCurrent: () => boolean = () => true,
  /** The user chose to use the result although some changes are not in it (see `uncarriedChanges`). */
  options: {
    acceptMissing?: boolean;
    /** Durably record the carried content's trust facts before the source moves (see `adoptedRewrite`). */
    journal?: MergeJournal;
  } = {},
): Promise<CindyMakeMergeState> {
  if (!isCurrent()) throw mergeError('busy');
  const worktree = await verifyMergeWorktree(userData, state, git);
  if (state.feature) return applyFeatureMerge(userData, state, git, isCurrent);
  if (rebases(state)) {
    // The resolver stopped with conflicts left (it asks the user): keep waiting for its task.
    if ((await git(['ls-files', '--unmerged'], worktree)).trim())
      return { ...state, status: 'conflict', needsInput: true, error: undefined };
    if (
      (await gitOperationExists(git, worktree, 'rebase-merge')) ||
      (await gitOperationExists(git, worktree, 'rebase-apply'))
    ) {
      try {
        await git([...MAKE_GIT_IDENTITY, 'rebase', '--continue'], worktree);
      } catch (error) {
        if ((await git(['ls-files', '--unmerged'], worktree)).trim())
          return { ...state, status: 'conflict', needsInput: true, error: undefined };
        throw error;
      }
    }
    const result = await commitLocalFiles(git, worktree, 'Cindy Make: resolve upstream rebase');
    await git(['merge-base', '--is-ancestor', state.upstreamCommit, result.commit], worktree);
    // The user agreed to leave out what this exact result lacks; anything newer is checked again.
    if (options.acceptMissing && state.missing?.result !== result.commit)
      throw mergeError('checksFailed');
    // Neither an official update nor a combine may lose a personal change unnoticed.
    if (!options.acceptMissing) {
      const replayed = replayedSide(state);
      if (!replayed) throw mergeError('checksFailed');
      const missing = await uncarriedChanges(
        git,
        worktree,
        replayed,
        state.upstreamCommit,
        result.commit,
      );
      if (missing.length) throw missingError(missing, result.commit);
    }
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
    const merged: CindyMakeMergeState = {
      ...state,
      status: 'merged',
      commit: result.commit,
      tree: result.tree,
      error: undefined,
      needsInput: undefined,
      missing: undefined,
    };
    // The result carries the replayed content under new commits: its provenance must
    // be durable before the source moves to it, so a crash right after the move can
    // never leave still-unverified content looking trusted (over-marking is safe).
    options.journal?.(merged);
    // Combining with the fork keeps the shared official base; an official update moves to it.
    // The new baseline is recorded before the source moves — the same order the
    // remote-tip adoption uses. An interruption in between leaves "old tip + new
    // base", which the base clamp detects and recovers; the reverse ("new tip +
    // old base") looks like ordinary ancestry and could be published elsewhere.
    await git(
      ['update-ref', PERSONAL_UPSTREAM_REF, state.remote?.base ?? state.upstreamCommit],
      source,
    );
    if (!alreadyApplied) await git(['reset', '--keep', result.commit], source);
    if ((await snapshotContent(git, source)) !== result.tree) throw mergeError('baselineChanged');
    return merged;
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

/**
 * Combine the personal version saved on the user's GitHub with this computer's.
 * The side on the newer official version is kept as it is and the other side's
 * own changes are replayed onto it (both on the same base: this computer's onto
 * GitHub's). Neither side is lost: the kept side must be contained in the result,
 * this computer's version is backed up, and GitHub keeps its version until the
 * result is uploaded with a lease.
 */
export async function preparePersonalCombine(
  userData: string,
  initial: CindyMakeMergeState,
  git: MergeGit,
  publish: (state: CindyMakeMergeState) => Promise<void>,
  isCurrent: () => boolean = () => true,
  /** Passed through to the clean fast path: its adoption needs the same journal. */
  options: { journal?: MergeJournal } = {},
): Promise<CindyMakeMergeState> {
  git = ownedGit(git, isCurrent);
  const remote = initial.remote?.commit ?? initial.upstreamCommit;
  const remoteBase = initial.remote?.base;
  if (!COMMIT.test(remote) || !remoteBase || !COMMIT.test(remoteBase))
    throw mergeError('unavailable');
  const source = await assertSource(userData, git);
  await assertNoGitOperation(git, source);
  // Combine exactly the GitHub version the last sync fetched.
  const tracked = (
    await git(['rev-parse', '--verify', '--quiet', PERSONAL_TRACKING_REF + '^{commit}'], source).catch(
      () => '',
    )
  ).trim();
  if (tracked !== remote) throw mergeError('baselineChanged');
  const personal = await commitPersonalFiles(git, source);
  const localBase = (
    await git(['rev-parse', '--verify', '--quiet', PERSONAL_UPSTREAM_REF + '^{commit}'], source).catch(
      () => '',
    )
  ).trim();
  if (!COMMIT.test(localBase)) throw mergeError('unavailable');
  const isAncestor = async (ancestor: string, descendant: string) => {
    try {
      await git(['merge-base', '--is-ancestor', ancestor, descendant], source);
      return true;
    } catch (error) {
      if ((error as { exitCode?: number }).exitCode === 1) return false;
      throw error;
    }
  };
  // Official versions only move forward; unrelated lines cannot be combined safely.
  let ontoLocal: boolean;
  if (localBase === remoteBase || (await isAncestor(localBase, remoteBase))) ontoLocal = false;
  else if (await isAncestor(remoteBase, localBase)) ontoLocal = true;
  else throw mergeError('unavailable');
  if (!(await isAncestor(remoteBase, remote))) throw mergeError('unavailable');
  const onto = ontoLocal ? personal.commit : remote;
  const replay = ontoLocal ? remote : personal.commit;
  const fork = (await git(['merge-base', replay, onto], source)).trim();
  if (!COMMIT.test(fork)) throw mergeError('unavailable');
  // Only the replayed side's own changes move: its official base must be behind the fork point.
  if (!(await isAncestor(ontoLocal ? remoteBase : localBase, fork))) throw mergeError('unavailable');
  // GitHub's version stays recoverable here even after the result replaces it there.
  if (!ID.test(initial.id)) throw mergeError('unavailable');
  await git(['update-ref', `refs/cindy-make/backups/${initial.id}/github`, remote], source);
  return startRebaseCandidate(
    userData,
    {
      ...initial,
      upstreamCommit: onto,
      remote: { base: ontoLocal ? localBase : remoteBase, commit: remote },
    },
    git,
    publish,
    isCurrent,
    {
      source,
      baselineCommit: personal.commit,
      baselineTree: personal.tree,
      rebaseBase: fork,
      replay,
      journal: options.journal,
    },
  );
}

/** Fetch a pinned official commit and try the merge away from the user's personal checkout. */
export async function prepareUpstreamMerge(
  userData: string,
  initial: CindyMakeMergeState,
  git: MergeGit,
  publish: (state: CindyMakeMergeState) => Promise<void>,
  isCurrent: () => boolean = () => true,
  /** Passed through to the clean fast path: its adoption needs the same journal. */
  options: { journal?: MergeJournal } = {},
): Promise<CindyMakeMergeState> {
  git = ownedGit(git, isCurrent);
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
    // A customized local main is never reset behind the user's back. Distinguish
    // a main that is simply newer than the selected target from a divergent one:
    // the former is normal when a Dev checkout is compared with an older release.
    try {
      await git(['merge-base', '--is-ancestor', main.trim(), initial.upstreamCommit], source);
    } catch (error) {
      // Git exit 1 means "not an ancestor"; other failures cannot prove divergence.
      if ((error as { exitCode?: number }).exitCode !== 1) throw error;
      try {
        await git(['merge-base', '--is-ancestor', initial.upstreamCommit, main.trim()], source);
      } catch (error) {
        if ((error as { exitCode?: number }).exitCode !== 1) throw error;
        throw mergeError('localMain');
      }
      throw mergeError('localMainAhead');
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
  return startRebaseCandidate(userData, initial, git, publish, isCurrent, {
    source,
    baselineCommit,
    baselineTree,
    rebaseBase: previousUpstream,
    journal: options.journal,
  });
}

/**
 * Replay `rebaseBase..baselineCommit` onto `upstreamCommit` in a new retained
 * candidate, never in the personal checkout. A conflict, or merge commits whose
 * own edits a rebase cannot carry, leaves the candidate for a resolution task.
 */
async function startRebaseCandidate(
  userData: string,
  initial: CindyMakeMergeState,
  git: MergeGit,
  publish: (state: CindyMakeMergeState) => Promise<void>,
  isCurrent: () => boolean,
  start: {
    source: string;
    /** This computer's personal version; it must be unchanged when the result is adopted. */
    baselineCommit: string;
    baselineTree: string;
    rebaseBase: string;
    /** The commits replayed onto `upstreamCommit` end here; defaults to the baseline. */
    replay?: string;
    /** Durably record the carried content's trust facts before a clean adopt moves. */
    journal?: MergeJournal;
  },
): Promise<CindyMakeMergeState> {
  const { source, baselineCommit, baselineTree } = start;
  const previousUpstream = start.rebaseBase;
  const replay = start.replay ?? baselineCommit;
  const worktree = mergeWorktree(userData, initial.id);
  const merges = (await git(['rev-list', '--merges', previousUpstream + '..' + replay], source))
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
    strategy: initial.remote ? 'combine' : 'rebase',
    rebaseBase: previousUpstream,
    ...(rebaseReview ? { rebaseReview: true } : {}),
    status: 'merging',
    hasWorkspace: true,
  };
  // Save intent before creating the worktree so a crash cannot lose its identity.
  await publish(state);
  await git(['worktree', 'add', '-b', mergeBranch(state.id), worktree, replay], source);
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
  try {
    // The clean fast path adopts the same way: its journal runs before the move too.
    return await applyUpstreamMerge(userData, state, git, isCurrent, { journal: start.journal });
  } catch (error) {
    // A clean rebase that still lost a change (for example a merge's own edits): its task
    // puts the named changes back before anything is adopted.
    const missing = (error as { missing?: CindyMakeMergeState['missing'] }).missing;
    if (!missing) throw error;
    return { ...state, status: 'conflict', rebaseReview: true, missing };
  }
}
