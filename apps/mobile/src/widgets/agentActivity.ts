import type { RemoteSessionLiveActivity } from '@cindy/maker-shared/session-list';
import type { RemoteSession } from '@/session/types';

export interface AgentActivityState {
  status: 'attention' | 'running' | 'completed' | 'error';
  title: string;
  detail: string;
  count: number;
  runningCount: number;
  attentionCount: number;
  url: string;
  staleDetail: string;
}

/** Mac island ordering, using the same host activity projection as the mobile Home rows. */
export function projectAgentActivity(
  sessions: readonly RemoteSession[],
  read: (session: RemoteSession) => RemoteSessionLiveActivity | null,
  labels: Record<AgentActivityState['status'], string>,
  url: (session: RemoteSession) => string,
  staleDetail: string,
): AgentActivityState | null {
  const candidates = sessions.flatMap(session => {
    if (session.status !== 'active' || session.cacheSeeded || session.pendingLocalCreation || !session.deviceLinkDeviceId) return [];
    const activity = read(session);
    if (!activity) return [];
    const status: AgentActivityState['status'] = activity.phase === 'needs-interaction' ? 'attention' : activity.phase;
    if ((status === 'completed' || status === 'error') && !activity.attention) return [];
    return [{ session, status }];
  });
  const rank = { attention: 0, error: 1, completed: 1, running: 2 };
  candidates.sort((a, b) => rank[a.status] - rank[b.status]);
  const selected = candidates[0];
  if (!selected) return null;
  return {
    status: selected.status,
    title: [...selected.session.title].slice(0, 100).join(''),
    // Never copy tool arguments or message previews onto a locked phone.
    detail: labels[selected.status],
    count: candidates.length,
    runningCount: candidates.filter(candidate => candidate.status === 'running').length,
    attentionCount: candidates.filter(candidate => candidate.status === 'attention').length,
    url: url(selected.session),
    staleDetail,
  };
}
