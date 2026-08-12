/**
 * Read-only branch source for git-review.
 *
 * Branch source compares the current HEAD with a selected base branch at their
 * merge-base. It deliberately ignores uncommitted index/worktree changes so the
 * result matches PR-style committed branch diffs.
 */

import { isSafeBranchBaseRef } from '../../shared/reviewBranchRef.js';
import { runGit, GitRunError } from './gitRunner.js';
import { parseGitDiff, parseGitDiffs } from './diffParser.js';
import {
  buildCappedDiffData,
  CAPPED_DIFF_HARD_FILE_COUNT_GUARD,
  createDiffSummaryEntry,
  mapWithConcurrency,
  maxPatchLineBytes,
  parseNumstat,
  readBlobSizeMap,
  type ParsedNumstat,
  singleFileTooLargeReason,
} from './cappedDiff.js';
import type {
  DiffChangeKind,
  FileDiff,
  ReviewBranchBaseCandidate,
  ReviewBranchDiffData,
  ReviewBranchDiffWarning,
  ReviewDiffReadOptions,
  ReviewDiffSummaryEntry,
  ReviewScope,
} from './types.js';

const LARGE_TEXT_THRESHOLD_BYTES = Math.floor(4.4 * 1024 * 1024);
const TOO_LARGE_THRESHOLD_BYTES = 70 * 1024 * 1024;
const BRANCH_DIFF_MAX_FILE_COUNT = CAPPED_DIFF_HARD_FILE_COUNT_GUARD;
const BRANCH_DIFF_MAX_STDOUT_BYTES = 128 * 1024 * 1024;
const BRANCH_DIFF_IO_CONCURRENCY = 8;

interface BranchChange {
  path: string;
  oldPath: string | null;
  status: DiffChangeKind;
}

