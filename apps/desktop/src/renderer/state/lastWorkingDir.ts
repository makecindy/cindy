/**
 * Tracks the last known working directory from an active session.
 * Used by Settings/BuiltinToolsSection to populate the workingDir
 * for project-level tool configuration without URL plumbing.
 */

import { normalizeWorkingDirForStorage } from '../../shared/workingDir';

let _lastWorkingDir: string | null = null;
const listeners = new Set<() => void>();

export function setLastWorkingDir(dir: string | null): void {
  // Keep the active session cwd. Consumers that intentionally group managed
  // worktrees into their base repository must do so in their own scope.
  _lastWorkingDir = normalizeWorkingDirForStorage(dir);
  for (const l of listeners) l();
}

export function getLastWorkingDir(): string | null {
  return _lastWorkingDir;
}

export function subscribeToLastWorkingDir(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
