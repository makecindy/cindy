/**
 * Per-file diff reader for git-review.
 *
 * M1 reads plain unified diffs and classifies files that should not be rendered
 * or partially selected by later M2 operations.
 */

import { runGit, GitRunError } from './gitRunner.js';
import { parseGitDiff, parseGitDiffs } from './diffParser.js';
import {
  lstatReviewWorktreePath,
  readReviewWorktreeFile,
  readReviewWorktreePrefix,
} from './reviewFileRunner.js';
import {
  buildCappedDiffData,
  createDiffSummaryEntry,
  mapWithConcurrency,
  maxPatchLineBytes,
  parseNumstat,
  readBlobSizeMap,
  readObjectSizeMap,
  type ParsedNumstat,
  singleFileTooLargeReason,
} from './cappedDiff.js';
import type { FileDiff, FileStatus, ReviewCappedDiffData, ReviewDiffReadOptions, ReviewDiffSummaryEntry, ReviewScope, ReviewStatus } from './types.js';

const LARGE_TEXT_THRESHOLD_BYTES = Math.floor(4.4 * 1024 * 1024);
const TOO_LARGE_THRESHOLD_BYTES = 70 * 1024 * 1024;
const BULK_DIFF_MAX_STDOUT_BYTES = 128 * 1024 * 1024;
const REVIEW_DIFF_IO_CONCURRENCY = 8;

export { mapWithConcurrency } from './cappedDiff.js';

function literalPathspec(gitPath: string): string {
  return `:(top,literal)${gitPath}`;
}

async function lstatWorktreePath(repoRoot: string, gitPath: string): Promise<{ size: number | null; isSymlink: boolean }> {
  try {
    return await lstatReviewWorktreePath(repoRoot, gitPath);
  } catch {
    return { size: null, isSymlink: false };
  }
}

async function statSize(repoRoot: string, gitPath: string): Promise<number | null> {
  return (await lstatWorktreePath(repoRoot, gitPath)).size;
}

async function hasNulByte(repoRoot: string, gitPath: string): Promise<boolean> {
  try {
    if ((await lstatWorktreePath(repoRoot, gitPath)).isSymlink) return false;
    return (await readReviewWorktreePrefix(repoRoot, gitPath, 8192)).includes(0);
  } catch {
    return false;
  }
}

async function isMergeBinary(repoRoot: string, gitPath: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(['check-attr', '-z', '--stdin', 'merge'], {
      cwd: repoRoot,
      stdin: `${gitPath}\0`,
      maxStdoutBytes: 1024 * 1024,
    });
    const parts = stdout.split('\0').filter(Boolean);
    return parts[1] === 'merge' && parts[2] === 'binary';
  } catch {
    return false;
  }
}

async function isBinaryByNumstat(repoRoot: string, source: 'staged' | 'unstaged', file: FileStatus): Promise<boolean> {
  try {
    const args = ['diff', '--numstat', '-z'];
    if (source === 'staged') args.push('--cached');
    args.push('--', literalPathspec(file.path));
    const { stdout } = await runGit(args, { cwd: repoRoot });
    return stdout.startsWith('-\t-');
  } catch {
    return false;
  }
}

async function bulkMergeBinaryPaths(repoRoot: string, files: readonly FileStatus[]): Promise<Set<string>> {
  if (files.length === 0) return new Set();
  try {
    const { stdout } = await runGit(['check-attr', '-z', '--stdin', 'merge'], {
      cwd: repoRoot,
      stdin: `${files.map((file) => file.path).join('\0')}\0`,
      maxStdoutBytes: Math.max(1024 * 1024, files.length * 256),
    });
    const parts = stdout.split('\0').filter(Boolean);
    const out = new Set<string>();
    for (let i = 0; i + 2 < parts.length; i += 3) {
      if (parts[i + 1] === 'merge' && parts[i + 2] === 'binary') out.add(parts[i]);
    }
    return out;
  } catch {
    return new Set();
  }
}

function parseBinaryNumstatPaths(stdout: string): Set<string> {
  const fields = stdout.split('\0').filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    const parts = field.split('\t');
    if (parts[0] !== '-' || parts[1] !== '-') continue;
    const inlinePath = parts.slice(2).join('\t');
    if (inlinePath) {
      out.add(inlinePath);
      continue;
    }
    const oldPath = fields[i + 1] ?? '';
    const newPath = fields[i + 2] ?? '';
    i += newPath ? 2 : oldPath ? 1 : 0;
    if (newPath || oldPath) out.add(newPath || oldPath);
  }
  return out;
}

