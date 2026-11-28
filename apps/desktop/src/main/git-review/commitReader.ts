/**
 * Read-only commit source for git-review.
 *
 * The commit view compares a commit against its first parent. Root commits use
 * git's synthetic empty tree via `diff-tree --root`.
 */

import { runGit, GitRunError } from './gitRunner.js';
import { parseGitDiff, parseGitDiffs } from './diffParser.js';
import { isSafeBranchBaseRef, listBranchBaseCandidates, pickDefaultBranchBaseCandidate } from './branchReader.js';
import {
  buildCappedDiffData,
  CAPPED_DIFF_HARD_FILE_COUNT_GUARD,
  createDiffSummaryEntry,
  maxPatchLineBytes,
  parseNumstat,
  readBlobSizeMap,
  type ParsedNumstat,
  singleFileTooLargeReason,
} from './cappedDiff.js';
import type { DiffChangeKind, FileDiff, ReviewBranchDiffWarning, ReviewCappedDiffData, ReviewCommit, ReviewCommitListData, ReviewDiffReadOptions, ReviewDiffSummaryEntry, ReviewHistoryData, ReviewScope } from './types.js';

const LARGE_TEXT_THRESHOLD_BYTES = Math.floor(4.4 * 1024 * 1024);
const TOO_LARGE_THRESHOLD_BYTES = 70 * 1024 * 1024;
const COMMIT_DIFF_MAX_FILE_COUNT = CAPPED_DIFF_HARD_FILE_COUNT_GUARD;
const COMMIT_DIFF_MAX_STDOUT_BYTES = 128 * 1024 * 1024;
const COMMIT_DIFF_IO_CONCURRENCY = 8;

interface CommitChange {
  path: string;
  oldPath: string | null;
  status: DiffChangeKind;
}

interface CommitIdentity {
  oid: string;
  firstParentOid: string | null;
}

function literalPathspec(gitPath: string): string {
  return `:(top,literal)${gitPath}`;
}

function statusFromCode(code: string | undefined): DiffChangeKind {
  const c = code?.[0];
  switch (c) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typechange';
    default:
      return 'unknown';
  }
}

function emptyCommitDiff(change: CommitChange, patch: Partial<FileDiff>): FileDiff {
  return {
    id: `commit:${change.path}`,
    source: 'commit',
    path: change.path,
    oldPath: change.oldPath,
    status: change.status,
    kind: patch.kind ?? 'unrenderable',
    size: patch.size ?? null,
    additions: 0,
    deletions: 0,
    isBinary: patch.kind === 'binary',
    isSubmodule: false,
    isTooLarge: patch.kind === 'too-large',
    mode: { old: null, new: null },
    index: { oldOid: null, newOid: null },
    rawHeader: '',
    rawPatch: '',
    hunks: [],
    error: patch.error ?? null,
  };
}

function commitWarning(
  code: ReviewBranchDiffWarning['code'],
  message: string,
  extra: Omit<ReviewBranchDiffWarning, 'code' | 'message'> = {},
): ReviewBranchDiffWarning {
  return { code, message, ...extra };
}

async function resolveHeadCommit(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: repoRoot });
    const oid = stdout.trim();
    return /^[0-9a-f]{40,64}$/i.test(oid) ? oid : null;
  } catch {
    return null;
  }
}

function emptyCommitList(
  scope: ReviewScope,
  partial: Partial<Pick<ReviewCommitListData, 'baseRef' | 'baseOid' | 'headOid' | 'warning'>> = {},
): ReviewCommitListData {
  return {
    scope,
    baseRef: partial.baseRef ?? null,
    baseOid: partial.baseOid ?? null,
    headOid: partial.headOid ?? null,
    commits: [],
    warning: partial.warning ?? null,
  };
}

function parseBranchCommitLog(stdout: string): ReviewCommit[] {
  return stdout
    .split('\n')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [oid = '', committedAt = '', title = ''] = record.split('\0');
      const authorTimeMs = Date.parse(committedAt);
      return {
        oid,
        shortOid: oid.slice(0, 7),
        title,
        authorTime: Number.isFinite(authorTimeMs) ? Math.floor(authorTimeMs / 1000) : 0,
      };
    })
    .filter((commit) => commit.oid);
}

