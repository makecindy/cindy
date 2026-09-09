import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  subscribeDataOwnerGeneration,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { getAgentIslandEnabled, isAgentIslandSupported } from '@/hooks/useAgentIslandSettings';
import { getFeishuNotificationsEnabled } from '@/hooks/useFeishuNotificationSettings';
import {
  getNotificationsEnabled,
  getSoundNotificationsEnabled,
} from '@/hooks/useNotificationSettings';
import { playSessionEventSound } from '@/lib/notificationSound';

export type SessionEventNotificationKind = 'done' | 'error' | 'needs-reply';

/** Resolve Bot-owned tasks omitted from the ordinary desktop session list. */
export async function botOwnedSessionNotificationTitle(sessionId: string): Promise<string | null> {
  const bots = await window.electronAPI.localDb.bots.list().catch(() => []);
  if (!Array.isArray(bots)) return null;
  for (const candidate of bots) {
    if (!candidate || typeof candidate !== 'object') continue;
    const bot = candidate as { name?: unknown; sessions?: unknown };
    if (typeof bot.name !== 'string' || !Array.isArray(bot.sessions)) continue;
    const session = bot.sessions.find(
      (row) => !!row && typeof row === 'object' && (row as { id?: unknown }).id === sessionId,
    ) as { title?: unknown } | undefined;
    if (!session) continue;
    const sessionTitle = typeof session.title === 'string' ? session.title.trim() : '';
    return sessionTitle && sessionTitle !== bot.name ? `${bot.name} · ${sessionTitle}` : bot.name;
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
  ownerAtNotification: DataOwnerGeneration = getDataOwnerGeneration(),
): Promise<void> {
  // The user is already looking at Cindy. In-app attention remains available,
  // but an OS/external notification would be duplicate noise.
  if (typeof document !== 'undefined' && document.hasFocus()) return Promise.resolve();

  const islandActive = isAgentIslandSupported() && getAgentIslandEnabled();
  const desktopEnabled = getNotificationsEnabled() && !islandActive;
  const feishuEnabled = getFeishuNotificationsEnabled();
  const soundRequested = getSoundNotificationsEnabled() && !islandActive;

  const send = async (): Promise<void> => {
    // The local sound may wait for autoplay permission or resource startup. Abort
    // it when the user returns to Cindy, then suppress the whole external event.
    let suppressSystemSound = false;
    if (soundRequested) {
      const focusAbortController = new AbortController();
      const abortPendingSound = () => focusAbortController.abort();
      window.addEventListener('focus', abortPendingSound, { once: true });
      const unsubscribeOwnerChange = subscribeDataOwnerGeneration(abortPendingSound);
      try {
        // Recheck after installing the cancellation hooks so an account switch
        // cannot start the old owner's sound at this async boundary.
        if (!isDataOwnerGenerationCurrent(ownerAtNotification)) return;
        suppressSystemSound = await playSessionEventSound(kind, focusAbortController.signal);
      } finally {
        window.removeEventListener('focus', abortPendingSound);
        unsubscribeOwnerChange();
      }
    }

    // The sound wait is an async boundary: do not deliver an old event after the
    // user focuses Cindy or the renderer switches to another account.
    if (typeof document !== 'undefined' && document.hasFocus()) return;
    if (!isDataOwnerGenerationCurrent(ownerAtNotification)) return;

    void window.electronAPI.notificationMarkSessionAttention(sessionId);
    void window.electronAPI.notificationShowSessionEvent({
      sessionId,
      title,
      kind,
      channels: {
        desktop: desktopEnabled,
        feishu: feishuEnabled,
        // Mobile owns registration/unregistration of its push token. There is
        // deliberately no second desktop setting for the same channel.
        mobile: true,
        sound: suppressSystemSound,
      },
    });
  };

  return send();
}
