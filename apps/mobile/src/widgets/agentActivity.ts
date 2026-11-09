import type { RemoteSessionLiveActivity } from '@cindy/maker-shared/session-list';
import type { RemoteSession } from '@/session/types';

export type AgentActivityStatus = 'attention' | 'running' | 'completed' | 'error';
export interface AgentActivityState {
  status: AgentActivityStatus;
  title: string;
  detail: string;
  count: number;
  runningCount: number;
  attentionCount: number;
  unreadCompletedCount: number;
  badgeCount: number;
  url: string;
  staleDetail: string;
}

/** Shared by the iPhone Live Activity and both platforms' app-icon badges.
 * Adapted from the mobile island's projectAgentActivity; no native/React imports.
 */
export function summarizeAgentActivities(
  sessions: readonly RemoteSession[],
  read: (session: RemoteSession) => RemoteSessionLiveActivity | null,
) {
  const seen = new Set<string>();
  const candidates = sessions.flatMap(session => {
    if (session.status !== 'active' || session.cacheSeeded || session.pendingLocalCreation || !session.deviceLinkDeviceId) return [];
    const key = JSON.stringify([session.deviceLinkDeviceId, session.id]);
    if (seen.has(key)) return [];
    const activity = read(session);
    if (!activity) return [];
    const status: AgentActivityStatus = activity.phase === 'needs-interaction' ? 'attention' : activity.phase;
    if ((status === 'completed' || status === 'error') && !activity.attention) return [];
    seen.add(key);
    return [{ session, status }];
  });
  const rank = { attention: 0, running: 1, error: 2, completed: 2 };
  candidates.sort((a, b) => rank[a.status] - rank[b.status]);
  const runningCount = candidates.filter(candidate => candidate.status === 'running').length;
  const attentionCount = candidates.filter(candidate => candidate.status === 'attention').length;
  const unreadCompletedCount = candidates.length - runningCount - attentionCount;
  return { candidates, count: candidates.length, runningCount, attentionCount, unreadCompletedCount,
    badgeCount: attentionCount + unreadCompletedCount };
}

/** Same entry/shape as the iPhone island branch; native presentation stays separate. */
export function projectAgentActivity(
  sessions: readonly RemoteSession[],
  read: (session: RemoteSession) => RemoteSessionLiveActivity | null,
  labels: Record<AgentActivityStatus, string>,
  url: (session: RemoteSession) => string,
  staleDetail: string,
): AgentActivityState | null {
  const { candidates, ...counts } = summarizeAgentActivities(sessions, read);
  const selected = candidates[0];
  if (!selected) return null;
  return {
    ...counts, status: selected.status,
    title: [...selected.session.title].slice(0, 100).join(''),
    detail: labels[selected.status], url: url(selected.session), staleDetail,
  };
}

/** A disconnected or cache-only source is unknown, not an authoritative zero.
 * Check every loaded source, including ones that just became empty after archive.
 */
export function readTaskBadgeCount(
  sessions: readonly RemoteSession[],
  accountId: string,
  snapshotDeviceIds: readonly string[],
  canRead: (deviceId: string) => boolean,
  read: (session: RemoteSession) => RemoteSessionLiveActivity | null,
): number | undefined {
  if (!snapshotDeviceIds.length || snapshotDeviceIds.some(id => !canRead(id))) return undefined;
  // Desktop mapper uses '' for this compatibility field: its database and the
  // DeviceLinkProvider store/ACK lifecycle already enforce account ownership.
  // Do not discard those real tasks; still reject an explicit different owner.
  const owned = sessions.filter(session => session.userId === '' || session.userId === accountId);
  if (owned.some(session => session.status === 'active' && session.cacheSeeded)) return undefined;
  return summarizeAgentActivities(owned, read).badgeCount;
}
