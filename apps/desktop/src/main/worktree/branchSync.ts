import path from 'node:path';
import { access, realpath } from 'node:fs/promises';
import { gitExec, GitExecError } from './gitExec';
import { isSafeAutomaticRebase } from './rebaseSafety';
import type {
  BranchSyncRequest,
  BranchSyncResult,
  BranchSyncStatus,
} from '../../shared/worktreeBranchSync';

const localOpts = { timeoutMs: 5_000, extraEnv: { LC_ALL: 'C' } };
// Never interrupt a local write halfway through checkout; disable interactive prompts instead.
const writeOpts = { extraEnv: { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } };
const MAX_DIVERGED_CONFLICT_FILES = 6;
const GIT_IN_PROGRESS_MARKERS = [
  'MERGE_HEAD',
  'REBASE_HEAD',
  'rebase-merge',
  'rebase-apply',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
] as const;

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await gitExec(args, cwd, localOpts)).stdout.trim();
}
async function optional(cwd: string, ...args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, ...args);
  } catch (error) {
    if (error instanceof GitExecError && !error.timedOut && error.exitCode !== null)
      return undefined;
    throw error;
  }
}

async function hasGitOperationInProgress(checkoutPath: string): Promise<boolean> {
  const gitDirRaw = await optional(checkoutPath, 'rev-parse', '--git-dir');
  if (!gitDirRaw) return false;
  const gitDir = path.isAbsolute(gitDirRaw) ? gitDirRaw : path.resolve(checkoutPath, gitDirRaw);
  for (const marker of GIT_IN_PROGRESS_MARKERS) {
    try {
      await access(path.join(gitDir, marker));
      return true;
    } catch {
      // Marker absent; continue.
    }
  }
  return false;
}

/**
 * Parse repo-relative conflict file paths from `git merge-tree --write-tree --name-only --no-messages`.
 * Line 0 is the synthetic tree OID; subsequent non-empty lines are conflicting paths.
 */
export function parseMergeTreeConflictFiles(stdout: string): string[] {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  const start = /^[0-9a-f]{40,64}$/i.test(lines[0]) ? 1 : 0;
  const seen = new Set<string>();
  const files: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const candidate = lines[i];
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    files.push(candidate);
    if (files.length >= MAX_DIVERGED_CONFLICT_FILES) break;
  }
  return files;
}

/**
 * Zero-mutation conflict preflight between local and remote refs via `git merge-tree --write-tree`.
 * Fail-closed: if git is too old or the command fails unexpectedly, report conflict=true so callers
 * never attempt an unverified automatic rebase.
 */
export async function preflightDivergedMergeTree(
  baseRepo: string,
  localRef: string,
  remoteRef: string,
): Promise<{ conflict: boolean; conflictFiles: string[] }> {
  try {
    await gitExec(
      ['merge-tree', '--write-tree', '--name-only', '--no-messages', localRef, remoteRef],
      baseRepo,
      localOpts,
    );
    return { conflict: false, conflictFiles: [] };
  } catch (error) {
    if (error instanceof GitExecError && error.exitCode === 1) {
      return { conflict: true, conflictFiles: parseMergeTreeConflictFiles(error.stdout) };
    }
    return { conflict: true, conflictFiles: [] };
  }
}

/** Local refs only: a dangling origin/HEAD must not hide the main/master fallback. */
export async function readOriginDefaultBranch(cwd: string): Promise<string | undefined> {
  const symbolic = await optional(cwd, 'symbolic-ref', 'refs/remotes/origin/HEAD');
  for (const ref of [symbolic, 'refs/remotes/origin/main', 'refs/remotes/origin/master']) {
    if (
      ref?.startsWith('refs/remotes/origin/') &&
      (await optional(cwd, 'rev-parse', '--verify', `${ref}^{commit}`))
    )
      return ref;
  }
  return undefined;
}

