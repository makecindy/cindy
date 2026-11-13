import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { resolveTeammateStatus, type TeammateStatus } from '@cindy/maker-shared/teammate-status';
import { resolveRemoteText } from '@cindy/device-link';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';
import { remoteSessionStore } from './remoteSessionStore';

/** Rows and the compact header share device-scoped pending and activity snapshots. */
export function useRosterActivities(items: readonly HostedRemoteCollectionItem[]): ReadonlyMap<string, string> {
  const snapshot = useCallback(() => JSON.stringify(items.map(row => {
    const target = row.item.links.find(link => link.rel === 'conversation' && link.target.kind === 'session')?.target;
    const id = target?.kind === 'session' ? target.sessionId : null;
    return [row.key, id ? remoteSessionStore.getPendingInteractions(id, row.host.deviceId).length
      ? 'needs-interaction' : remoteSessionStore.getSessionLiveActivity(id, row.host.deviceId)?.phase ?? '' : ''];
  })), [items]);
  const key = useSyncExternalStore(remoteSessionStore.subscribe, snapshot);
  return useMemo(() => new Map(JSON.parse(key)), [key]);
}

/** Pending decisions keep priority over a generation snapshot in either presentation. */
export function teammateAttention(row: HostedRemoteCollectionItem, online: boolean,
  activities: ReadonlyMap<string, string>, language: string) {
  const display = row.item.display;
  const attention = display.status?.tone === 'warning' || display.status?.tone === 'critical'
    ? resolveRemoteText(display.status.label, language) : '';
  const waiting = resolveTeammateStatus({ online, working: !!display.generation, failed: !!attention,
    activities: [display.teammateActivity, { phase: activities.get(row.key) ?? '' }] }) === 'awaiting';
  return { attention, waiting };
}

/** Runtime subscription stays separate from the display-only status point. */
export function useTeammateStatus(input: Parameters<typeof resolveTeammateStatus>[0] & {
  sessionId?: string | null; deviceId?: string;
}): TeammateStatus {
  const { sessionId, deviceId } = input;
  const snapshot = useCallback(() => !sessionId ? ''
    : remoteSessionStore.getPendingInteractions(sessionId, deviceId).length ? 'needs-interaction'
      : remoteSessionStore.getSessionLiveActivity(sessionId, deviceId)?.phase ?? '', [sessionId, deviceId]);
  const phase = useSyncExternalStore(remoteSessionStore.subscribe, snapshot);
  return resolveTeammateStatus({ ...input, activities: [...(input.activities ?? []), ...(phase ? [{ phase }] : [])] });
}