const HISTORY_MAX_COMMITS = 50;

export async function listRecentCommits(
  scope: ReviewScope,
  limit = 20,
): Promise<ReviewHistoryData> {
  if (scope.disabledReason || !scope.repoRoot) {
    return { scope, commits: [], upstreamOid: null };
  }
  const headOid = await resolveHeadCommit(scope.repoRoot);
  if (!headOid) return { scope, commits: [], upstreamOid: null };

  let upstreamOid: string | null = null;
  try {
    const { stdout } = await runGit(['rev-parse', '--verify', '@{upstream}'], { cwd: scope.repoRoot });
    const oid = stdout.trim();
    upstreamOid = /^[0-9a-f]{40,64}$/i.test(oid) ? oid : null;
  } catch {
    // No upstream configured (or it no longer exists); the history still helps.
  }

  const count = Math.min(Math.max(Math.trunc(limit) || 20, 1), HISTORY_MAX_COMMITS);
  const { stdout } = await runGit(
    ['log', `--max-count=${count}`, '--no-decorate', '--format=%H%x00%cI%x00%s', headOid],
    { cwd: scope.repoRoot, maxStdoutBytes: 4 * 1024 * 1024 },
  );
  return { scope, commits: parseBranchCommitLog(stdout), upstreamOid };
}

export async function listBranchCommits(
  scope: ReviewScope,
  requestedBaseRef?: string | null,
): Promise<ReviewCommitListData> {
  if (scope.disabledReason || !scope.repoRoot) return emptyCommitList(scope);
  const candidates = await listBranchBaseCandidates(scope);
  if (candidates.length === 0) {
    return emptyCommitList(scope, {
      warning: commitWarning('no-base-candidates', 'No base branch candidates found'),
    });
  }
  const safeRequestedBaseRef = requestedBaseRef && isSafeBranchBaseRef(requestedBaseRef) ? requestedBaseRef : null;
  const { candidate, missingWarning } = pickDefaultBranchBaseCandidate(candidates, safeRequestedBaseRef);
  if (!candidate) {
    return emptyCommitList(scope, {
      warning: commitWarning('no-base-candidates', 'No base branch candidates found'),
    });
  }
  const headOid = await resolveHeadCommit(scope.repoRoot);
  const fields = {
    baseRef: candidate.refName,
    baseOid: candidate.oid,
    headOid,
  };
  if (!headOid) {
    return emptyCommitList(scope, {
      ...fields,
      warning: commitWarning('unborn', 'Current branch has no commits yet'),
    });
  }
  const { stdout } = await runGit([
    'log',
    '--no-decorate',
    '--format=%H%x00%cI%x00%s',
    `${candidate.oid}..${headOid}`,
  ], { cwd: scope.repoRoot, maxStdoutBytes: 32 * 1024 * 1024 });
  return {
    scope,
    ...fields,
    commits: parseBranchCommitLog(stdout),
    warning: missingWarning,
  };
}

async function readCommitIdentity(repoRoot: string, oid: string): Promise<CommitIdentity> {
  const { stdout: normalized } = await runGit(['rev-parse', '--verify', `${oid}^{commit}`], {
    cwd: repoRoot,
  });
  const commitOid = normalized.trim();
  const { stdout } = await runGit(['rev-list', '--parents', '-n', '1', commitOid], { cwd: repoRoot });
  const parts = stdout.trim().split(/\s+/).filter(Boolean);
  return {
    oid: commitOid,
    firstParentOid: parts[1] ?? null,
  };
}

