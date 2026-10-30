import { sidebarPinnedEntryComparisonKey } from '../../../../shared/sidebarSettings';

/**
 * Pinned sidebar order stores conversations and projects in one persisted list.
 * Conversation ids remain unchanged for backward compatibility; project entries
 * use a reserved prefix followed by the stable project identity key.
 */
const PINNED_PROJECT_ENTRY_PREFIX = 'project:';

export function pinnedProjectEntryId(projectKey: string): string {
  return `${PINNED_PROJECT_ENTRY_PREFIX}${projectKey}`;
}

export function projectKeyFromPinnedEntryId(entryId: string): string | null {
  if (!entryId.startsWith(PINNED_PROJECT_ENTRY_PREFIX)) return null;
  const projectKey = entryId.slice(PINNED_PROJECT_ENTRY_PREFIX.length);
  return projectKey.length > 0 ? projectKey : null;
}

export function isPinnedProjectEntryId(entryId: string): boolean {
  return projectKeyFromPinnedEntryId(entryId) !== null;
}

/** Comparison identity for mixed persisted pinned entries; conversation ids remain exact. */
export function pinnedSidebarEntryComparisonKey(entryId: string, localPlatform: string): string {
  return sidebarPinnedEntryComparisonKey(entryId, localPlatform);
}

/** Build stable persisted ranks while retaining the first durable representative. */
export function buildPinnedSidebarRank(
  order: readonly string[],
  localPlatform: string,
): Map<string, number> {
  const rank = new Map<string, number>();
  order.forEach((entryId, index) => {
    const identity = pinnedSidebarEntryComparisonKey(entryId, localPlatform);
    if (!rank.has(identity)) rank.set(identity, index);
  });
  return rank;
}

/**
 * Project tokens are intentionally kept even when a project is temporarily
 * absent (machine/status filtering, remote disconnect, or no unpinned chats).
 * That prevents an unrelated conversation reorder from silently losing a
 * persisted project pin.
 */
export function activePinnedSidebarEntryIds(
  manualOrder: readonly string[],
  pinnedSessionIds: readonly string[],
  localPlatform: string = '',
): string[] {
  const seen = new Set<string>();
  const active: string[] = [];

  for (const id of pinnedSessionIds) {
    const identity = pinnedSidebarEntryComparisonKey(id, localPlatform);
    if (seen.has(identity)) continue;
    seen.add(identity);
    active.push(id);
  }

  for (const id of manualOrder) {
    if (!isPinnedProjectEntryId(id)) continue;
    const identity = pinnedSidebarEntryComparisonKey(id, localPlatform);
    if (seen.has(identity)) continue;
    seen.add(identity);
    active.push(id);
  }

  return active;
}
