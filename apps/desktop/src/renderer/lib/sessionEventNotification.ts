import { getAgentIslandEnabled, isAgentIslandSupported } from '@/hooks/useAgentIslandSettings';
import { getFeishuNotificationsEnabled } from '@/hooks/useFeishuNotificationSettings';
import { getNotificationsEnabled } from '@/hooks/useNotificationSettings';
import { isDefaultDraftSessionTitle } from '@cindy/maker-shared/session-title';

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

/** Resolve Bot-owned tasks omitted from the ordinary desktop session list. */
export async function botOwnedSessionNotificationTitle(
  sessionId: string,
): Promise<string | null> {
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
    ) as { title?: unknown } | undefined;
    if (!session) continue;
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
): void {
  // The user is already looking at Cindy. In-app attention remains available,
  // but an OS/external notification would be duplicate noise.
  if (typeof document !== 'undefined' && document.hasFocus()) return;

  const islandActive = isAgentIslandSupported() && getAgentIslandEnabled();
  void window.electronAPI.notificationMarkSessionAttention(sessionId);
  void window.electronAPI.notificationShowSessionEvent({
    sessionId,
    title,
    kind,
    channels: {
      desktop: getNotificationsEnabled() && !islandActive,
      feishu: getFeishuNotificationsEnabled(),
      // Mobile owns registration/unregistration of its push token. There is
      // deliberately no second desktop setting for the same channel.
      mobile: true,
    },
  });
}