interface BranchComparison {
  baseRef: string;
  baseOid: string;
  headOid: string | null;
  mergeBaseOid: string | null;
  warning: ReviewBranchDiffWarning | null;
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

function warning(
  code: ReviewBranchDiffWarning['code'],
  message: string,
  extra: Omit<ReviewBranchDiffWarning, 'code' | 'message'> = {},
): ReviewBranchDiffWarning {
  return { code, message, ...extra };
}

function emptyBranchDiff(
  scope: ReviewScope,
  candidates: ReviewBranchBaseCandidate[],
  comparison: Partial<Pick<ReviewBranchDiffData, 'baseRef' | 'baseOid' | 'headOid' | 'mergeBaseOid'>>,
  branchWarning: ReviewBranchDiffWarning | null,
): ReviewBranchDiffData {
  return {
    scope,
    baseRef: comparison.baseRef ?? null,
    baseOid: comparison.baseOid ?? null,
    headOid: comparison.headOid ?? null,
    mergeBaseOid: comparison.mergeBaseOid ?? null,
    candidates,
    diffs: [],
    capped: null,
    warning: branchWarning,
  };
}

function emptyFileDiff(baseRef: string, change: BranchChange, patch: Partial<FileDiff>): FileDiff {
  return {
    id: `branch:${baseRef}:${change.path}`,
    source: 'branch',
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

export { isSafeBranchBaseRef } from '../../shared/reviewBranchRef.js';

async function gitAcceptsBranchRef(repoRoot: string, baseRef: string): Promise<boolean> {
  if (!isSafeBranchBaseRef(baseRef)) return false;
  try {
    await runGit(['check-ref-format', '--branch', baseRef], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

async function gitAcceptsFullRef(repoRoot: string, ref: string): Promise<boolean> {
  if (!ref.startsWith('refs/')) return false;
  try {
    await runGit(['check-ref-format', ref], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

async function resolveCommitRef(repoRoot: string, ref: string): Promise<string | null> {
  const valid = ref.startsWith('refs/')
    ? await gitAcceptsFullRef(repoRoot, ref)
    : await gitAcceptsBranchRef(repoRoot, ref);
  if (!valid) return null;
  try {
    const { stdout } = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repoRoot });
    const oid = stdout.trim();
    return /^[0-9a-f]{40,64}$/i.test(oid) ? oid : null;
  } catch {
    return null;
  }
}

export async function resolveBranchBaseCommitOid(repoRoot: string, baseRef: string, git: typeof runGit = runGit): Promise<string> {
  if (!isSafeBranchBaseRef(baseRef)) throw new Error('invalid branch base ref');
  await git(['check-ref-format', '--branch', baseRef], { cwd: repoRoot });
  const refs = [`refs/remotes/${baseRef}`, `refs/heads/${baseRef}`, baseRef];
  for (const ref of refs) {
    try {
      const { stdout } = await git(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: repoRoot });
      const oid = stdout.trim();
      if (/^[0-9a-f]{40,64}$/i.test(oid)) return oid;
    } catch {
      // Try the next spelling; remote refs win over same-name tags.
    }
  }
  throw new Error(`base branch is unavailable: ${baseRef}`);
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

async function maybeResolveRefName(repoRoot: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await runGit(args, { cwd: repoRoot });
    const ref = stdout.trim();
    return ref && isSafeBranchBaseRef(ref) ? ref : null;
  } catch {
    return null;
  }
}

function shortRefFromFullRef(fullRef: string, fallback: string): string {
  if (fullRef.startsWith('refs/heads/')) return fullRef.slice('refs/heads/'.length);
  if (fullRef.startsWith('refs/remotes/')) return fullRef.slice('refs/remotes/'.length);
  return fallback;
}

function normalizeRemoteRefName(refName: string | null): string | null {
  if (refName?.startsWith('refs/remotes/')) return refName.slice('refs/remotes/'.length);
  if (refName?.startsWith('remotes/')) return refName.slice('remotes/'.length);
  return refName;
}

async function readInitDefaultBranchName(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(['config', '--get', 'init.defaultBranch'], { cwd: repoRoot });
    const branchName = stdout.trim();
    if (!branchName || branchName === 'main' || branchName === 'master') return null;
    return isSafeBranchBaseRef(branchName) ? branchName : null;
  } catch {
    return null;
  }
}

function candidateRemote(refName: string, fullRef: string | null): string | null {
  if (fullRef?.startsWith('refs/remotes/')) return refName.split('/')[0] ?? null;
  return null;
}

async function resolveCandidateOid(
  repoRoot: string,
  input: {
    refName: string;
    kind: ReviewBranchBaseCandidate['kind'];
    fullRef?: string | null;
  },
): Promise<string | null> {
  const refs = [
    input.fullRef ?? null,
    input.kind === 'local' ? `refs/heads/${input.refName}` : null,
    input.kind === 'remote' || input.kind === 'remote-default' || input.kind === 'upstream'
      ? `refs/remotes/${input.refName}`
      : null,
    input.refName,
  ].filter((ref): ref is string => Boolean(ref));
  for (const ref of [...new Set(refs)]) {
    const oid = await resolveCommitRef(repoRoot, ref);
    if (oid) return oid;
  }
  return null;
}

async function addCandidate(
  repoRoot: string,
  map: Map<string, ReviewBranchBaseCandidate>,
  input: {
    refName: string | null;
    kind: ReviewBranchBaseCandidate['kind'];
    fullRef?: string | null;
    oid?: string | null;
  },
): Promise<void> {
  const refName = input.refName;
  if (!refName || map.has(refName) || !isSafeBranchBaseRef(refName)) return;
  const oid = input.oid ?? await resolveCandidateOid(repoRoot, {
    refName,
    kind: input.kind,
    fullRef: input.fullRef ?? null,
  });
  if (!oid) return;
  map.set(refName, {
    refName,
    shortName: refName,
    kind: input.kind,
    remote: candidateRemote(refName, input.fullRef ?? null),
    oid,
  });
}

async function readForEachRefCandidates(repoRoot: string): Promise<Array<{
  fullRef: string;
  refName: string;
  oid: string;
  kind: ReviewBranchBaseCandidate['kind'];
}>> {
  const { stdout } = await runGit([
    'for-each-ref',
    '--format=%(refname)%1f%(refname:short)%1f%(objectname)%00',
    'refs/heads',
    'refs/remotes',
  ], { cwd: repoRoot, maxStdoutBytes: BRANCH_DIFF_MAX_STDOUT_BYTES });
  return stdout
    .split('\0')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [fullRef = '', refName = '', oid = ''] = record.split('\x1f');
      const kind: ReviewBranchBaseCandidate['kind'] = fullRef.startsWith('refs/heads/') ? 'local' : 'remote';
      return { fullRef, refName: shortRefFromFullRef(fullRef, refName), oid, kind };
    })
    .filter((item) =>
      item.refName &&
      item.oid &&
      !item.fullRef.endsWith('/HEAD') &&
      !item.refName.endsWith('/HEAD'));
}

async function isAncestorCommit(repoRoot: string, ancestorOid: string, descendantOid: string): Promise<boolean> {
  try {
    const result = await runGit(['merge-base', '--is-ancestor', ancestorOid, descendantOid], {
      cwd: repoRoot,
      allowedExitCodes: [0, 1],
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function markStaleRiskCandidates(
  repoRoot: string,
  candidates: readonly ReviewBranchBaseCandidate[],
): Promise<ReviewBranchBaseCandidate[]> {
  const byRef = new Map(candidates.map((candidate) => [candidate.refName, candidate]));
  return mapWithConcurrency(candidates, BRANCH_DIFF_IO_CONCURRENCY, async (candidate) => {
    if (candidate.kind !== 'local') return candidate;
    const remote = byRef.get(`origin/${candidate.refName}`);
    if (!remote || remote.oid === candidate.oid) return candidate;
    const stale = await isAncestorCommit(repoRoot, candidate.oid, remote.oid);
    return stale ? { ...candidate, isStaleRisk: true } : candidate;
  });
}

function candidateSortPriority(candidate: ReviewBranchBaseCandidate, initDefaultBranchName: string | null): number {
  if (candidate.kind === 'remote-default') return 0;
  if (candidate.refName === 'origin/main') return 1;
  if (candidate.refName === 'origin/master') return 2;
  if (initDefaultBranchName && candidate.refName === `origin/${initDefaultBranchName}`) return 3;
  if (candidate.refName === 'main') return 4;
  if (candidate.refName === 'master') return 5;
  if (initDefaultBranchName && candidate.refName === initDefaultBranchName) return 6;
  if (candidate.kind === 'upstream') return 7;
  if (candidate.kind === 'local') return 8;
  return 9;
}

function sortCandidates(
  candidates: ReviewBranchBaseCandidate[],
  initDefaultBranchName: string | null,
): ReviewBranchBaseCandidate[] {
  return [...candidates].sort((a, b) => {
    const pa = candidateSortPriority(a, initDefaultBranchName);
    const pb = candidateSortPriority(b, initDefaultBranchName);
    if (pa !== pb) return pa - pb;
    return a.refName.localeCompare(b.refName);
  });
}

function isDefaultBranchCandidateRef(
  refName: string,
  initDefaultBranchName: string | null,
  remoteDefaultRef: string | null,
): boolean {
  return refName === remoteDefaultRef ||
    refName === 'origin/main' ||
    refName === 'origin/master' ||
    refName === 'main' ||
    refName === 'master' ||
    (initDefaultBranchName !== null && (refName === `origin/${initDefaultBranchName}` || refName === initDefaultBranchName));
}

async function markUpstreamCandidate(
  repoRoot: string,
  map: Map<string, ReviewBranchBaseCandidate>,
  upstreamRef: string | null,
  initDefaultBranchName: string | null,
  remoteDefaultRef: string | null,
): Promise<void> {
  if (!upstreamRef || isDefaultBranchCandidateRef(upstreamRef, initDefaultBranchName, remoteDefaultRef)) return;
  const existing = map.get(upstreamRef);
  if (existing) {
    map.set(upstreamRef, { ...existing, kind: 'upstream' });
    return;
  }
  await addCandidate(repoRoot, map, { refName: upstreamRef, kind: 'upstream' });
}

export async function listBranchBaseCandidates(scope: ReviewScope): Promise<ReviewBranchBaseCandidate[]> {
  if (!scope.repoRoot) return [];
  const candidates = new Map<string, ReviewBranchBaseCandidate>();
  const initDefaultBranchName = await readInitDefaultBranchName(scope.repoRoot);
  const upstream = normalizeRemoteRefName(await maybeResolveRefName(scope.repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']));

  const remoteDefault = normalizeRemoteRefName(await maybeResolveRefName(scope.repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']));
  await addCandidate(scope.repoRoot, candidates, { refName: remoteDefault, kind: 'remote-default', fullRef: 'refs/remotes/origin/HEAD' });

  const refs = await readForEachRefCandidates(scope.repoRoot);
  for (const item of refs) {
    const isCurrentLocal = item.kind === 'local' && scope.branch !== null && item.refName === scope.branch;
    if (isCurrentLocal) continue;
    await addCandidate(scope.repoRoot, candidates, item);
  }
  await markUpstreamCandidate(scope.repoRoot, candidates, upstream, initDefaultBranchName, remoteDefault);
  // Record which refs count as this repository's default. `init.defaultBranch`
  // is only readable here, so consumers cannot re-derive it from a ref name.
  for (const [refName, candidate] of candidates) {
    if (isDefaultBranchCandidateRef(refName, initDefaultBranchName, remoteDefault)) {
      candidates.set(refName, { ...candidate, isDefaultBranch: true });
    }
  }
  const withStaleRisk = await markStaleRiskCandidates(scope.repoRoot, Array.from(candidates.values()));
  return sortCandidates(withStaleRisk, initDefaultBranchName);
}

export function pickDefaultBranchBaseCandidate(
  candidates: readonly ReviewBranchBaseCandidate[],
  requestedBaseRef?: string | null,
): { candidate: ReviewBranchBaseCandidate | null; missingWarning: ReviewBranchDiffWarning | null } {
  if (requestedBaseRef) {
    const requested = candidates.find((candidate) => candidate.refName === requestedBaseRef);
    if (requested) return { candidate: requested, missingWarning: null };
  }
  const fallback = candidates.find((candidate) => candidate.kind !== 'upstream') ?? null;
  return {
    candidate: fallback,
    missingWarning: requestedBaseRef
      ? warning('base-missing', `Base branch '${requestedBaseRef}' is unavailable; using default base instead`, { requestedBaseRef })
      : null,
  };
}

async function resolveBranchComparison(
  repoRoot: string,
  candidates: readonly ReviewBranchBaseCandidate[],
  requestedBaseRef?: string | null,
): Promise<BranchComparison | null> {
  const { candidate, missingWarning } = pickDefaultBranchBaseCandidate(candidates, requestedBaseRef);
  if (!candidate) return null;
  const headOid = await resolveHeadCommit(repoRoot);
  if (!headOid) {
    return {
      baseRef: candidate.refName,
      baseOid: candidate.oid,
      headOid: null,
      mergeBaseOid: null,
      warning: warning('unborn', 'Current branch has no commits yet'),
    };
  }
  try {
    const { stdout } = await runGit(['merge-base', candidate.oid, headOid], { cwd: repoRoot });
    const mergeBaseOid = stdout.trim();
    return {
      baseRef: candidate.refName,
      baseOid: candidate.oid,
      headOid,
      mergeBaseOid: /^[0-9a-f]{40,64}$/i.test(mergeBaseOid) ? mergeBaseOid : null,
      warning: missingWarning,
    };
  } catch {
    return {
      baseRef: candidate.refName,
      baseOid: candidate.oid,
      headOid,
      mergeBaseOid: null,
      warning: warning('merge-base-missing', `No merge base found for ${candidate.refName} and HEAD`),
    };
  }
}

async function readChangedEntries(repoRoot: string, mergeBaseOid: string, headOid: string): Promise<BranchChange[]> {
  const { stdout } = await runGit(['diff', '--name-status', '-z', '-M', mergeBaseOid, headOid], {
    cwd: repoRoot,
    maxStdoutBytes: 32 * 1024 * 1024,
  });
  const parts = stdout.split('\0').filter(Boolean);
  const changes: BranchChange[] = [];
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

async function readBranchNumstat(
  repoRoot: string,
  comparison: BranchComparison,
  options: ReviewDiffReadOptions = {},
): Promise<Map<string, ParsedNumstat>> {
  if (!comparison.mergeBaseOid || !comparison.headOid) return new Map();
  try {
    const whitespaceArgs = options.ignoreWhitespace ? ['-w'] : [];
    const { stdout } = await runGit([
      'diff',
      ...whitespaceArgs,
      '--numstat',
      '-z',
      '-M',
      comparison.mergeBaseOid,
      comparison.headOid,
    ], { cwd: repoRoot, maxStdoutBytes: 32 * 1024 * 1024 });
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

async function classifyBranchChange(
  repoRoot: string,
  comparison: BranchComparison,
  change: BranchChange,
): Promise<Pick<FileDiff, 'kind' | 'size' | 'error'>> {
  const treeish = change.status === 'deleted' ? comparison.mergeBaseOid : comparison.headOid;
  const sizePath = change.status === 'deleted' ? change.oldPath ?? change.path : change.path;
  const size = await readBlobSize(repoRoot, treeish, sizePath);
  if (size !== null && size > TOO_LARGE_THRESHOLD_BYTES) {
    return { kind: 'too-large', size, error: 'File is too large to render' };
  }
  if (size !== null && size > LARGE_TEXT_THRESHOLD_BYTES) {
    return { kind: 'large-text', size, error: 'Large text diff is not rendered automatically' };
  }
  return { kind: 'text', size, error: null };
}

async function readBranchSummaryEntries(
  repoRoot: string,
  comparison: BranchComparison,
  changes: readonly BranchChange[],
  options: ReviewDiffReadOptions = {},
): Promise<ReviewDiffSummaryEntry[]> {
  const numstat = await readBranchNumstat(repoRoot, comparison, options);
  const sizeMap = await readBlobSizeMap(repoRoot, changes.map((change) => ({
    key: change.path,
    treeish: change.status === 'deleted' ? comparison.mergeBaseOid : comparison.headOid,
    gitPath: change.status === 'deleted' ? change.oldPath ?? change.path : change.path,
  })), BRANCH_DIFF_IO_CONCURRENCY);
  const entries = changes.flatMap((change) => {
    const stats = numstat.get(change.path);
    if (options.ignoreWhitespace && change.status === 'modified' && !stats) return [];
    const changedBytes = sizeMap.get(change.path) ?? 0;
    return [createDiffSummaryEntry({
      source: 'branch',
      idPrefix: comparison.baseRef,
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

async function readRawBranchDiff(
  repoRoot: string,
  comparison: BranchComparison,
  change: BranchChange,
  options: ReviewDiffReadOptions = {},
): Promise<string> {
  if (!comparison.mergeBaseOid || !comparison.headOid) return '';
  const pathspecs = [change.oldPath, change.path]
    .filter((p): p is string => Boolean(p))
    .map(literalPathspec);
  const whitespaceArgs = options.ignoreWhitespace ? ['-w'] : [];
  const { stdout } = await runGit([
    'diff',
    ...whitespaceArgs,
    '--no-ext-diff',
    '--patch-with-raw',
    '-z',
    '--no-color',
    '-M',
    comparison.mergeBaseOid,
    comparison.headOid,
    '--',
    ...pathspecs,
  ], { cwd: repoRoot, maxStdoutBytes: BRANCH_DIFF_MAX_STDOUT_BYTES });
  return stdout;
}

async function readRawBranchDiffs(
  repoRoot: string,
  comparison: BranchComparison,
  options: ReviewDiffReadOptions = {},
): Promise<string> {
  if (!comparison.mergeBaseOid || !comparison.headOid) return '';
  const whitespaceArgs = options.ignoreWhitespace ? ['-w'] : [];
  const { stdout } = await runGit([
    'diff',
    ...whitespaceArgs,
    '--no-ext-diff',
    '--patch-with-raw',
    '-z',
    '--no-color',
    '-M',
    comparison.mergeBaseOid,
    comparison.headOid,
  ], { cwd: repoRoot, maxStdoutBytes: BRANCH_DIFF_MAX_STDOUT_BYTES });
  return stdout;
}

function rawDiffIsBinary(raw: string): boolean {
  return /\nBinary files .+ differ\n?/.test(raw) || /\nGIT binary patch\n/.test(raw);
}

export async function readBranchDiff(
  scope: ReviewScope,
  requestedBaseRef?: string | null,
  options: ReviewDiffReadOptions = {},
): Promise<ReviewBranchDiffData> {
  if (scope.disabledReason || !scope.repoRoot) {
    return emptyBranchDiff(scope, [], {}, null);
  }
  const candidates = await listBranchBaseCandidates(scope);
  if (candidates.length === 0) {
    return emptyBranchDiff(scope, candidates, {}, warning('no-base-candidates', 'No base branch candidates found'));
  }
  const safeRequestedBaseRef = requestedBaseRef && isSafeBranchBaseRef(requestedBaseRef) ? requestedBaseRef : null;
  const comparison = await resolveBranchComparison(scope.repoRoot, candidates, safeRequestedBaseRef);
  if (!comparison) {
    return emptyBranchDiff(scope, candidates, {}, warning('no-base-candidates', 'No base branch candidates found'));
  }
  const comparisonFields = {
    baseRef: comparison.baseRef,
    baseOid: comparison.baseOid,
    headOid: comparison.headOid,
    mergeBaseOid: comparison.mergeBaseOid,
  };
  if (!comparison.headOid || !comparison.mergeBaseOid) {
    return emptyBranchDiff(scope, candidates, comparisonFields, comparison.warning);
  }

  const changes = await readChangedEntries(scope.repoRoot, comparison.mergeBaseOid, comparison.headOid);
  if (changes.length > BRANCH_DIFF_MAX_FILE_COUNT) {
    return emptyBranchDiff(scope, candidates, comparisonFields, warning('too-many-files', 'Branch diff has too many changed files to load', {
      fileCount: changes.length,
      limit: BRANCH_DIFF_MAX_FILE_COUNT,
    }));
  }
  const summaryEntries = await readBranchSummaryEntries(scope.repoRoot, comparison, changes, options);
  const capped = buildCappedDiffData(summaryEntries);
  if (capped) {
    return {
      scope,
      ...comparisonFields,
      candidates,
      diffs: [],
      capped,
      warning: comparison.warning,
    };
  }
  const parsedByPath = new Map<string, FileDiff>();
  try {
    for (const diff of parseGitDiffs(await readRawBranchDiffs(scope.repoRoot, comparison, options), {
      source: 'branch',
      idPrefix: comparison.baseRef,
      kind: 'text',
    })) {
      parsedByPath.set(diff.path, diff);
    }
  } catch {
    parsedByPath.clear();
  }
  const diffs: FileDiff[] = [];
  for (const change of changes) {
    const classification = await classifyBranchChange(scope.repoRoot, comparison, change);
    if (classification.kind !== 'text') {
      diffs.push(emptyFileDiff(comparison.baseRef, change, classification));
      continue;
    }
    try {
      const parsed = change.status === 'typechange' ? undefined : parsedByPath.get(change.path);
      const raw = parsed?.rawPatch ?? await readRawBranchDiff(scope.repoRoot, comparison, change, options);
      if (!raw.trim() || !raw.includes('diff --git')) {
        diffs.push(emptyFileDiff(comparison.baseRef, change, { kind: 'text', size: classification.size }));
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
        source: 'branch',
        idPrefix: comparison.baseRef,
        pathHint: change.path,
        oldPathHint: change.oldPath,
        kind: isBinary ? 'binary' : 'text',
        size: classification.size,
        error: isBinary ? 'Binary file' : null,
      }));
    } catch (err) {
      const message = err instanceof GitRunError ? err.stderr || err.message : err instanceof Error ? err.message : String(err);
      diffs.push(emptyFileDiff(comparison.baseRef, change, { kind: 'unrenderable', size: classification.size, error: message }));
    }
  }
  diffs.sort((a, b) => a.path.localeCompare(b.path));
  return {
    scope,
    ...comparisonFields,
    candidates,
    diffs,
    capped: null,
    warning: comparison.warning,
  };
}

function tooLargeBranchDiff(baseRef: string, change: BranchChange, size: number | null, reason: string): FileDiff {
  return emptyFileDiff(baseRef, change, {
    kind: 'too-large',
    size,
    error: reason,
  });
}

export async function readBranchFileDiff(
  scope: ReviewScope,
  requestedBaseRef: string | null,
  target: { path: string; oldPath: string | null },
  options: ReviewDiffReadOptions = {},
): Promise<FileDiff | null> {
  if (scope.disabledReason || !scope.repoRoot) return null;
  const candidates = await listBranchBaseCandidates(scope);
  const safeRequestedBaseRef = requestedBaseRef && isSafeBranchBaseRef(requestedBaseRef) ? requestedBaseRef : null;
  const comparison = await resolveBranchComparison(scope.repoRoot, candidates, safeRequestedBaseRef);
  if (!comparison?.headOid || !comparison.mergeBaseOid) return null;
  const changes = await readChangedEntries(scope.repoRoot, comparison.mergeBaseOid, comparison.headOid);
  const change = changes.find((item) =>
    item.path === target.path &&
    (target.oldPath === null || item.oldPath === target.oldPath));
  if (!change) return null;
  const summaryEntries = await readBranchSummaryEntries(scope.repoRoot, comparison, [change], options);
  const summary = summaryEntries[0] ?? null;
  const classification = await classifyBranchChange(scope.repoRoot, comparison, change);
  const changedBytes = summary?.changedBytes ?? classification.size ?? 0;
  const preReadTooLarge = singleFileTooLargeReason({
    changedLines: summary?.changedLines ?? 0,
    changedBytes,
  });
  if (preReadTooLarge) {
    return tooLargeBranchDiff(comparison.baseRef, change, changedBytes, `File is too large to render (${preReadTooLarge})`);
  }
  if (classification.kind !== 'text') {
    return emptyFileDiff(comparison.baseRef, change, classification);
  }
  try {
    const raw = await readRawBranchDiff(scope.repoRoot, comparison, change, options);
    if (!raw.trim() || !raw.includes('diff --git')) {
      return emptyFileDiff(comparison.baseRef, change, { kind: 'text', size: classification.size });
    }
    const isBinary = rawDiffIsBinary(raw);
    const parsed = parseGitDiff(raw, {
      source: 'branch',
      idPrefix: comparison.baseRef,
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
      return tooLargeBranchDiff(comparison.baseRef, change, parsed.size ?? changedBytes, `File is too large to render (${postReadTooLarge})`);
    }
    return parsed;
  } catch (err) {
    const message = err instanceof GitRunError ? err.stderr || err.message : err instanceof Error ? err.message : String(err);
    return emptyFileDiff(comparison.baseRef, change, { kind: 'unrenderable', size: classification.size, error: message });
  }
}
