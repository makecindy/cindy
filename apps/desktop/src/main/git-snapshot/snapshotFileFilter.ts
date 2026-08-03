import { promises as fs } from 'node:fs';
import path from 'node:path';

import { detectSensitivePath } from '../security/sensitivePath';
import { gitExec, GitExecError } from '../worktree/gitExec';

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_CONTENT_SCAN_BYTES = DEFAULT_MAX_FILE_BYTES;

/** Reason a dirty file is excluded from an automatic snapshot commit. */
export type SnapshotSkippedFileReason =
  | 'large-file'
  | 'ignored-os-metadata'
  | 'sensitive-path'
  | 'sensitive-content'
  | 'sensitive-diff'
  | 'nested-git-repo'
  | 'scan-failed'
  | 'conflict';

/** A file intentionally left out of a snapshot commit. */
export interface SnapshotSkippedFile {
  path: string;
  oldPath?: string;
  reason: SnapshotSkippedFileReason;
  sizeBytes?: number;
  detector?: string;
  /** Literal Git pathspecs. Do not pass raw paths to staging commands. */
  pathsForPathspec?: string[];
}

/** A file group that can be safely staged and committed. */
export interface SnapshotIncludedFile {
  path: string;
  oldPath?: string;
  /** Literal Git pathspecs. Do not pass raw paths to staging commands. */
  pathsForPathspec: string[];
}

/** Tunable limits for snapshot safety filtering. */
export interface SnapshotFileFilterOptions {
  maxFileBytes: number;
  maxContentScanBytes: number;
}

/** A parsed `git status --porcelain=v1 -z` entry. */
export interface SnapshotStatusEntry {
  code: string;
  path: string;
  oldPath?: string;
}

/** The full safe/unsafe plan for the current dirty worktree. */
export interface SnapshotFilePlan {
  includedFiles: SnapshotIncludedFile[];
  skippedFiles: SnapshotSkippedFile[];
  /**
   * `git status` output overflowed the exec buffer: the dirty-file view is
   * unknown, not empty. Legacy branch-commit snapshots keep their historical
   * "degrade to no-op" behavior, but shadow savepoint consumers must fail
   * closed — an empty plan here would record a baseline that silently misses
   * every dirty file and let readers treat unprotected paths as safe.
   */
  statusTruncated?: true;
}

function withDefaults(opts?: Partial<SnapshotFileFilterOptions>): SnapshotFileFilterOptions {
  return {
    maxFileBytes: opts?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxContentScanBytes: opts?.maxContentScanBytes ?? DEFAULT_MAX_CONTENT_SCAN_BYTES,
  };
}

const IGNORED_OS_METADATA_BASENAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

function normalizeGitPath(gitPath: string): string | null {
  const normalized = gitPath;
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    return null;
  }

  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

function toLiteralPathspec(gitPath: string): string {
  return `:(literal)${gitPath}`;
}