async function readChangedEntries(repoRoot: string, identity: CommitIdentity): Promise<CommitChange[]> {
  const args = identity.firstParentOid
    ? ['diff-tree', '--no-commit-id', '-r', '-z', '-M', '--name-status', identity.firstParentOid, identity.oid]
    : ['diff-tree', '--root', '--no-commit-id', '-r', '-z', '-M', '--name-status', identity.oid];
  const { stdout } = await runGit(args, { cwd: repoRoot, maxStdoutBytes: 32 * 1024 * 1024 });
  const parts = stdout.split('\0').filter(Boolean);
  const changes: CommitChange[] = [];
  let i = 0;
  while (i < parts.length) {
    const code = parts[i] ?? '';
    i += 1;
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = parts[i] ?? '';
      const newPath = parts[i + 1] ?? '';
      i += 2;
      if (newPath) changes.push({ path: newPath, oldPath: oldPath || null, status: statusFromCode(code) });
      continue;
    }
    const filePath = parts[i] ?? '';
    i += 1;
    if (filePath) changes.push({ path: filePath, oldPath: null, status: statusFromCode(code) });
  }
  return changes;
}

async function readCommitNumstat(
  repoRoot: string,
  identity: CommitIdentity,
  options: ReviewDiffReadOptions = {},
): Promise<Map<string, ParsedNumstat>> {
  try {
    const whitespaceArgs = options.ignoreWhitespace ? ['-w'] : [];
    const args = identity.firstParentOid
      ? ['diff', ...whitespaceArgs, '--numstat', '-z', '-M', identity.firstParentOid, identity.oid]
      : ['diff-tree', '--root', '--no-commit-id', '-r', ...whitespaceArgs, '--numstat', '-z', '-M', identity.oid];
    const { stdout } = await runGit(args, { cwd: repoRoot, maxStdoutBytes: 32 * 1024 * 1024 });
    return parseNumstat(stdout);
  } catch {
    return new Map();
  }
}

async function readBlobSize(repoRoot: string, treeish: string | null, gitPath: string | null): Promise<number | null> {
  if (!treeish || !gitPath) return null;
  try {
    const { stdout } = await runGit(['cat-file', '-s', `${treeish}:${gitPath}`], { cwd: repoRoot });
    const size = Number(stdout.trim());
    return Number.isFinite(size) ? size : null;
  } catch {
    return null;
  }
}

async function classifyCommitChange(repoRoot: string, identity: CommitIdentity, change: CommitChange): Promise<Pick<FileDiff, 'kind' | 'size' | 'error'>> {
  const treeish = change.status === 'deleted' ? identity.firstParentOid : identity.oid;
  const sizePath = change.status === 'deleted' ? change.oldPath ?? change.path : change.path;
  const size = await readBlobSize(repoRoot, treeish, sizePath);
  if (size !== null && size > TOO_LARGE_THRESHOLD_BYTES) {
    return { kind: 'too-large', size, error: 'File is too large to render' };
  }
  if (size !== null && size > LARGE_TEXT_THRESHOLD_BYTES) {
    return { kind: 'large-text', size, error: 'Large text diff is not rendered automatically in M1' };
  }
  return { kind: 'text', size, error: null };
}

