/**
 * Resolve a session into the local git workdir used by the review panel.
 *
 * Renderer never supplies cwd directly. The main process reads the session row
 * and managed worktree store, then delegates telemetry/worktree fallback logic
 * to sessionDirResolver.
 */

import path from 'node:path';

import { eq } from 'drizzle-orm';

import { resolveSessionGitDirLive } from '../git-context/sessionDirResolver.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import * as worktreeStore from '../worktree/worktreeStore.js';
import { runGit } from './gitRunner.js';
import type { ReviewScope } from './types.js';

export interface SessionReviewRow {
  id: string;
  workingDir: string | null;
  worktreePath: string | null;
  remoteHostId: string | null;
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

async function readRepoRoot(workdir: string, git: typeof runGit): Promise<string | null> {
  try {
    const { stdout } = await git(['rev-parse', '--show-toplevel'], { cwd: workdir });
    const root = stdout.trim();
    return root ? path.resolve(root) : null;
  } catch {
    return null;
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
    return disabledScope(sessionId, {
      workingDir: row.workingDir,
      worktreePath: row.worktreePath,
      disabledReason: 'remote-session',
      disabledMessage: 'Git review for remote sessions is not available yet',
      resolutionChain: [{ source: 'remote', path: row.workingDir, ok: false, reason: row.remoteHostId }],
    });
  }

  const managedWorktreePath = deps.getManagedWorktreePath(sessionId);
  const fallbackWorktreePath = managedWorktreePath ?? row.worktreePath;
  const resolved = await deps.resolveSessionDir({
    sessionId,
    fallbackWorktreePath,
    fallbackWorkingDir: row.workingDir,
  });
  // The review panel is intentionally local-only. Keep this guard explicit so
  // the shared session resolver can also represent SSH probes without widening
  // ReviewScope's local source contract.
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

  const repoRoot = await readRepoRoot(resolved.workdir, deps.git);
  if (!repoRoot) {
    return disabledScope(sessionId, {
      workdir: path.resolve(resolved.workdir),
      workingDir: row.workingDir,
      worktreePath: fallbackWorktreePath,
      source: resolved.source,
      disabledReason: 'non-git',
      disabledMessage: 'No git repository found for this session',
      resolutionChain,
    });
  }

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
