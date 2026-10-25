import { and, eq, inArray } from 'drizzle-orm';
import { botSessionLinks } from '@cindy/runtime-db/schema';
import { isTerminalAgentErrorEvent, type AgentEvent } from '@cindy/maker-core';
import { createSessionNotificationDelivery } from '@cindy/app-runtime/sessionNotificationDelivery';
import { createSessionNotificationPreview } from '@cindy/app-runtime/sessionNotificationPreview';
import { createNotificationAvatar } from '@cindy/app-runtime/notificationAvatar';
import { createSessionNotificationCopy, type SessionEventKind } from '@cindy/app-runtime/sessionNotificationCopy';
import type { TerminalTaskHost } from './host.js';
import type { TerminalImConnections } from '../im/connections.js';
import type { TerminalDeviceService } from '../remote/service.js';
import type { Logger } from '@cindy/maker-core';

/** Node supplies lifecycle events; transcript selection, deduplication, owner
 * fences and mobile delivery are the original graphical host's services. */
export async function createTerminalTaskNotifications(options: {
  tasks: TerminalTaskHost; im: Pick<TerminalImConnections, 'feishu'>; remote: Pick<TerminalDeviceService, 'getNotificationGeneration' | 'notifications'>;
  t(key: string): string; current(): boolean; logger: Logger;
  emit(channel: string, payload: unknown): void;
  isCompletionHandledByTeammate?(id: string): Promise<boolean>;
}) {
  const { tasks, remote } = options;
  const [database, conversations] = await Promise.all([tasks.database, tasks.conversations]);
  const copy = createSessionNotificationCopy(options.t);
  const preview = createSessionNotificationPreview({ getDbClient: database.getDbClient,
    ...createNotificationAvatar(url => tasks.media.resolveMediaUrl(url)) });
  const delivery = createSessionNotificationDelivery({
    ...copy, ...preview, ...conversations.activeTurn, ...conversations.broadcastTap,
    ...conversations.latest, ...conversations.persistence, log: options.logger,
    getMobileNotifyGeneration: () => remote.getNotificationGeneration(),
    sendMobileSessionNotify: payload => remote.notifications.sendMobileSessionNotify(payload),
    // Node has no Dock badge; terminal clients receive the same attention event.
    markSessionNeedsAttention: id => tasks.sessionActivity.attention.markSessionNeedsAttention(id),
    showDesktopSessionEvent: (_window: () => null, payload) => { options.emit('terminal:notification', payload); return true; },
  }).createHandler({ getWindow: () => null, feishuIm: options.im.feishu,
    isCompletionHandledByTeammate: options.isCompletionHandledByTeammate });
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const origins = new Map<string, string | undefined>();
  let closed = false;
  const current = () => !closed && options.current();
  const cancel = (id: string) => { clearTimeout(timers.get(id)); timers.delete(id); };
  const notify = async (id: string, kind: SessionEventKind) => {
    if (!current()) return;
    const snapshot = tasks.sessionActivity.service.getSessionActivitySnapshot(id);
    if ((kind === 'done' && (snapshot?.phase !== 'completed' || !snapshot.attention))
      || (kind === 'error' && snapshot?.phase !== 'error')) return;
    const row = await tasks.storage.get(id);
    if (!current() || !row || row.deleted || row.archived || row.hiddenAt || row.source === 'review'
      || (kind === 'done' && (row.orcaRole === 'worker' || row.orcaRemoteLead))) return;
    const lane = await database.getDbClient().drizzle.select({ id: botSessionLinks.id }).from(botSessionLinks)
      .where(and(eq(botSessionLinks.sessionId, id), inArray(botSessionLinks.role, ['group', 'channel']))).get();
    if (lane || !current()) return;
    await delivery({ sessionId: id, title: row.title ?? copy.getSessionNotificationUntitled(), kind,
      channels: { desktop: true, mobile: true, feishu: false } });
  };
  const event = (channel: string, payload: unknown) => {
    if (!current() || !payload || typeof payload !== 'object') return;
    const value = payload as { sessionId?: string; event?: AgentEvent; request?: { kind?: string; requestId?: string; stepNumber?: number; terminal?: boolean } };
    const id = value.sessionId;
    if (!id) return;
    if (channel === 'maker:interaction-request') {
      if (value.request?.terminal) return;
      cancel(id);
      if (value.request?.kind === 'input_handoff') {
        const generation = remote.getNotificationGeneration();
        const eventId = `input-handoff:${value.request.requestId}:${value.request.stepNumber}`;
        void Promise.all([tasks.storage.get(id), preview.readSessionNotificationPreview(id, false)]).then(([row, identity]) => {
          if (!current() || !row) return;
          remote.notifications.sendMobileSessionNotify({ sessionId: id, title: identity.teammateName ?? row.title ?? copy.getSessionNotificationUntitled(),
            kind: 'needs-reply', generation, eventId, fallbackBody: copy.getInputHandoffNotificationBody(),
            ...(identity.teammateBotId ? { teammateBotId: identity.teammateBotId } : {}) });
        }).catch(() => options.logger.warn('TASK_NOTIFICATION_FAILED'));
      } else void notify(id, 'needs-reply').catch(() => options.logger.warn('TASK_NOTIFICATION_FAILED'));
      return;
    }
    if (channel !== 'maker:event' || !value.event) return;
    const agentEvent = value.event;
    const data = agentEvent.data as { isRunning?: boolean; sideTask?: boolean; silentStop?: boolean } | null;
    if (agentEvent.type === 'status' && data?.isRunning) {
      cancel(id); origins.set(id, tasks.notificationOrigin(id)); return;
    }
    const kind = agentEvent.type === 'done' ? 'done' : isTerminalAgentErrorEvent(agentEvent) ? 'error' : null;
    if (!kind || data?.sideTask || data?.silentStop || origins.get(id) === 'scheduler') return;
    cancel(id);
    // Same queue-drain grace as the graphical notification observer. A new
    // turn cancels the pending notice; explicit stop never creates one.
    const timer = setTimeout(() => {
      timers.delete(id);
      if (!current() || tasks.notificationHasActiveWork(id)) return;
      void notify(id, kind).catch(() => options.logger.warn('TASK_NOTIFICATION_FAILED'));
    }, kind === 'done' ? 500 : 0);
    timer.unref(); timers.set(id, timer);
  };
  return { event, notify, close() { closed = true; for (const id of timers.keys()) cancel(id); origins.clear(); } };
}