async function readCommitSummaryEntries(
  repoRoot: string,
  identity: CommitIdentity,
  changes: readonly CommitChange[],
  options: ReviewDiffReadOptions = {},
): Promise<ReviewDiffSummaryEntry[]> {
  const numstat = await readCommitNumstat(repoRoot, identity, options);
  const sizeMap = await readBlobSizeMap(repoRoot, changes.map((change) => ({
    key: change.path,
    treeish: change.status === 'deleted' ? identity.firstParentOid : identity.oid,
    gitPath: change.status === 'deleted' ? change.oldPath ?? change.path : change.path,
  })), COMMIT_DIFF_IO_CONCURRENCY);
  const entries = changes.flatMap((change) => {
    const stats = numstat.get(change.path);
    if (options.ignoreWhitespace && change.status === 'modified' && !stats) return [];
    const changedBytes = sizeMap.get(change.path) ?? 0;
    return [createDiffSummaryEntry({
      source: 'commit',
      path: change.path,
      oldPath: change.oldPath,
      status: change.status,
      additions: stats?.additions ?? 0,
      deletions: stats?.deletions ?? 0,
      changedBytes,
      isBinary: stats?.isBinary ?? false,
    })];
  });
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function readRawCommitDiff(
  repoRoot: string,
  identity: CommitIdentity,
  change: CommitChange,
  options: ReviewDiffReadOptions = {},
): Promise<string> {
  const pathspecs = [change.oldPath, change.path]
    .filter((p): p is string => Boolean(p))
    .map(literalPathspec);
  const whitespaceArgs = options.ignoreWhitespace ? ['-w'] : [];
  if (identity.firstParentOid) {
    const { stdout } = await runGit(
      ['diff', ...whitespaceArgs, '--no-ext-diff', '--patch-with-raw', '-z', '--no-color', '-M', identity.firstParentOid, identity.oid, '--', ...pathspecs],
      { cwd: repoRoot, maxStdoutBytes: COMMIT_DIFF_MAX_STDOUT_BYTES },
    );
    return stdout;
  }
  const { stdout } = await runGit(
    ['diff-tree', '--root', '--no-commit-id', '-r', ...whitespaceArgs, '--no-ext-diff', '--patch-with-raw', '-z', '--no-color', '-M', identity.oid, '--', ...pathspecs],
    { cwd: repoRoot, maxStdoutBytes: COMMIT_DIFF_MAX_STDOUT_BYTES },
  );
  return stdout;
}

async function readRawCommitDiffs(
  repoRoot: string,
  identity: CommitIdentity,
  options: ReviewDiffReadOptions = {},
): Promise<string> {
  const whitespaceArgs = options.ignoreWhitespace ? ['-w'] : [];
  if (identity.firstParentOid) {
    const { stdout } = await runGit(
      ['diff', ...whitespaceArgs, '--no-ext-diff', '--patch-with-raw', '-z', '--no-color', '-M', identity.firstParentOid, identity.oid],
      { cwd: repoRoot, maxStdoutBytes: COMMIT_DIFF_MAX_STDOUT_BYTES },
    );
    return stdout;
  }
  const { stdout } = await runGit(
    ['diff-tree', '--root', '--no-commit-id', '-r', ...whitespaceArgs, '--no-ext-diff', '--patch-with-raw', '-z', '--no-color', '-M', identity.oid],
    { cwd: repoRoot, maxStdoutBytes: COMMIT_DIFF_MAX_STDOUT_BYTES },
  );
  return stdout;
}

function rawDiffIsBinary(raw: string): boolean {
  return /\nBinary files .+ differ\n?/.test(raw) || /\nGIT binary patch\n/.test(raw);
}

export async function readCommitDiff(
  scope: ReviewScope,
  oid: string,
  options: ReviewDiffReadOptions = {},
): Promise<{ commitOid: string; diffs: FileDiff[]; capped: ReviewCappedDiffData | null }> {
  if (!scope.repoRoot) return { commitOid: oid, diffs: [], capped: null };
  const identity = await readCommitIdentity(scope.repoRoot, oid);
  const changes = await readChangedEntries(scope.repoRoot, identity);
  if (changes.length > COMMIT_DIFF_MAX_FILE_COUNT) {
    throw new Error(`Commit diff has too many changed files to load: ${changes.length} > ${COMMIT_DIFF_MAX_FILE_COUNT}`);
  }
  const summaryEntries = await readCommitSummaryEntries(scope.repoRoot, identity, changes, options);
  const capped = buildCappedDiffData(summaryEntries);
  if (capped) return { commitOid: identity.oid, diffs: [], capped };
  const parsedByPath = new Map<string, FileDiff>();
  try {
    for (const diff of parseGitDiffs(await readRawCommitDiffs(scope.repoRoot, identity, options), {
      source: 'commit',
      kind: 'text',
    })) {
      parsedByPath.set(diff.path, diff);
    }
  } catch {
    parsedByPath.clear();
  }
  const diffs: FileDiff[] = [];
  for (const change of changes) {
    const classification = await classifyCommitChange(scope.repoRoot, identity, change);
    if (classification.kind !== 'text') {
      diffs.push(emptyCommitDiff(change, classification));
      continue;
    }
    try {
      const parsed = change.status === 'typechange' ? undefined : parsedByPath.get(change.path);
      const raw = parsed?.rawPatch ?? await readRawCommitDiff(scope.repoRoot, identity, change, options);
      if (!raw.trim() || !raw.includes('diff --git')) {
        diffs.push(emptyCommitDiff(change, { kind: 'text', size: classification.size }));
        continue;
      }
      const isBinary = rawDiffIsBinary(raw);
      diffs.push(parsed ? {
        ...parsed,
        oldPath: change.oldPath ?? parsed.oldPath,
        kind: isBinary ? 'binary' : 'text',
        size: classification.size,
        isBinary,
        error: isBinary ? 'Binary file' : null,
      } : parseGitDiff(raw, {
        source: 'commit',
        pathHint: change.path,
        oldPathHint: change.oldPath,
        kind: isBinary ? 'binary' : 'text',
        size: classification.size,
        error: isBinary ? 'Binary file' : null,
      }));
    } catch (err) {
      const message = err instanceof GitRunError ? err.stderr || err.message : err instanceof Error ? err.message : String(err);
      diffs.push(emptyCommitDiff(change, { kind: 'unrenderable', size: classification.size, error: message }));
    }
  }
  diffs.sort((a, b) => a.path.localeCompare(b.path));
  return { commitOid: identity.oid, diffs, capped: null };
}

function tooLargeCommitDiff(change: CommitChange, size: number | null, reason: string): FileDiff {
  return emptyCommitDiff(change, {
    kind: 'too-large',
    size,
    error: reason,
  });
}

export async function readCommitFileDiff(
  scope: ReviewScope,
  oid: string,
  target: { path: string; oldPath: string | null },
  options: ReviewDiffReadOptions = {},
): Promise<{ commitOid: string; diff: FileDiff | null }> {
  if (!scope.repoRoot) return { commitOid: oid, diff: null };
  const identity = await readCommitIdentity(scope.repoRoot, oid);
  const changes = await readChangedEntries(scope.repoRoot, identity);
  const change = changes.find((item) =>
    item.path === target.path &&
    (target.oldPath === null || item.oldPath === target.oldPath));
  if (!change) return { commitOid: identity.oid, diff: null };
  const summaryEntries = await readCommitSummaryEntries(scope.repoRoot, identity, [change], options);
  const summary = summaryEntries[0] ?? null;
  const classification = await classifyCommitChange(scope.repoRoot, identity, change);
  const changedBytes = summary?.changedBytes ?? classification.size ?? 0;
  const preReadTooLarge = singleFileTooLargeReason({
    changedLines: summary?.changedLines ?? 0,
    changedBytes,
  });
  if (preReadTooLarge) {
    return { commitOid: identity.oid, diff: tooLargeCommitDiff(change, changedBytes, `File is too large to render (${preReadTooLarge})`) };
  }
  if (classification.kind !== 'text') {
    return { commitOid: identity.oid, diff: emptyCommitDiff(change, classification) };
  }
  try {
    const raw = await readRawCommitDiff(scope.repoRoot, identity, change, options);
    if (!raw.trim() || !raw.includes('diff --git')) {
      return { commitOid: identity.oid, diff: emptyCommitDiff(change, { kind: 'text', size: classification.size }) };
    }
    const isBinary = rawDiffIsBinary(raw);
    const parsed = parseGitDiff(raw, {
      source: 'commit',
      pathHint: change.path,
      oldPathHint: change.oldPath,
      kind: isBinary ? 'binary' : 'text',
      size: classification.size,
      error: isBinary ? 'Binary file' : null,
    });
    const postReadTooLarge = singleFileTooLargeReason({
      changedLines: parsed.additions + parsed.deletions,
      changedBytes: parsed.size ?? changedBytes,
      maxLineBytes: maxPatchLineBytes(parsed.rawPatch),
    });
    if (postReadTooLarge) {
      return { commitOid: identity.oid, diff: tooLargeCommitDiff(change, parsed.size ?? changedBytes, `File is too large to render (${postReadTooLarge})`) };
    }
    return { commitOid: identity.oid, diff: parsed };
  } catch (err) {
    const message = err instanceof GitRunError ? err.stderr || err.message : err instanceof Error ? err.message : String(err);
    return { commitOid: identity.oid, diff: emptyCommitDiff(change, { kind: 'unrenderable', size: classification.size, error: message }) };
  }
}
