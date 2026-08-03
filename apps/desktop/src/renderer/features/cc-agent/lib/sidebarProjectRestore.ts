import type { Session } from '@/lib/ccAgent.types';

import { projectKeyComparisonKey } from '../../../../shared/projectKeys';
import { sessionActivityMs } from './dateSessionGrouping';
import { groupSessions, projectIdentityKeyForSession } from './projectGrouping';

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

  const comparisonKey = projectKeyComparisonKey(projectKey, localPlatform);
  const currentProjectKey =
    comparisonKey == null
      ? null
      : Array.from(getCurrentProjectKeys()).find(
          (candidate) =>
            projectKeyComparisonKey(candidate, localPlatform) === comparisonKey,
        ) ?? null;
  if (currentProjectKey == null) return false;

  // A restored project must also be admitted by an explicit Project filter.
  // This operation is idempotent, unlike the user-facing filter toggle.
  ensureProjectIncluded(currentProjectKey);
  return true;
}
