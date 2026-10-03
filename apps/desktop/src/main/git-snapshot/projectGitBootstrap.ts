/**
 * Best-effort Git bootstrap for newly opened local project folders.
 *
 * Empty non-Git folders are initialized only after the user opts into Git
 * safety snapshots, so Codex file rewind can anchor to a real HEAD without
 * silently mutating default-off projects. Non-empty folders require an explicit
 * per-project confirmation before the first Git write.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { detectCwd } from '../worktree/WorktreeManager';
import { gitExec } from '../worktree/gitExec';
import { createLogger } from '../logger';
import { createSnapshotDetailed, type CreateSnapshotDetailedResult } from './gitSnapshotService';

const log = createLogger('project-git-bootstrap');
const INITIAL_PROJECT_LABEL = 'Initialize project snapshot';
const FALLBACK_SESSION_ID = 'project-bootstrap';
const SNAPSHOT_AUTHOR = { name: 'Cindy Recovery', email: 'recovery@cindy.local' };

export type ProjectGitBootstrapStatus = 'initialized' | 'already-git' | 'skipped' | 'failed';

export interface ProjectGitBootstrapRequest {
  workingDir?: string | null;
  workspaceKind?: string | null;
  remoteHostId?: string | null;
  sessionId?: string | null;
  autoSnapshotEnabled?: boolean | null;
  autoInitProjectGit?: boolean | null;
  source?: string;
  /** Only interactive turn-start callers provide this; other callers keep skipping non-empty dirs. */
  confirmNonEmptyProject?: (workingDir: string) => Promise<boolean>;
}

export interface ProjectGitBootstrapResult {
  status: ProjectGitBootstrapStatus;
  repoRoot?: string;
  commit?: string | null;
  includedFiles?: string[];
  skippedFiles?: CreateSnapshotDetailedResult['skippedFiles'];
  reason?: string;
}

const bootstrapQueues = new Map<string, Promise<void>>();
const IGNORED_EMPTY_DIR_ENTRIES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

export function shouldBootstrapProjectGit(request: ProjectGitBootstrapRequest): boolean {
  return getProjectGitBootstrapSkipReason(request) === null;
}

function getProjectGitBootstrapSkipReason(request: ProjectGitBootstrapRequest): string | null {
  const workingDir = request.workingDir?.trim();
  const remoteHostId = request.remoteHostId?.trim();
  if (!workingDir) return 'not-local-project';
  if (request.workspaceKind === 'dialogue') return 'not-local-project';
  if (remoteHostId) return 'not-local-project';
  if ((request.autoInitProjectGit ?? request.autoSnapshotEnabled) !== true) {
    return 'git-safety-disabled';
  }
  return null;
}

export async function ensureProjectGitInitialized(
  request: ProjectGitBootstrapRequest,
): Promise<ProjectGitBootstrapResult> {
  const skipReason = getProjectGitBootstrapSkipReason(request);
  if (skipReason) {
    return { status: 'skipped', reason: skipReason };
  }

  const workingDir = path.resolve(request.workingDir!);
  return withProjectBootstrapQueue(workingDir, () =>
    ensureProjectGitInitializedInner({ ...request, workingDir }),
  );
}

async function ensureProjectGitInitializedInner(
  request: ProjectGitBootstrapRequest & { workingDir: string },
): Promise<ProjectGitBootstrapResult> {
  try {
    const stat = await fs.stat(request.workingDir);
    if (!stat.isDirectory()) {
      return { status: 'skipped', reason: 'not-directory' };
    }

    const before = await detectCwd(request.workingDir);
    if (!before.gitInstalled) {
      return { status: 'skipped', reason: 'git-unavailable' };
    }
    if (before.isGitRepo) {
      return { status: 'already-git', repoRoot: before.repoRoot };
    }

    const nonEmpty = !(await isDirectoryEffectivelyEmpty(request.workingDir));
    if (nonEmpty) {
      if (
        !request.confirmNonEmptyProject ||
        !(await request.confirmNonEmptyProject(request.workingDir))
      ) {
        return { status: 'skipped', reason: 'non-empty-project' };
      }
      // Confirmation may outlive another session's bootstrap. Never reinitialize it.
      const afterConfirmation = await detectCwd(request.workingDir);
      if (afterConfirmation.isGitRepo) {
        return { status: 'already-git', repoRoot: afterConfirmation.repoRoot };
      }
    }

    await gitExec(['init'], request.workingDir);
    let snapshot: CreateSnapshotDetailedResult;
    try {
      snapshot = await createSnapshotDetailed(request.workingDir, {
        label: INITIAL_PROJECT_LABEL,
        meta: {
          sessionId: request.sessionId?.trim() || FALLBACK_SESSION_ID,
          kind: 'manual',
        },
        author: SNAPSHOT_AUTHOR,
        allowEmpty: true,
      });
    } catch (error) {
      // A repository without its first commit is not a recovery point. Only
      // remove the .git directory that this call just created, and only while
      // it still has no HEAD; preserve any repository another process advanced.
      const hasHead = await gitExec(['rev-parse', '--verify', 'HEAD'], request.workingDir).then(
        () => true,
        () => false,
      );
      if (!hasHead) {
        const gitDir = path.join(request.workingDir, '.git');
        const stat = await fs.lstat(gitDir).catch(() => null);
        if (stat?.isDirectory()) await fs.rm(gitDir, { recursive: true, force: true });
      }
      throw error;
    }

    log.info('[project-git-bootstrap] initialized project git repository', {
      source: request.source,
      workingDir: request.workingDir,
      commit: snapshot.commit?.slice(0, 8) ?? null,
      included: snapshot.includedFiles.length,
      skipped: snapshot.skippedFiles.length,
    });

    return {
      status: 'initialized',
      repoRoot: request.workingDir,
      commit: snapshot.commit,
      includedFiles: snapshot.includedFiles,
      skippedFiles: snapshot.skippedFiles,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('[project-git-bootstrap] failed (swallowed)', {
      source: request.source,
      workingDir: request.workingDir,
      error: message,
    });
    return { status: 'failed', reason: message };
  }
}

async function isDirectoryEffectivelyEmpty(dir: string): Promise<boolean> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED_EMPTY_DIR_ENTRIES.has(entry.name)) continue;
    if (!entry.isDirectory()) return false;
    if (!(await isDirectoryEffectivelyEmpty(path.join(dir, entry.name)))) return false;
  }
  return true;
}

async function withProjectBootstrapQueue<T>(
  workingDir: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(workingDir);
  const previous = bootstrapQueues.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const queued = previous.then(
    () => current,
    () => current,
  );
  bootstrapQueues.set(key, queued);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    releaseCurrent();
    if (bootstrapQueues.get(key) === queued) bootstrapQueues.delete(key);
  }
}
