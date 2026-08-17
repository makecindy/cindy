import type { Session } from '@/lib/ccAgent.types';

import { projectKeyComparisonKey } from '../../../../shared/projectKeys';
import { sessionActivityMs } from './dateSessionGrouping';
import { groupSessions, projectIdentityKeyForSession } from './projectGrouping';
import { isProjectHidden } from './sidebarProjectVisibility';

type SidebarProjectRestoreHandler = (projectKey: string) => Promise<boolean>;

let sidebarProjectRestoreHandler: SidebarProjectRestoreHandler | null = null;

function findMatchingProjectKey(
  projectKey: string,
  candidates: ReadonlySet<string>,
  localPlatform: string,
): string | null {
  const comparisonKey = projectKeyComparisonKey(projectKey, localPlatform);
  if (comparisonKey == null) return null;
  return (
    Array.from(candidates).find(
      (candidate) => projectKeyComparisonKey(candidate, localPlatform) === comparisonKey,
    ) ?? null
  );
}

/**
 * The sidebar owns both the hidden-project snapshot and the active Project
 * filter. Creation routes live in a sibling React tree, so they delegate the
 * restore transaction here instead of duplicating those two pieces of state.
 */
export function registerSidebarProjectRestoreHandler(
  handler: SidebarProjectRestoreHandler,
): () => void {
  sidebarProjectRestoreHandler = handler;
  return () => {
    if (sidebarProjectRestoreHandler === handler) sidebarProjectRestoreHandler = null;
  };
}

export function requestSidebarProjectRestore(projectKey: string): Promise<boolean> {
  const handler = sidebarProjectRestoreHandler;
  if (!handler) {
    return Promise.reject(new Error('Sidebar project restore handler is unavailable'));
  }
  return handler(projectKey);
}

type RestoreVendorPredicate = (session: Pick<Session, 'agentKind'>) => boolean;

interface CollectRestorableProjectKeysOptions {
  sessions: readonly Session[];
  lastActivityCutoff: number | null;
  pinnedProjectKeys: ReadonlySet<string>;
  vendorPredicate: RestoreVendorPredicate | null;
}

/**
 * Returns project keys that can actually appear in the current renderer after
 * the hidden overlay and explicit Project filter are removed.
 *
 * Callers provide sessions already scoped by machine, status, and Orca role.
 * Vendor and activity filters mirror the sidebar selectors. Individually
 * pinned sessions and pinned projects keep the sidebar's existing behavior of
 * bypassing the last-activity cutoff.
 */
export function collectRestorableProjectKeys({
  sessions,
  lastActivityCutoff,
  pinnedProjectKeys,
  vendorPredicate,
}: CollectRestorableProjectKeysOptions): ReadonlySet<string> {
  const vendorSessions = vendorPredicate ? sessions.filter(vendorPredicate) : sessions;
  const activitySessions =
    lastActivityCutoff === null
      ? vendorSessions
      : vendorSessions.filter((session) => sessionActivityMs(session) >= lastActivityCutoff);
  const activityGroups = groupSessions(activitySessions, { includePinnedInProjects: true });
  const allGroups =
    lastActivityCutoff === null
      ? activityGroups
      : groupSessions(vendorSessions, { includePinnedInProjects: true });
  const projectKeys = new Set(activityGroups.projects.map((project) => project.projectKey));

  for (const project of allGroups.projects) {
    if (pinnedProjectKeys.has(project.projectKey)) projectKeys.add(project.projectKey);
  }
  for (const session of allGroups.pinned) {
    if (session.workspaceKind === 'dialogue') continue;
    const projectKey = projectIdentityKeyForSession(session);
    if (projectKey != null) projectKeys.add(projectKey);
  }

  return projectKeys;
}

interface RestoreHiddenProjectIfPresentOptions {
  projectKey: string;
  /** Whether this project was hidden before the directory picker opened. */
  wasHiddenAtPickerOpen: boolean;
  setProjectHidden: (projectKey: string, hidden: boolean) => Promise<boolean>;
  getCurrentProjectKeys: () => ReadonlySet<string>;
  ensureProjectIncluded: (projectKey: string) => void;
  localPlatform: string;
}

/**
 * Restores an existing hidden project after the directory picker resolves.
 *
 * The project catalogue is read only after the main-process update completes:
 * tasks may have moved or disappeared while the picker or IPC request was open.
 * The picker-open snapshot distinguishes a normal visible-project selection
 * from a concurrent restore whose main-process update already became a no-op.
 * Returning false tells the caller to continue with normal draft creation.
 */
export async function restoreHiddenProjectIfPresent({
  projectKey,
  wasHiddenAtPickerOpen,
  setProjectHidden,
  getCurrentProjectKeys,
  ensureProjectIncluded,
  localPlatform,
}: RestoreHiddenProjectIfPresentOptions): Promise<boolean> {
  const hiddenStateChanged = await setProjectHidden(projectKey, false);
  if (!hiddenStateChanged && !wasHiddenAtPickerOpen) {
    return false;
  }

  const currentProjectKey = findMatchingProjectKey(
    projectKey,
    getCurrentProjectKeys(),
    localPlatform,
  );
  if (currentProjectKey == null) return false;

  // A restored project must also be admitted by an explicit Project filter.
  // This operation is idempotent, unlike the user-facing filter toggle.
  ensureProjectIncluded(currentProjectKey);
  return true;
}

interface RestoreSelectedHiddenProjectOptions {
  projectKey: string;
  hiddenProjectKeys: ReadonlySet<string>;
  setProjectHidden: (projectKey: string, hidden: boolean) => Promise<boolean>;
  getCurrentProjectKeys: () => ReadonlySet<string>;
  ensureProjectIncluded: (projectKey: string) => void;
  localPlatform: string;
}

/**
 * Restore a project explicitly selected from the new-task folder picker.
 *
 * Unlike the old sidebar "New Project" action, selection must continue into
 * the draft after restoring. The chosen path itself is therefore the future
 * project key even when the restored project currently has no visible tasks.
 */
export async function restoreSelectedHiddenProject({
  projectKey,
  hiddenProjectKeys,
  setProjectHidden,
  getCurrentProjectKeys,
  ensureProjectIncluded,
  localPlatform,
}: RestoreSelectedHiddenProjectOptions): Promise<boolean> {
  const wasHidden = isProjectHidden(projectKey, hiddenProjectKeys, localPlatform);
  const hiddenStateChanged = await setProjectHidden(projectKey, false);
  if (!hiddenStateChanged && !wasHidden) return false;

  ensureProjectIncluded(
    findMatchingProjectKey(projectKey, getCurrentProjectKeys(), localPlatform) ?? projectKey,
  );
  return true;
}
