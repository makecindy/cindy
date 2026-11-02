/** Hardware task publication for Work Louder Codex Micro. */

import type {
  InputDevicePublishedTask,
  InputDeviceRemoteTaskActivity,
} from '../../../../shared/inputDevices';

export interface WorkLouderCodexTaskPublishSession {
  id: string;
  title: string | null;
  pinnedAt: string | null;
  userSendAt: string | null;
  status: string;
  deviceLinkDeviceId?: string;
  deviceLinkConnectionStatus?: 'connected' | 'disconnected';
}

export type WorkLouderCodexRemoteActivityLookup = (
  sessionId: string,
  deviceId: string,
) => InputDeviceRemoteTaskActivity | undefined;

/**
 * Project sidebar rows into the keyboard's task list.
 *
 * Remote phases are attached only when the owning device is still connected.
 * The device id is part of the published identity so equal session ids on two
 * machines cannot share a lamp or a priority position.
 */
export function buildWorkLouderCodexPublishedTasks(
  sessions: readonly WorkLouderCodexTaskPublishSession[],
  sidebarOrder: ReadonlyMap<string, number>,
  readRemoteActivity: WorkLouderCodexRemoteActivityLookup,
): InputDevicePublishedTask[] {
  return sessions.map((session) => {
    const pinnedAtMs = session.pinnedAt ? Date.parse(session.pinnedAt) : Number.NaN;
    const userSendAtMs = session.userSendAt ? Date.parse(session.userSendAt) : Number.NaN;
    const order = sidebarOrder.get(session.id);
    const isActiveCatalog = session.status === 'active';
    const deviceLinkDeviceId = session.deviceLinkDeviceId;
    const remoteActivity =
      deviceLinkDeviceId && session.deviceLinkConnectionStatus !== 'disconnected'
        ? readRemoteActivity(session.id, deviceLinkDeviceId)
        : undefined;
    return {
      id: session.id,
      title: session.title,
      pinnedAt: Number.isFinite(pinnedAtMs) ? pinnedAtMs : null,
      userSendAt: Number.isFinite(userSendAtMs) ? userSendAtMs : null,
      ...(order === undefined ? {} : { sidebarOrder: order }),
      ...(isActiveCatalog ? {} : { catalogEligible: false }),
      ...(deviceLinkDeviceId ? { deviceLinkDeviceId } : {}),
      ...(remoteActivity
        ? { remoteActivity: { phase: remoteActivity.phase, attention: remoteActivity.attention } }
        : {}),
    };
  });
}
