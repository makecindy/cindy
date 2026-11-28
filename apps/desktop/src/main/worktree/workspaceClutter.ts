/** Fast, strictly read-only local metadata probe for branch & worktree clutter. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  computeWorkspaceClutterTier,
  type WorkspaceClutterSummary,
} from '../../shared/worktreeWorkspaceClutter';
import { getDbClient } from '../localDb/client/current';
import { gitExec } from './gitExec';
import { listRecycleRecords } from './recycleJournal';

export interface WorkspaceClutterDeps {
  gitExec?: typeof gitExec;
  readActiveWorktreePaths?: () => Promise<string[]>;
  listFailedRecyclePaths?: () => Promise<string[]>;
  realpath?: (p: string) => Promise<string>;
}

const CINDY_BRANCH_PATTERN = /^(?:cindy|xdt)\//;
const MAX_PROTECTED_PATHS_IN_SUMMARY = 100;
const REALPATH_CONCURRENCY = 16;

async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function safeRealpath(
  target: string,
  realpathFn: (p: string) => Promise<string>,
): Promise<string> {
  try {
    return await realpathFn(target);
  } catch {
    return path.resolve(target);
  }
}

function normalizePathKey(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function parseLinkedWorktreePaths(porcelain: string, repoRootKey: string): string[] {
  const paths: string[] = [];
  for (const rawLine of porcelain.split(/\r?\n/)) {
    if (!rawLine.startsWith('worktree ')) continue;
    const wtPath = rawLine.slice('worktree '.length).trim();
    if (!wtPath) continue;
    if (normalizePathKey(wtPath) === repoRootKey) continue;
    paths.push(wtPath);
  }
  return paths;
}

async function defaultReadActiveWorktreePaths(): Promise<string[]> {
  const db = getDbClient();
  if (!db.readLocalWorktreeReferences) throw new Error('Active worktree references unavailable');
  const refs = await db.readLocalWorktreeReferences();
  const out: string[] = [];
  for (const ref of refs) {
    // Terminal archived/deleted sessions are not live; null/unknown status stays protected (fail-closed).
    if (ref.status === 'archived' || ref.status === 'deleted') continue;
    if (ref.worktreePath) out.push(ref.worktreePath);
    if (ref.workingDir) out.push(ref.workingDir);
  }
  return out;
}

async function defaultListFailedRecyclePaths(): Promise<string[]> {
  try {
    const records = await listRecycleRecords();
    return records
      .filter(
        (record) =>
          !['removed', 'restoring', 'restored'].includes(record.phase) &&
          !record.meta.ephemeral &&
          record.retryPolicy?.state !== 'kept' &&
          (record.attempts > 0 || !!record.reason),
      )
      .map((record) => record.meta.path);
  } catch {
    return [];
  }
}

export async function readWorkspaceClutterSummary(
  baseRepo: string,
  deps?: WorkspaceClutterDeps,
): Promise<WorkspaceClutterSummary> {
  const exec = deps?.gitExec ?? gitExec;
  const realpathFn = deps?.realpath ?? ((p: string) => fs.realpath(p));
  const readActive = deps?.readActiveWorktreePaths ?? defaultReadActiveWorktreePaths;
  const readFailedRecycles = deps?.listFailedRecyclePaths ?? defaultListFailedRecyclePaths;

  const physicalRepo = await safeRealpath(baseRepo, realpathFn);
  const repoRootKey = normalizePathKey(physicalRepo);

  const [branchesRes, worktreesRes, activePathsRaw, failedRecyclePathsRaw] = await Promise.all([
    exec(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], physicalRepo, {
      timeoutMs: 5_000,
    }),
    exec(['worktree', 'list', '--porcelain'], physicalRepo, {
      timeoutMs: 5_000,
    }),
    readActive(),
    readFailedRecycles(),
  ]);

  const branchNames = branchesRes.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const localBranchCount = branchNames.length;
  const cindyBranchCount = branchNames.filter((name) => CINDY_BRANCH_PATTERN.test(name)).length;

  const rawLinkedPaths = parseLinkedWorktreePaths(worktreesRes.stdout, repoRootKey);
  const linkedEntries = await mapBounded(
    [...new Set(rawLinkedPaths)],
    REALPATH_CONCURRENCY,
    async (raw) => {
      const physical = await safeRealpath(raw, realpathFn);
      return { raw, physical, key: normalizePathKey(physical) };
    },
  );
  // Deduplicate in case symlinked paths resolved identically, and exclude primary repo root.
  const seenKeys = new Set<string>([repoRootKey]);
  const linkedWorktrees: Array<{ raw: string; physical: string; key: string }> = [];
  for (const entry of linkedEntries) {
    if (seenKeys.has(entry.key)) continue;
    seenKeys.add(entry.key);
    linkedWorktrees.push(entry);
  }

  const activeKeys = await mapBounded(
    [...new Set(activePathsRaw)],
    REALPATH_CONCURRENCY,
    async (p) => normalizePathKey(await safeRealpath(p, realpathFn)),
  );

  const protectedWorktreePaths: string[] = [];
  let activeWorktreeCount = 0;
  for (const wt of linkedWorktrees) {
    if (
      activeKeys.some((active) => active === wt.key || active.startsWith(`${wt.key}${path.sep}`))
    ) {
      activeWorktreeCount += 1;
      if (protectedWorktreePaths.length < MAX_PROTECTED_PATHS_IN_SUMMARY) {
        protectedWorktreePaths.push(wt.physical);
      }
    }
  }

  const worktreeCount = linkedWorktrees.length;
  const idleWorktreeCount = Math.max(0, worktreeCount - activeWorktreeCount);

  const cindyManagedPrefix =
    normalizePathKey(path.join(physicalRepo, '.cindy-worktrees')) + path.sep;
  const xdtManagedPrefix = normalizePathKey(path.join(physicalRepo, '.xdt-worktrees')) + path.sep;
  const linkedKeySet = new Set(linkedWorktrees.map((w) => w.key));
  const failedKeys = new Set<string>();
  for (const rawFailed of failedRecyclePathsRaw) {
    const physical = await safeRealpath(rawFailed, realpathFn);
    const key = normalizePathKey(physical);
    if (
      linkedKeySet.has(key) ||
      key.startsWith(cindyManagedPrefix) ||
      key.startsWith(xdtManagedPrefix)
    ) {
      failedKeys.add(key);
    }
  }
  const failedCleanupCount = failedKeys.size;

  const tier =
    activeWorktreeCount > MAX_PROTECTED_PATHS_IN_SUMMARY
      ? 'healthy'
      : computeWorkspaceClutterTier({
          localBranchCount,
          cindyBranchCount,
          idleWorktreeCount,
          failedCleanupCount,
        });

  return {
    localBranchCount,
    cindyBranchCount,
    worktreeCount,
    idleWorktreeCount,
    activeWorktreeCount,
    failedCleanupCount,
    protectedWorktreePaths,
    tier,
  };
}