async function bulkNumstatBinaryPaths(repoRoot: string, source: 'staged' | 'unstaged'): Promise<Set<string>> {
  try {
    const args = ['diff', '--numstat', '-z'];
    if (source === 'staged') args.push('--cached');
    const { stdout } = await runGit(args, { cwd: repoRoot, maxStdoutBytes: 32 * 1024 * 1024 });
    return parseBinaryNumstatPaths(stdout);
  } catch {
    return new Set();
  }
}

async function readNumstatMap(
  repoRoot: string,
  source: 'staged' | 'unstaged',
  options: ReviewDiffReadOptions = {},
): Promise<Map<string, ParsedNumstat>> {
  try {
    const whitespaceArgs = options.ignoreWhitespace ? ['-w'] : [];
    const args = ['diff', ...whitespaceArgs, '--numstat', '-z', '-M'];
    if (source === 'staged') args.push('--cached');
    const { stdout } = await runGit(args, { cwd: repoRoot, maxStdoutBytes: 32 * 1024 * 1024 });
    return parseNumstat(stdout);
  } catch {
    return new Map();
  }
}

function changeKind(file: FileStatus, source: 'staged' | 'unstaged'): FileDiff['status'] {
  if (file.isUntracked) return 'untracked';
  const status = source === 'unstaged'
    ? file.worktreeStatus ?? file.indexStatus
    : file.indexStatus ?? file.worktreeStatus;
  switch (status) {
    case 'added':
    case 'modified':
    case 'deleted':
    case 'renamed':
    case 'copied':
    case 'typechange':
      return status;
    default:
      return 'unknown';
  }
}

function emptyDiff(source: 'staged' | 'unstaged', file: FileStatus, patch: Partial<FileDiff>): FileDiff {
  return {
    id: `${source}:${file.path}`,
    source,
    path: file.path,
    oldPath: file.oldPath,
    status: changeKind(file, source),
    kind: patch.kind ?? 'unrenderable',
    size: patch.size ?? null,
    additions: 0,
    deletions: 0,
    isBinary: patch.kind === 'binary',
    isSubmodule: file.isSubmodule,
    isTooLarge: patch.kind === 'too-large',
    mode: { old: null, new: null },
    index: { oldOid: null, newOid: null },
    rawHeader: '',
    rawPatch: '',
    hunks: [],
    error: patch.error ?? null,
  };
}

async function classify(
  repoRoot: string,
  source: 'staged' | 'unstaged',
  file: FileStatus,
): Promise<Pick<FileDiff, 'kind' | 'size' | 'error'>> {
  if (file.isSubmodule) return { kind: 'submodule', size: null, error: 'Submodule diff is not rendered in M1' };
  const sizeMap = await readClassificationSizeMap(repoRoot, source, [file]);
  const size = sizeMap.get(file.path) ?? null;
  // Match image/markdown preview semantics: exactly-at-limit still loads; one
  // byte over the limit is too large.
  if (size !== null && size > TOO_LARGE_THRESHOLD_BYTES) {
    return { kind: 'too-large', size, error: 'File is too large to render' };
  }
  if (await isMergeBinary(repoRoot, file.path)) return { kind: 'binary', size, error: 'Binary file' };
  if (await isBinaryByNumstat(repoRoot, source, file)) return { kind: 'binary', size, error: 'Binary file' };
  if (source === 'unstaged' && (await hasNulByte(repoRoot, file.path))) {
    return { kind: 'binary', size, error: 'Binary file' };
  }
  if (size !== null && size > LARGE_TEXT_THRESHOLD_BYTES) {
    return { kind: 'large-text', size, error: 'Large text diff is not rendered automatically in M1' };
  }
  return { kind: 'text', size, error: null };
}

