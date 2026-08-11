/**
 * Resolve a session into the authoritative git workdir used by the review panel.
 *
 * Renderer never supplies cwd directly. The main process reads the session row
 * and managed worktree store, then delegates telemetry/worktree fallback logic
 * to sessionDirResolver.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

import { eq } from 'drizzle-orm';

import { resolveSessionGitDirLive } from '../git-context/sessionDirResolver.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import * as worktreeStore from '../worktree/worktreeStore.js';
import { GitRunError, runGit } from './gitRunner.js';
import type { ReviewScope } from './types.js';

export interface SessionReviewRow {
  id: string;
  workingDir: string | null;
  worktreePath: string | null;
  remoteHostId: string | null;
}

const sessionRowSnapshot = new AsyncLocalStorage<SessionReviewRow>();

export function withSessionReviewRowSnapshot<T>(
  row: SessionReviewRow,
  task: () => Promise<T>,
): Promise<T> {
  return sessionRowSnapshot.run(row, task);
}

export interface ScopeResolverDeps {
  getSessionRow: (sessionId: string) => Promise<SessionReviewRow | null>;
  getManagedWorktreePath: (sessionId: string) => string | null;
  resolveSessionDir: typeof resolveSessionGitDirLive;
  git: typeof runGit;
}

export function defaultScopeResolverDeps(): ScopeResolverDeps {
  return {
    getSessionRow: async (sessionId) => {
      const snapshot = sessionRowSnapshot.getStore();
      if (snapshot?.id === sessionId) return snapshot;
      const db = getDbClient().drizzle;
      const rows = await db
        .select({
          id: sessions.id,
          workingDir: sessions.workingDir,
          worktreePath: sessions.worktreePath,
          remoteHostId: sessions.remoteHostId,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return rows[0] ?? null;
    },
    getManagedWorktreePath: (sessionId) => worktreeStore.get(sessionId)?.path ?? null,
    resolveSessionDir: resolveSessionGitDirLive,
    git: runGit,
  };
}

function disabledScope(
  sessionId: string,
  patch: Partial<ReviewScope> & {
    disabledReason: NonNullable<ReviewScope['disabledReason']>;
    disabledMessage: string;
  },
): ReviewScope {
  return {
    sessionId,
    workdir: null,
    worktreePath: null,
    workingDir: null,
    repoRoot: null,
    branch: null,
    headOid: null,
    isDetached: false,
    isUnborn: false,
    source: null,
    aheadBehind: { ahead: 0, behind: 0, upstream: null, stale: true },
    resolutionChain: [],
    ...patch,
  };
}

interface RepoRootProbe {
  repoRoot: string | null;
  disabledReason: 'non-git' | 'git-unavailable' | null;
}

function isGitUnavailable(err: unknown): boolean {
  return err instanceof GitRunError && (
    err.exitCode === 127 ||
    (err.exitCode === null && (err.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT')
  );
}

async function readRepoRoot(workdir: string, git: typeof runGit, remote = false): Promise<RepoRootProbe> {
  try {
    const { stdout } = await git(['rev-parse', '--show-toplevel'], { cwd: workdir });
    const root = stdout.trim();
    if (!root) return { repoRoot: null, disabledReason: 'non-git' };
    if (remote) {
      return path.posix.isAbsolute(root)
        ? { repoRoot: path.posix.normalize(root), disabledReason: null }
        : { repoRoot: null, disabledReason: 'non-git' };
    }
    return { repoRoot: path.resolve(root), disabledReason: null };
  } catch (err) {
    // A remote Git probe can fail before Git runs (SSH channel closure,
    // timeout, or remote service failure). Preserve that transport error so
    // the caller can surface a retryable connection failure instead of
    // misreporting the workspace as a non-Git directory.
    if (remote && !(err instanceof GitRunError)) throw err;
    return { repoRoot: null, disabledReason: isGitUnavailable(err) ? 'git-unavailable' : 'non-git' };
  }
}

async function readHeadOid(workdir: string, git: typeof runGit): Promise<string | null> {
  try {
    const { stdout } = await git(['rev-parse', '--verify', 'HEAD'], { cwd: workdir });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readRemoteHeadState(
  repoRoot: string,
  git: typeof runGit,
): Promise<{ branch: string | null; headOid: string | null; isDetached: boolean }> {
  const headOid = await readHeadOid(repoRoot, git);
  try {
    const { stdout } = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: repoRoot,
    });
    return { branch: stdout.trim() || null, headOid, isDetached: false };
  } catch {
    return { branch: null, headOid, isDetached: headOid !== null };
  }
}

export async function resolveReviewScope(
  sessionId: string,
  deps: ScopeResolverDeps = defaultScopeResolverDeps(),
): Promise<ReviewScope> {
  const row = await deps.getSessionRow(sessionId);
  if (!row) {
    return disabledScope(sessionId, {
      disabledReason: 'no-session',
      disabledMessage: 'Session not found',
      resolutionChain: [{ source: 'session', path: null, ok: false, reason: 'not-found' }],
    });
  }

  if (row.remoteHostId) {
    const resolutionChain = [{ source: 'remote', path: row.workingDir, ok: Boolean(row.workingDir) }];
    if (!row.workingDir) {
      return disabledScope(sessionId, {
        worktreePath: row.worktreePath,
        disabledReason: 'no-workdir',
        disabledMessage: 'This SSH session has no remote workdir',
        resolutionChain,
      });
    }
    if (!path.posix.isAbsolute(row.workingDir)) {
      return disabledScope(sessionId, {
        workingDir: row.workingDir,
        worktreePath: row.worktreePath,
        source: 'remote',
        disabledReason: 'invalid-worktree',
        disabledMessage: 'The SSH workspace path is invalid',
        resolutionChain: [{ ...resolutionChain[0], ok: false, reason: 'not-absolute' }],
      });
    }
    const workdir = path.posix.normalize(row.workingDir);
    const probe = await readRepoRoot(workdir, deps.git, true);
    if (!probe.repoRoot) {
      const unavailable = probe.disabledReason === 'git-unavailable';
      return disabledScope(sessionId, {
        workdir,
        workingDir: row.workingDir,
        worktreePath: row.worktreePath,
        source: 'remote',
        disabledReason: unavailable ? 'git-unavailable' : 'non-git',
        disabledMessage: unavailable
          ? 'Git is not available on the SSH host'
          : 'No git repository found in the SSH workspace',
        resolutionChain: [{ ...resolutionChain[0], ok: false, reason: unavailable ? 'git-unavailable' : 'non-git' }],
      });
    }
    const head = await readRemoteHeadState(probe.repoRoot, deps.git);
    return {
      sessionId,
      workdir,
      worktreePath: row.worktreePath,
      workingDir: row.workingDir,
      repoRoot: probe.repoRoot,
      branch: head.branch,
      headOid: head.headOid,
      isDetached: head.isDetached,
      isUnborn: head.headOid === null,
      source: 'remote',
      aheadBehind: { ahead: 0, behind: 0, upstream: null, stale: true },
      disabledReason: null,
      disabledMessage: null,
      resolutionChain,
    };
  }

  const managedWorktreePath = deps.getManagedWorktreePath(sessionId);
  const fallbackWorktreePath = managedWorktreePath ?? row.worktreePath;
  const resolved = await deps.resolveSessionDir({
    sessionId,
    fallbackWorktreePath,
    fallbackWorkingDir: row.workingDir,
  });
  // A remote row is handled above through the request-scoped SSH Git backend.
  // A remote result here would lack the authoritative host id, so fail closed.
  if (resolved.source === 'remote') {
    return disabledScope(sessionId, {
      workingDir: row.workingDir,
      worktreePath: fallbackWorktreePath,
      disabledReason: 'remote-session',
      disabledMessage: 'Git review for remote sessions is not available yet',
      resolutionChain: [
        {
          source: 'remote',
          path: row.workingDir,
          ok: false,
          reason: row.remoteHostId ?? 'remote-resolver',
        },
      ],
    });
  }
  const resolutionChain = [
    { source: 'telemetry', path: resolved.source === 'telemetry' ? resolved.workdir : null, ok: resolved.source === 'telemetry' },
    { source: 'worktree', path: fallbackWorktreePath, ok: resolved.source === 'worktree' },
    { source: 'workingDir', path: row.workingDir, ok: resolved.source === 'workingDir' },
  ];

  if (!resolved.workdir) {
    return disabledScope(sessionId, {
      workingDir: row.workingDir,
      worktreePath: fallbackWorktreePath,
      disabledReason: row.workingDir || fallbackWorktreePath ? 'non-git' : 'no-workdir',
      disabledMessage: row.workingDir || fallbackWorktreePath ? 'No git repository found for this session' : 'This session has no local workdir',
      resolutionChain,
    });
  }

  const probe = await readRepoRoot(resolved.workdir, deps.git);
  if (!probe.repoRoot) {
    return disabledScope(sessionId, {
      workdir: path.resolve(resolved.workdir),
      workingDir: row.workingDir,
      worktreePath: fallbackWorktreePath,
      source: resolved.source,
      disabledReason: probe.disabledReason ?? 'non-git',
      disabledMessage: probe.disabledReason === 'git-unavailable'
        ? 'Git is not available on this computer'
        : 'No git repository found for this session',
      resolutionChain,
    });
  }

  const repoRoot = probe.repoRoot;
  const headOid = await readHeadOid(repoRoot, deps.git);
  const isDetached = resolved.head?.kind === 'detached';
  return {
    sessionId,
    workdir: path.resolve(resolved.workdir),
    worktreePath: fallbackWorktreePath,
    workingDir: row.workingDir,
    repoRoot,
    branch: resolved.head?.branch ?? null,
    headOid,
    isDetached,
    isUnborn: headOid === null,
    source: resolved.source,
    aheadBehind: { ahead: 0, behind: 0, upstream: null, stale: true },
    disabledReason: null,
    disabledMessage: null,
    resolutionChain,
  };
}
