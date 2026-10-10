import type { MakerSessionCreateOpts } from './sessionRequest.js';

interface PersistedWorkspace {
  workingDir: string | null;
  workspaceKind: string | null;
  remoteHostId: string | null;
}

/** A queued send may still name the old, existing directory after a project move. */
export function reconcileCreateOptsWorkspace(
  sessionId: string,
  opts: MakerSessionCreateOpts,
  row: PersistedWorkspace,
  resolveRecoveredWorkingDir: (sessionId: string, workingDir: string) => string,
): void {
  if (opts.remoteHostId || row.remoteHostId) return;
  // working_dir is the durable runtime binding, including an independent
  // worktree's path. Resolve only its recovery fallback, never the project root.
  if (row.workingDir) {
    opts.workingDir = resolveRecoveredWorkingDir(sessionId, row.workingDir);
  }
  opts.workspaceKind = row.workspaceKind === 'dialogue' ? 'dialogue' : 'project';
}