async function classifyMany(
  repoRoot: string,
  source: 'staged' | 'unstaged',
  files: readonly FileStatus[],
): Promise<Map<string, Pick<FileDiff, 'kind' | 'size' | 'error'>>> {
  const [mergeBinary, numstatBinary, sizeMap] = await Promise.all([
    bulkMergeBinaryPaths(repoRoot, files),
    bulkNumstatBinaryPaths(repoRoot, source),
    readClassificationSizeMap(repoRoot, source, files),
  ]);
  const out = new Map<string, Pick<FileDiff, 'kind' | 'size' | 'error'>>();
  await mapWithConcurrency(files, REVIEW_DIFF_IO_CONCURRENCY, async (file) => {
    if (file.isSubmodule) {
      out.set(file.path, { kind: 'submodule', size: null, error: 'Submodule diff is not rendered in M1' });
      return;
    }
    const size = sizeMap.get(file.path) ?? null;
    if (size !== null && size > TOO_LARGE_THRESHOLD_BYTES) {
      out.set(file.path, { kind: 'too-large', size, error: 'File is too large to render' });
      return;
    }
    if (mergeBinary.has(file.path) || numstatBinary.has(file.path)) {
      out.set(file.path, { kind: 'binary', size, error: 'Binary file' });
      return;
    }
    if (source === 'unstaged' && await hasNulByte(repoRoot, file.path)) {
      out.set(file.path, { kind: 'binary', size, error: 'Binary file' });
      return;
    }
    if (size !== null && size > LARGE_TEXT_THRESHOLD_BYTES) {
      out.set(file.path, { kind: 'large-text', size, error: 'Large text diff is not rendered automatically in M1' });
      return;
    }
    out.set(file.path, { kind: 'text', size, error: null });
  });
  return out;
}

async function countUntrackedTextLines(repoRoot: string, gitPath: string, size: number | null): Promise<number> {
  if (size === null || size > 3 * 1024 * 1024) return 0;
  try {
    if ((await lstatWorktreePath(repoRoot, gitPath)).isSymlink) return 0;
    const content = await readReviewWorktreeFile(repoRoot, gitPath, 3 * 1024 * 1024);
    if (content.includes(0)) return 0;
    if (content.length === 0) return 0;
    let lines = 0;
    for (const byte of content) {
      if (byte === 10) lines += 1;
    }
    return content[content.length - 1] === 10 ? lines : lines + 1;
  } catch {
    return 0;
  }
}

function parseLsFilesStageRecord(record: string): { oid: string; path: string } | null {
  const tab = record.indexOf('\t');
  if (tab < 0) return null;
  const meta = record.slice(0, tab).trim().split(/\s+/);
  const oid = meta[1] ?? '';
  const filePath = record.slice(tab + 1);
  return /^[0-9a-f]{4,64}$/iu.test(oid) && filePath ? { oid, path: filePath } : null;
}

async function readIndexBlobSize(repoRoot: string, gitPath: string): Promise<number | null> {
  try {
    const { stdout } = await runGit(['ls-files', '-s', '-z', '--', literalPathspec(gitPath)], {
      cwd: repoRoot,
      maxStdoutBytes: 1024 * 1024,
    });
    const record = stdout.split('\0').find(Boolean);
    const oid = record ? parseLsFilesStageRecord(record)?.oid ?? null : null;
    if (!oid) return null;
    const { stdout: sizeOut } = await runGit(['cat-file', '-s', '--end-of-options', oid], { cwd: repoRoot });
    const size = Number(sizeOut.trim());
    return Number.isFinite(size) ? size : null;
  } catch {
    return null;
  }
}