/** Resolves a Git path only when it stays inside the repository root. */
export function resolveSnapshotGitPath(repoPath: string, gitPath: string): string | null {
  const normalized = normalizeGitPath(gitPath);
  if (!normalized) return null;

  const repoRoot = path.resolve(repoPath);
  const abs = path.resolve(repoRoot, ...normalized.split('/'));
  const rel = path.relative(repoRoot, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

/** Returns a detector name when a path is too sensitive for automatic snapshots. */
export function detectSensitiveSnapshotPath(gitPath: string): string | null {
  return detectSensitivePath(gitPath, { allowEnvTemplates: true });
}

function hasConflictStatus(code: string): boolean {
  return code.includes('U') || code === 'AA' || code === 'DD';
}

function rawPathsFor(entry: SnapshotStatusEntry): string[] {
  return entry.oldPath ? [entry.oldPath, entry.path] : [entry.path];
}

function basenameForGitPath(gitPath: string): string {
  const parts = gitPath.split(/[\\/]/);
  return parts[parts.length - 1] ?? gitPath;
}

function isIgnoredOsMetadataPath(gitPath: string): boolean {
  return IGNORED_OS_METADATA_BASENAMES.has(basenameForGitPath(gitPath));
}

function pathspecPathsFor(entry: SnapshotStatusEntry): string[] {
  return [toLiteralPathspec(entry.path)];
}

/** Parses `git status --porcelain=v1 -z` output into status entries. */
export function parseStatusPorcelainZ(output: string): SnapshotStatusEntry[] {
  const parts = output.split('\0').filter((part) => part.length > 0);
  const entries: SnapshotStatusEntry[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part.length < 4) continue;

    const code = part.slice(0, 2);
    const filePath = part.slice(3);
    if (!filePath) continue;

    if (code[0] === 'R' || code[0] === 'C') {
      const oldPath = parts[i + 1];
      if (oldPath) {
        entries.push({ code, path: filePath, oldPath });
        i += 1;
        continue;
      }
    }

    entries.push({ code, path: filePath });
  }
  return entries;
}

async function readStatusEntries(
  repoPath: string,
): Promise<{ entries: SnapshotStatusEntry[]; truncated: boolean }> {
  try {
    const { stdout } = await gitExec(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      repoPath,
    );
    return { entries: parseStatusPorcelainZ(stdout), truncated: false };
  } catch (err) {
    if (isGitStatusOutputTooLargeError(err)) return { entries: [], truncated: true };
    throw err;
  }
}

function isGitStatusOutputTooLargeError(err: unknown): boolean {
  if (!(err instanceof GitExecError)) return false;
  return err.cause?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(err.message);
}

async function hasGitMarker(dir: string): Promise<boolean> {
  return fs.lstat(path.join(dir, '.git')).then(
    () => true,
    () => false,
  );
}

async function isInsideNestedGitRepo(repoPath: string, gitPath: string): Promise<boolean> {
  const abs = resolveSnapshotGitPath(repoPath, gitPath);
  if (!abs) return false;

  let stat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
  try {
    stat = await fs.lstat(abs);
  } catch {
    stat = null;
  }

  const repoRoot = path.resolve(repoPath);
  let cur = stat?.isDirectory() ? abs : path.dirname(abs);
  while (path.resolve(cur) !== repoRoot) {
    const rel = path.relative(repoRoot, cur);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    if (await hasGitMarker(cur)) return true;

    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
  return false;
}

async function scanWorktreeFileSize(
  repoPath: string,
  gitPath: string,
  opts: SnapshotFileFilterOptions,
): Promise<SnapshotSkippedFile | null> {
  const abs = resolveSnapshotGitPath(repoPath, gitPath);
  if (!abs) {
    return { path: gitPath, reason: 'scan-failed', detector: 'path-traversal' };
  }

  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    return { path: gitPath, reason: 'scan-failed' };
  }

  if (!stat.isFile()) return null;
  if (stat.size > opts.maxFileBytes) {
    return { path: gitPath, reason: 'large-file', sizeBytes: stat.size };
  }
  return null;
}

async function classifyEntry(
  repoPath: string,
  entry: SnapshotStatusEntry,
  opts: SnapshotFileFilterOptions,
): Promise<SnapshotSkippedFile | null> {
  if (hasConflictStatus(entry.code)) return { path: entry.path, reason: 'conflict' };

  for (const gitPath of rawPathsFor(entry)) {
    if (!resolveSnapshotGitPath(repoPath, gitPath)) {
      return { path: entry.path, reason: 'scan-failed', detector: 'path-traversal' };
    }

    if (isIgnoredOsMetadataPath(gitPath)) {
      return {
        path: entry.path,
        reason: 'ignored-os-metadata',
        detector: basenameForGitPath(gitPath),
      };
    }

    const detector = detectSensitiveSnapshotPath(gitPath);
    if (detector) return { path: entry.path, reason: 'sensitive-path', detector };
  }

  for (const gitPath of rawPathsFor(entry)) {
    if (await isInsideNestedGitRepo(repoPath, gitPath)) {
      return { path: entry.path, reason: 'nested-git-repo' };
    }
  }

  return scanWorktreeFileSize(repoPath, entry.path, opts);
}

/** Builds a safe/unsafe file plan from already parsed status entries. */
export async function buildSnapshotFilePlanFromEntries(
  repoPath: string,
  entries: readonly SnapshotStatusEntry[],
  opts?: Partial<SnapshotFileFilterOptions>,
): Promise<SnapshotFilePlan> {
  const options = withDefaults(opts);
  const includedFiles: SnapshotIncludedFile[] = [];
  const skippedFiles: SnapshotSkippedFile[] = [];

  for (const entry of entries) {
    const pathsForPathspec = pathspecPathsFor(entry);
    const oldPath = entry.oldPath && entry.code[0] === 'R' ? { oldPath: entry.oldPath } : {};
    const skip = await classifyEntry(repoPath, entry, options);
    if (skip) {
      skippedFiles.push({ ...skip, ...oldPath, pathsForPathspec });
      continue;
    }

    includedFiles.push({ path: entry.path, ...oldPath, pathsForPathspec });
  }

  return { includedFiles, skippedFiles };
}

/** Builds a conservative safe/unsafe file plan for the current worktree. */
export async function buildSnapshotFilePlan(
  repoPath: string,
  opts?: Partial<SnapshotFileFilterOptions>,
): Promise<SnapshotFilePlan> {
  const { entries, truncated } = await readStatusEntries(repoPath);
  const plan = await buildSnapshotFilePlanFromEntries(repoPath, entries, opts);
  return truncated ? { ...plan, statusTruncated: true } : plan;
}