function dirtyPaths(porcelain: string): { paths: string[]; files: number } {
  const fields = porcelain.split('\0');
  const paths: string[] = [];
  let files = 0;
  for (let i = 0; i < fields.length; i++) {
    const row = fields[i];
    if (!row) continue;
    files++;
    paths.push(row.slice(3));
    if (/[RC]/.test(row.slice(0, 2)) && fields[i + 1]) paths.push(fields[++i]);
  }
  return { paths, files };
}
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Validate refs even for direct main callers; never pass an option-shaped ref to Git. */
async function validate(req: BranchSyncRequest): Promise<void> {
  if (
    !req ||
    typeof req.baseRepo !== 'string' ||
    !path.isAbsolute(req.baseRepo) ||
    typeof req.branch !== 'string' ||
    req.branch.length > 1024 ||
    req.branch.startsWith('-')
  ) {
    throw new Error('Invalid branch sync request');
  }
  await git(
    req.baseRepo,
    'check-ref-format',
    req.branch.startsWith('refs/remotes/origin/') ? req.branch : `refs/heads/${req.branch}`,
  );
}

export async function readBranchSyncStatus(req: BranchSyncRequest): Promise<BranchSyncStatus> {
  await validate(req);
  const { baseRepo, branch } = req;
  const remoteOnly = branch.startsWith('refs/remotes/origin/');
  const status: BranchSyncStatus = { branch, remoteOnly, ahead: 0, behind: 0, dirtyFiles: 0 };
  const remotes = (await git(baseRepo, 'remote')).split(/\r?\n/).filter(Boolean);
  let remote = 'origin';
  let remoteBranch = remoteOnly ? branch.slice('refs/remotes/origin/'.length) : branch;
  const localRef = `refs/heads/${branch}`;
  if (!remoteOnly) {
    if (!(await optional(baseRepo, 'rev-parse', '--verify', `${localRef}^{commit}`)))
      return { ...status, blocked: 'not-local' };
    const configuredRemote = await optional(baseRepo, 'config', '--get', `branch.${branch}.remote`);
    const configuredRef = await optional(baseRepo, 'config', '--get', `branch.${branch}.merge`);
    if (configuredRemote && configuredRef?.startsWith('refs/heads/')) {
      remote = configuredRemote;
      remoteBranch = configuredRef.slice('refs/heads/'.length);
    }
    // -z preserves checkout paths containing newlines and non-ASCII characters.
    const worktrees = (
      await gitExec(['worktree', 'list', '--porcelain', '-z'], baseRepo, localOpts)
    ).stdout;
    const checkouts: string[] = [];
    for (const block of worktrees.split('\0\0')) {
      const fields = block.split('\0');
      if (fields.includes(`branch ${localRef}`)) {
        const checkout = fields.find((s) => s.startsWith('worktree '))?.slice(9);
        if (checkout) checkouts.push(checkout);
      }
    }
    if (checkouts.length > 1) return { ...status, blocked: 'multiple-checkouts' };
    status.checkoutPath = checkouts[0];
  }
  const dirty = status.checkoutPath
    ? dirtyPaths(
        (
          await gitExec(
            ['status', '--porcelain', '-z', '--untracked-files=all'],
            status.checkoutPath,
            localOpts,
          )
        ).stdout,
      )
    : { paths: [], files: 0 };
  status.dirtyFiles = dirty.files;
  if (!remotes.includes(remote)) return { ...status, blocked: 'no-remote' };
  Object.assign(status, {
    remote,
    remoteBranch,
    remoteRef: `refs/remotes/${remote}/${remoteBranch}`,
  });
  // A missing local tracking ref is unknown, not evidence the remote branch is absent.
  if (!(await optional(baseRepo, 'rev-parse', '--verify', `${status.remoteRef}^{commit}`)))
    return status;
  if (remoteOnly) return status;
  const counts = (
    await git(baseRepo, 'rev-list', '--left-right', '--count', `${localRef}...${status.remoteRef}`)
  )
    .split(/\s+/)
    .map(Number);
  [status.ahead, status.behind] = counts;
  if (status.ahead && status.behind) {
    const [preflight, inProgressOp, safeRebase] = await Promise.all([
      preflightDivergedMergeTree(baseRepo, localRef, status.remoteRef!),
      status.checkoutPath ? hasGitOperationInProgress(status.checkoutPath) : Promise.resolve(false),
      status.checkoutPath
        ? isSafeAutomaticRebase(status.checkoutPath, localRef, status.remoteRef!, (...args) => git(status.checkoutPath!, ...args))
        : Promise.resolve(false),
    ]);
    return {
      ...status,
      blocked: 'diverged',
      divergedConflict: preflight.conflict || !safeRebase,
      ...(preflight.conflictFiles.length > 0
        ? { divergedConflictFiles: preflight.conflictFiles }
        : {}),
      ...(inProgressOp ? { inProgressOp: true } : {}),
    };
  }
  if (status.behind && dirty.paths.length) {
    const changes = (
      await gitExec(['diff', '--name-only', '-z', localRef, status.remoteRef!], baseRepo, localOpts)
    ).stdout
      .split('\0')
      .filter(Boolean);
    if (dirty.paths.some((p) => changes.some((other) => overlaps(p, other))))
      return { ...status, blocked: 'conflict' };
  }
  return status;
}

