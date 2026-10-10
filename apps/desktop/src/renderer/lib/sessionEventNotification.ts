import { getAgentIslandEnabled, isAgentIslandSupported } from '@/hooks/useAgentIslandSettings';
import { getFeishuNotificationsEnabled } from '@/hooks/useFeishuNotificationSettings';
import { getNotificationsEnabled } from '@/hooks/useNotificationSettings';
import { isDefaultDraftSessionTitle } from '@cindy/maker-shared/session-title';
import { getRemoteSessionActivity, subscribeRemoteSessionActivity } from '@/features/device-link/remoteSessionActivityStore';

export type SessionEventNotificationKind = 'done' | 'error' | 'needs-reply';

/** Find a session in the snapshots available to a notification owner. */
export function findSessionNotificationSession<T extends { id: string; title?: unknown }>(
  sessionId: string,
  sources: readonly (readonly T[])[],
): T | null {
  let fallback: T | null = null;
  for (const source of sources) {
    const session = source.find((candidate) => candidate.id === sessionId);
    if (!session) continue;
    fallback ??= session;

    // A stale visible snapshot can still contain the session with its initial
    // placeholder title. Keep looking for a complete or remote snapshot with
    // a title that can be shown in the notification.
    if (
      typeof session.title === 'string'
      && session.title.trim()
      && !isDefaultDraftSessionTitle(session.title)
    ) {
      return session;
    }
  }
  return fallback;
}

/**
 * Returned instead of a title for a Bot's hidden group lane. Group lanes never
 * reach OS / external notifications (docs/product-rules/bot-group-chat.md §3);
 * the group chat itself shows the lane's pending confirmation.
 */
export const BOT_GROUP_LANE_SESSION: unique symbol = Symbol('bot-group-lane-session');

/** Resolve Bot-owned tasks omitted from the ordinary desktop session list. */
export async function botOwnedSessionNotificationTitle(
  sessionId: string,
): Promise<string | null | typeof BOT_GROUP_LANE_SESSION> {
  const bots = await window.electronAPI.localDb.bots.list().catch(() => []);
  if (!Array.isArray(bots)) return null;
  for (const candidate of bots) {
    if (!candidate || typeof candidate !== 'object') continue;
    const bot = candidate as { name?: unknown; sessions?: unknown };
    if (typeof bot.name !== 'string' || !Array.isArray(bot.sessions)) continue;
    const session = bot.sessions.find((row) =>
      !!row
      && typeof row === 'object'
      && (row as { id?: unknown }).id === sessionId,
    ) as { title?: unknown; role?: unknown; kind?: unknown } | undefined;
    if (!session) continue;
    if (session.role === 'group' || session.kind === 'group') return BOT_GROUP_LANE_SESSION;
    const sessionTitle = typeof session.title === 'string' ? session.title.trim() : '';
    return sessionTitle && sessionTitle !== bot.name
      ? `${bot.name} · ${sessionTitle}`
      : bot.name;
  }
  return null;
}

/**
 * Single renderer-side owner for the delivery gates shared by every session
 * list. The list that currently owns the sidebar observes transitions; this
 * helper keeps desktop, Feishu, mobile and Dock semantics identical.
 */
export function sendSessionEventNotification(
  sessionId: string,
  title: string,
  kind: SessionEventNotificationKind,
  options: {
    /**
     * 其它设备的任务:桌面通知 / 灵动岛由 main 按「任务范围」统一发
     * (agentIslandRemoteSessions),这里不再弹;未读归属那台设备,不记本机 Dock 角标。
     */
    remoteDevice?: boolean;
    remoteDeviceId?: string | null;
  } = {},
): void {
  // The user is already looking at Cindy. In-app attention remains available,
  // but an OS/external notification would be duplicate noise.
  if (typeof document !== 'undefined' && document.hasFocus()) return;

  if (kind === 'done' && options.remoteDeviceId) {
    sendRemoteCompletionNotification(sessionId, options.remoteDeviceId, () =>
      deliverSessionEventNotification(sessionId, title, kind, true));
    return;
  }

  deliverSessionEventNotification(sessionId, title, kind, options.remoteDevice === true);
}

const pendingRemoteCompletions = new Map<string, () => void>();

/** The execution host owns this decision; the controller has no delegation DB row. */
function sendRemoteCompletionNotification(sessionId: string, deviceId: string, deliver: () => void): void {
  const key = JSON.stringify([deviceId, sessionId]);
  if (pendingRemoteCompletions.has(key)) return;
  const activity = getRemoteSessionActivity(sessionId, deviceId);
  if (activity?.phase === 'completed' && activity.completionNotification === 'teammate') return;
  if (activity?.phase === 'error' || activity?.phase === 'needs-interaction') return;
  if (!activity || (activity.phase === 'completed' && activity.completionNotification !== 'pending')) {
    deliver(); // Older hosts retain their original notification behavior.
    return;
  }
  let sawPendingCompletion = activity.phase === 'completed';
  const cancel = subscribeRemoteSessionActivity((changedDeviceId, changedSessionId) => {
    if (changedDeviceId && changedDeviceId !== deviceId) return;
    if (changedSessionId && changedSessionId !== sessionId) return;
    const latest = getRemoteSessionActivity(sessionId, deviceId);
    if (latest?.phase === 'completed' && latest.completionNotification === 'pending') {
      sawPendingCompletion = true;
      return;
    }
    if (latest?.phase === 'running' && !sawPendingCompletion) return;
    cancel();
    pendingRemoteCompletions.delete(key);
    // Read, disconnect, error, interaction or a replacement turn supersedes this
    // completion request. Only the source's resolved ordinary completion sends.
    if (latest?.phase === 'completed' && latest.completionNotification !== 'teammate') deliver();
  });
  pendingRemoteCompletions.set(key, cancel);
}

function deliverSessionEventNotification(sessionId: string, title: string, kind: SessionEventNotificationKind, remoteDevice: boolean): void {
  // A handoff can finish after the user has opened Cindy or changed preferences.
  if (typeof document !== 'undefined' && document.hasFocus()) return;

  const islandActive = isAgentIslandSupported() && getAgentIslandEnabled();
  if (!remoteDevice) void window.electronAPI.notificationMarkSessionAttention(sessionId);
  void window.electronAPI.notificationShowSessionEvent({
    sessionId,
    title,
    kind,
    ...(remoteDevice ? { markAttention: false } : {}),
    channels: {
      desktop: !remoteDevice && getNotificationsEnabled() && !islandActive,
      feishu: getFeishuNotificationsEnabled(),
      // Mobile owns registration/unregistration of its push token. There is
      // deliberately no second desktop setting for the same channel.
      mobile: true,
    },
  });
}