async function readIndexBlobSizeMap(repoRoot: string, files: readonly FileStatus[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const pathspecs = files
    .map((file) => file.path)
    .filter((gitPath) => !gitPath.includes('\n') && !gitPath.includes('\r'))
    .map(literalPathspec);
  if (pathspecs.length > 0) {
    try {
      const { stdout } = await runGit(['ls-files', '-s', '-z', '--', ...pathspecs], {
        cwd: repoRoot,
        maxStdoutBytes: Math.max(1024 * 1024, pathspecs.length * 256),
      });
      const records = stdout.split('\0').filter(Boolean);
      const oidByPath = new Map<string, string>();
      for (const record of records) {
        const parsed = parseLsFilesStageRecord(record);
        if (parsed) oidByPath.set(parsed.path, parsed.oid);
      }
      const batchSizes = await readObjectSizeMap(repoRoot, files.map((file) => ({
        key: file.path,
        objectName: oidByPath.get(file.path) ?? null,
      })), REVIEW_DIFF_IO_CONCURRENCY);
      for (const [key, size] of batchSizes) out.set(key, size);
    } catch {
      // Fall through to single-path lookups for any missing entries.
    }
  }
  await mapWithConcurrency(files.filter((file) => !out.has(file.path)), REVIEW_DIFF_IO_CONCURRENCY, async (file) => {
    const size = await readIndexBlobSize(repoRoot, file.path);
    if (size !== null) out.set(file.path, size);
  });
  return out;
}

async function readWorktreeStatSizeMap(repoRoot: string, files: readonly FileStatus[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await mapWithConcurrency(files, REVIEW_DIFF_IO_CONCURRENCY, async (file) => {
    const size = await statSize(repoRoot, file.path);
    if (size !== null) out.set(file.path, size);
  });
  return out;
}

async function readClassificationSizeMap(
  repoRoot: string,
  source: 'staged' | 'unstaged',
  files: readonly FileStatus[],
): Promise<Map<string, number>> {
  return source === 'staged'
    ? readIndexBlobSizeMap(repoRoot, files)
    : readWorktreeStatSizeMap(repoRoot, files);
}

async function readChangedBytesMap(
  repoRoot: string,
  source: 'staged' | 'unstaged',
  files: readonly FileStatus[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (files.length === 0) return out;
  if (source === 'staged') {
    const indexSizeMap = await readIndexBlobSizeMap(repoRoot, files);
    for (const [key, size] of indexSizeMap) out.set(key, size);
    const fallback = files.filter((file) => !out.has(file.path));
    const headSizeMap = await readBlobSizeMap(repoRoot, fallback.map((file) => ({
      key: file.path,
      treeish: 'HEAD',
      gitPath: file.oldPath ?? file.path,
    })), REVIEW_DIFF_IO_CONCURRENCY);
    for (const [key, size] of headSizeMap) out.set(key, size);
    return out;
  }
  const worktreeSizeMap = await readWorktreeStatSizeMap(repoRoot, files);
  for (const [key, size] of worktreeSizeMap) out.set(key, size);
  const fallback = files.filter((file) => !out.has(file.path));
  const headSizeMap = await readBlobSizeMap(repoRoot, fallback.map((file) => ({
    key: file.path,
    treeish: 'HEAD',
    gitPath: file.oldPath ?? file.path,
  })), REVIEW_DIFF_IO_CONCURRENCY);
  for (const [key, size] of headSizeMap) out.set(key, size);
  return out;
}

export async function readDiffSummaryEntries(
  scope: ReviewScope,
  status: ReviewStatus,
  source: 'staged' | 'unstaged',
  options: ReviewDiffReadOptions = {},
  filesOverride?: readonly FileStatus[],
): Promise<ReviewDiffSummaryEntry[]> {
  if (!scope.repoRoot) return [];
  const files = (filesOverride ?? status.files).filter((file) => file.sources.includes(source));
  if (files.length === 0) return [];
  const numstat = await readNumstatMap(scope.repoRoot, source, options);
  const changedBytesMap = await readChangedBytesMap(scope.repoRoot, source, files);
  const entries = await mapWithConcurrency(files, REVIEW_DIFF_IO_CONCURRENCY, async (file) => {
    const stats = numstat.get(file.path);
    if (options.ignoreWhitespace && changeKind(file, source) === 'modified' && !stats) return null;
    const changedBytes = changedBytesMap.get(file.path) ?? 0;
    const untrackedLines = file.isUntracked
      ? await countUntrackedTextLines(scope.repoRoot!, file.path, changedBytes)
      : 0;
    return createDiffSummaryEntry({
      source,
      path: file.path,
      oldPath: file.oldPath,
      status: changeKind(file, source),
      additions: stats?.additions ?? (file.isUntracked ? untrackedLines : 0),
      deletions: stats?.deletions ?? 0,
      changedBytes,
      isBinary: stats?.isBinary ?? false,
      isSubmodule: file.isSubmodule,
    });
  });
  return entries
    .filter((entry): entry is ReviewDiffSummaryEntry => entry !== null)
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function readRawDiff(
  repoRoot: string,
  source: 'staged' | 'unstaged',
  file: FileStatus,
  options: ReviewDiffReadOptions = {},
): Promise<string> {
  const whitespaceArgs = options.ignoreWhitespace ? ['-w'] : [];
  if (file.isUntracked) {
    const { stdout } = await runGit(
      ['diff', ...whitespaceArgs, '--no-ext-diff', '--patch-with-raw', '-z', '--no-color', '--no-index', '--', '/dev/null', file.path],
      { cwd: repoRoot, allowedExitCodes: [0, 1], maxStdoutBytes: BULK_DIFF_MAX_STDOUT_BYTES },
    );
    return stdout;
  }

  const args = ['diff', ...whitespaceArgs, '--no-ext-diff', '--patch-with-raw', '-z', '--no-color', '-M'];
  if (source === 'staged') args.push('--cached');
  args.push('--', ...[file.oldPath, file.path].filter((p): p is string => Boolean(p)).map(literalPathspec));
  const { stdout } = await runGit(args, { cwd: repoRoot, maxStdoutBytes: BULK_DIFF_MAX_STDOUT_BYTES });
  return stdout;
}

async function readRawDiffs(
  repoRoot: string,
  source: 'staged' | 'unstaged',
  options: ReviewDiffReadOptions = {},
): Promise<string> {
  const whitespaceArgs = options.ignoreWhitespace ? ['-w'] : [];
  const args = ['diff', ...whitespaceArgs, '--no-ext-diff', '--patch-with-raw', '-z', '--no-color', '-M'];
  if (source === 'staged') args.push('--cached');
  const { stdout } = await runGit(args, { cwd: repoRoot, maxStdoutBytes: BULK_DIFF_MAX_STDOUT_BYTES });
  return stdout;
}

function rawDiffIsBinary(raw: string): boolean {
  return /\nBinary files .+ differ\n?/.test(raw) || /\nGIT binary patch\n/.test(raw);
}

async function readTrackedDiffs(
  scope: ReviewScope,
  source: 'staged' | 'unstaged',
  files: readonly FileStatus[],
  options: ReviewDiffReadOptions,
): Promise<FileDiff[]> {
  if (!scope.repoRoot || files.length === 0) return [];
  const classifications = await classifyMany(scope.repoRoot, source, files);
  let parsedByPath: Map<string, FileDiff>;
  try {
    const raw = await readRawDiffs(scope.repoRoot, source, options);
    parsedByPath = new Map(parseGitDiffs(raw, { source, kind: 'text' }).map((diff) => [diff.path, diff]));
  } catch {
    const fallback: FileDiff[] = [];
    for (const file of files) fallback.push(await readFileDiff(scope, source, file, options));
    return fallback;
  }

  const diffs: FileDiff[] = [];
  for (const file of files) {
    if (changeKind(file, source) === 'typechange') {
      diffs.push(await readFileDiff(scope, source, file, options));
      continue;
    }
    const classification = classifications.get(file.path) ?? { kind: 'text' as const, size: null, error: null };
    if (classification.kind !== 'text') {
      diffs.push(emptyDiff(source, file, classification));
      continue;
    }
    const parsed = parsedByPath.get(file.path);
    if (!parsed || !parsed.rawPatch.trim() || !parsed.rawPatch.includes('diff --git')) {
      diffs.push(emptyDiff(source, file, { kind: 'text', size: classification.size }));
      continue;
    }
    const isBinary = rawDiffIsBinary(parsed.rawPatch);
    diffs.push({
      ...parsed,
      oldPath: file.oldPath ?? parsed.oldPath,
      status: parsed.status === 'unknown' ? changeKind(file, source) : parsed.status,
      kind: isBinary ? 'binary' : 'text',
      size: classification.size,
      isBinary,
      error: isBinary ? 'Binary file' : null,
    });
  }
  return diffs;
}

export async function readFileDiff(
  scope: ReviewScope,
  source: 'staged' | 'unstaged',
  file: FileStatus,
  options: ReviewDiffReadOptions = {},
): Promise<FileDiff> {
  if (!scope.repoRoot) return emptyDiff(source, file, { kind: 'unrenderable', error: 'No git repository' });
  const classification = await classify(scope.repoRoot, source, file);
  if (classification.kind !== 'text') {
    return emptyDiff(source, file, classification);
  }
  try {
    const raw = await readRawDiff(scope.repoRoot, source, file, options);
    if (!raw.trim() || !raw.includes('diff --git')) {
      return emptyDiff(source, file, { kind: 'text', size: classification.size });
    }
    return parseGitDiff(raw, {
      source,
      pathHint: file.path,
      oldPathHint: file.oldPath,
      kind: 'text',
      size: classification.size,
      isSubmodule: file.isSubmodule,
      isUntracked: file.isUntracked,
    });
  } catch (err) {
    const message = err instanceof GitRunError ? err.stderr || err.message : err instanceof Error ? err.message : String(err);
    return emptyDiff(source, file, { kind: 'unrenderable', size: classification.size, error: message });
  }
}

function tooLargeDiff(source: 'staged' | 'unstaged', file: FileStatus, size: number | null, reason: string): FileDiff {
  return emptyDiff(source, file, {
    kind: 'too-large',
    size,
    error: reason,
  });
}

export async function readCappedFileDiff(
  scope: ReviewScope,
  status: ReviewStatus,
  source: 'staged' | 'unstaged',
  target: { path: string; oldPath: string | null },
  options: ReviewDiffReadOptions = {},
): Promise<FileDiff | null> {
  if (!scope.repoRoot) return null;
  const file = status.files.find((item) =>
    item.sources.includes(source) &&
    item.path === target.path &&
    (target.oldPath === null || item.oldPath === target.oldPath));
  if (!file) return null;
  const summaries = await readDiffSummaryEntries(scope, status, source, options, [file]);
  const summary = summaries.find((item) => item.path === file.path);
  const changedBytes = summary?.changedBytes ?? 0;
  const preReadTooLarge = singleFileTooLargeReason({
    changedLines: summary?.changedLines ?? 0,
    changedBytes,
  });
  if (preReadTooLarge) {
    return tooLargeDiff(source, file, changedBytes, `File is too large to render (${preReadTooLarge})`);
  }
  const diff = await readFileDiff(scope, source, file, options);
  const maxLineBytes = maxPatchLineBytes(diff.rawPatch);
  const postReadTooLarge = singleFileTooLargeReason({
    changedLines: diff.additions + diff.deletions,
    changedBytes: diff.size ?? changedBytes,
    maxLineBytes,
  });
  if (postReadTooLarge) {
    return tooLargeDiff(source, file, diff.size ?? changedBytes, `File is too large to render (${postReadTooLarge})`);
  }
  return diff;
}

export async function readDiffs(
  scope: ReviewScope,
  status: ReviewStatus,
  options: ReviewDiffReadOptions = {},
): Promise<{ staged: FileDiff[]; unstaged: FileDiff[]; capped?: { staged: ReviewCappedDiffData | null; unstaged: ReviewCappedDiffData | null } }> {
  const stagedFiles = status.files.filter((file) => file.sources.includes('staged'));
  const unstagedFiles = status.files.filter((file) => file.sources.includes('unstaged'));
  const [stagedSummary, unstagedSummary] = await Promise.all([
    readDiffSummaryEntries(scope, status, 'staged', options),
    readDiffSummaryEntries(scope, status, 'unstaged', options),
  ]);
  const capped = {
    staged: buildCappedDiffData(stagedSummary),
    unstaged: buildCappedDiffData(unstagedSummary),
  };
  const [staged, trackedUnstaged] = await Promise.all([
    capped.staged ? Promise.resolve([]) : readTrackedDiffs(scope, 'staged', stagedFiles.filter((file) => !file.isUntracked), options),
    capped.unstaged ? Promise.resolve([]) : readTrackedDiffs(scope, 'unstaged', unstagedFiles.filter((file) => !file.isUntracked), options),
  ]);
  const untracked = capped.unstaged
    ? []
    : await mapWithConcurrency(
      unstagedFiles.filter((file) => file.isUntracked),
      REVIEW_DIFF_IO_CONCURRENCY,
      (file) => readFileDiff(scope, 'unstaged', file, options),
    );
  const unstaged = trackedUnstaged.concat(untracked);
  staged.sort((a, b) => a.path.localeCompare(b.path));
  unstaged.sort((a, b) => a.path.localeCompare(b.path));
  return { staged, unstaged, capped };
}