// Serialize this UI's mutations per repository; no coupling to task creation or sends.
const syncing = new Set<string>();
/** Shared by checkout and branch refresh so neither can move HEAD under the other's preflight. */
export async function withBranchMutation<T>(baseRepo: string, run: () => Promise<T>): Promise<T> {
  const key = await realpath(
    await git(baseRepo, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
  );
  if (syncing.has(key)) throw new Error('A branch update is already running');
  syncing.add(key);
  try {
    return await run();
  } finally {
    syncing.delete(key);
  }
}
export async function syncBranch(req: BranchSyncRequest): Promise<BranchSyncResult> {
  await validate(req);
  return withBranchMutation(req.baseRepo, () => syncBranchOnce(req));
}
/** Fetch-only preparation inside the checkout's shared mutation lock. Never moves a local branch. */
export async function fetchCheckoutSource(req: BranchSyncRequest): Promise<BranchSyncResult> {
  await validate(req);
  if (!req.branch.startsWith('refs/remotes/origin/')) throw new Error('Expected an origin ref');
  return syncBranchOnce(req);
}

function canRebaseDivergedStatus(req: BranchSyncRequest, status: BranchSyncStatus): boolean {
  return (
    req.strategy === 'rebase' &&
    status.blocked === 'diverged' &&
    !status.divergedConflict &&
    !status.inProgressOp &&
    !!status.checkoutPath &&
    status.dirtyFiles === 0
  );
}

async function fetchTrackingRef(
  baseRepo: string,
  remote: string,
  remoteBranch: string,
  remoteRef: string,
): Promise<'ok' | 'missing-remote'> {
  try {
    await gitExec(
      [
        // Small fetches otherwise use unpack-objects, which can receive one
        // large blob without reporting any bytes. index-pack reports throughput
        // while reading, so the inactivity budget also works for that case.
        '-c',
        'fetch.unpackLimit=1',
        'fetch',
        '--progress',
        '--no-tags',
        '--recurse-submodules=no',
        '--',
        remote,
        `+refs/heads/${remoteBranch}:${remoteRef}`,
      ],
      baseRepo,
      {
        idleTimeoutMs: 60_000,
        extraEnv: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
    );
    return 'ok';
  } catch (error) {
    if (
      error instanceof GitExecError &&
      /couldn't find remote ref|could not find remote ref/i.test(error.stderr)
    ) {
      return 'missing-remote';
    }
    throw error;
  }
}

async function syncBranchOnce(req: BranchSyncRequest): Promise<BranchSyncResult> {
  let status = await readBranchSyncStatus(req);
  if (status.blocked && !canRebaseDivergedStatus(req, status)) return { status, updated: 0 };
  const { remote, remoteBranch, remoteRef } = status;
  const oldRemote = await optional(req.baseRepo, 'rev-parse', '--verify', `${remoteRef}^{commit}`);
  const fetched = await fetchTrackingRef(req.baseRepo, remote!, remoteBranch!, remoteRef!);
  if (fetched === 'missing-remote') {
    return { status: { ...status, blocked: 'missing-remote' }, updated: 0 };
  }
  status = await readBranchSyncStatus(req);
  if (status.blocked) {
    if (!canRebaseDivergedStatus(req, status)) return { status, updated: 0 };
    const checkoutPath = status.checkoutPath!;
    if ((await git(checkoutPath, 'symbolic-ref', 'HEAD')) !== `refs/heads/${req.branch}`) {
      throw new Error('The checked-out branch changed; retry');
    }
    const next = await git(req.baseRepo, 'rev-parse', '--verify', `${remoteRef}^{commit}`);
    const updated = status.behind;
    try {
      await gitExec(['rebase', '--no-autostash', next], checkoutPath, writeOpts);
    } catch (error) {
      await gitExec(['rebase', '--abort'], checkoutPath, writeOpts).catch(() => {});
      const refreshed = await readBranchSyncStatus(req);
      if (refreshed.blocked === 'diverged') {
        return { status: { ...refreshed, divergedConflict: true }, updated: 0 };
      }
      if (refreshed.blocked) return { status: refreshed, updated: 0 };
      throw error;
    }
    return { status: await readBranchSyncStatus(req), updated, syncedMode: 'rebase' };
  }
  if (status.remoteOnly) {
    const updated = Number(
      await git(
        req.baseRepo,
        'rev-list',
        '--count',
        oldRemote ? `${oldRemote}..${remoteRef}` : remoteRef!,
      ),
    );
    return { status, updated };
  }
  if (!status.behind) return { status, updated: 0 };
  const old = await git(req.baseRepo, 'rev-parse', '--verify', `refs/heads/${req.branch}^{commit}`);
  const next = await git(req.baseRepo, 'rev-parse', '--verify', `${remoteRef}^{commit}`);
  await git(req.baseRepo, 'merge-base', '--is-ancestor', old, next);
  const updated = status.behind;
  if (status.checkoutPath) {
    if ((await git(status.checkoutPath, 'symbolic-ref', 'HEAD')) !== `refs/heads/${req.branch}`)
      throw new Error('The checked-out branch changed; retry');
    try {
      await gitExec(
        ['merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', next],
        status.checkoutPath,
        writeOpts,
      );
    } catch (error) {
      const refreshed = await readBranchSyncStatus(req);
      if (refreshed.blocked) return { status: refreshed, updated: 0 };
      if (error instanceof GitExecError && /would be overwritten|local changes/i.test(error.stderr))
        return { status: { ...refreshed, blocked: 'conflict' }, updated: 0 };
      throw error;
    }
  } else {
    try {
      // Local fetch refuses non-fast-forwards and branches checked out in any
      // worktree at write time. update-ref has no checkout guard.
      await gitExec(
        ['fetch', '--no-tags', '--recurse-submodules=no', '.', `${next}:refs/heads/${req.branch}`],
        req.baseRepo,
        writeOpts,
      );
    } catch (error) {
      const refreshed = await readBranchSyncStatus(req);
      if (refreshed.blocked) return { status: refreshed, updated: 0 };
      if (refreshed.checkoutPath)
        return { status: { ...refreshed, blocked: 'changed' }, updated: 0 };
      throw error;
    }
  }
  return { status: await readBranchSyncStatus(req), updated, syncedMode: 'ff-only' };
}

export type AutoFastForwardResult =
  | { status: 'updated'; branch: string; updated: number }
  | { status: 'skipped'; reason: string };

/**
 * Zero-token automatic fast-forward of the local default branch after a PR merges.
 * Strictly read-only/no-op whenever the checkout is dirty, mid-operation, diverged,
 * ahead of remote, or locked by another branch mutation.
 */
export async function tryFastForwardDefaultBranchAfterMerge(
  baseRepo: string,
  hasRunningTaskInCheckout: (checkoutPath: string) => Promise<boolean> = async () => false,
): Promise<AutoFastForwardResult> {
  if (!path.isAbsolute(baseRepo)) {
    return { status: 'skipped', reason: 'invalid-path' };
  }
  const originDefault = await readOriginDefaultBranch(baseRepo);
  if (!originDefault) return { status: 'skipped', reason: 'no-origin-default' };
  const branch = originDefault.slice('refs/remotes/origin/'.length);
  const req: BranchSyncRequest = { baseRepo, branch, strategy: 'ff-only' };
  try {
    await validate(req);
  } catch {
    return { status: 'skipped', reason: 'invalid-branch' };
  }
  try {
    return await withBranchMutation(baseRepo, async (): Promise<AutoFastForwardResult> => {
      const before = await readBranchSyncStatus(req);
      if (before.blocked || before.remoteOnly) {
        return { status: 'skipped', reason: before.blocked ?? 'remote-only' };
      }
      if (before.ahead > 0) return { status: 'skipped', reason: 'ahead' };
      if (before.checkoutPath) {
        if (await hasRunningTaskInCheckout(before.checkoutPath)) {
          return { status: 'skipped', reason: 'busy' };
        }
        if (before.dirtyFiles > 0) return { status: 'skipped', reason: 'dirty' };
        if (await hasGitOperationInProgress(before.checkoutPath)) {
          return { status: 'skipped', reason: 'in-progress' };
        }
      }
      const fetched = await fetchTrackingRef(
        baseRepo,
        before.remote!,
        before.remoteBranch!,
        before.remoteRef!,
      );
      if (fetched === 'missing-remote') {
        return { status: 'skipped', reason: 'missing-remote' };
      }
      const afterFetch = await readBranchSyncStatus(req);
      if (afterFetch.blocked || afterFetch.remoteOnly) {
        return { status: 'skipped', reason: afterFetch.blocked ?? 'remote-only' };
      }
      if (afterFetch.ahead > 0) return { status: 'skipped', reason: 'ahead' };
      if (!afterFetch.behind) return { status: 'skipped', reason: 'up-to-date' };
      if (afterFetch.checkoutPath) {
        if (await hasRunningTaskInCheckout(afterFetch.checkoutPath)) {
          return { status: 'skipped', reason: 'busy' };
        }
        if (afterFetch.dirtyFiles > 0) return { status: 'skipped', reason: 'dirty' };
        if (await hasGitOperationInProgress(afterFetch.checkoutPath)) {
          return { status: 'skipped', reason: 'in-progress' };
        }
        if ((await git(afterFetch.checkoutPath, 'symbolic-ref', 'HEAD')) !== `refs/heads/${branch}`) {
          return { status: 'skipped', reason: 'changed' };
        }
      }
      const old = await git(baseRepo, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`);
      const next = await git(baseRepo, 'rev-parse', '--verify', `${afterFetch.remoteRef}^{commit}`);
      await git(baseRepo, 'merge-base', '--is-ancestor', old, next);
      if (afterFetch.checkoutPath) {
        if (await hasRunningTaskInCheckout(afterFetch.checkoutPath)) {
          return { status: 'skipped', reason: 'busy' };
        }
        await gitExec(
          ['merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', next],
          afterFetch.checkoutPath,
          writeOpts,
        );
      } else {
        await gitExec(
          ['fetch', '--no-tags', '--recurse-submodules=no', '.', `${next}:refs/heads/${branch}`],
          baseRepo,
          writeOpts,
        );
      }
      return { status: 'updated', branch, updated: afterFetch.behind };
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'A branch update is already running') {
      return { status: 'skipped', reason: 'busy' };
    }
    return { status: 'skipped', reason: 'error' };
  }
}
