import type { FeishuIM } from '@cindy/im';
import type { DbLogger } from '@cindy/runtime-db/logging';
import { notificationPreview } from './notificationPreview.js';
import type { SessionNotificationPreview, createSessionNotificationPreview } from './sessionNotificationPreview.js';
import type { createSessionActiveTurn } from './sessionActiveTurn.js';
import type { createMobileNotificationSender } from './mobileNotificationSender.js';
import type { createSessionNotificationCopy, SessionEventKind } from './sessionNotificationCopy.js';
export interface NotificationServiceDeps<Window = unknown> {
  isCompletionHandledByTeammate?: (id: string) => Promise<boolean>;
  getWindow(): Window | null;
  feishuIm: FeishuIM;
}
export interface NotificationDeliveryHost<Window, Scope extends { ownerScopeKey?: string | null; ownerStamp?: unknown }> {
  log: DbLogger;
  getMobileNotifyGeneration(): number;
  sendMobileSessionNotify: ReturnType<typeof createMobileNotificationSender>['sendMobileSessionNotify'];
  getSessionNotificationTurnSignal: ReturnType<typeof createSessionActiveTurn>['getSessionNotificationTurnSignal'];
  drainSessionActiveTurnWrites: ReturnType<typeof createSessionActiveTurn>['drainSessionActiveTurnWrites'];
  readSessionNotificationPreview: ReturnType<typeof createSessionNotificationPreview>['readSessionNotificationPreview'];
  captureDataOwnerBroadcastScope(): Scope;
  isDataOwnerBroadcastScopeCurrent(scope: Scope): boolean;
  drainPersistQueue(): Promise<void>;
  markSessionNeedsAttention(id: string): void;
  showDesktopSessionEvent(getWindow: () => Window | null, payload: {sessionId: string; title: string; kind: SessionEventKind; teammate?: boolean; markAttention?: boolean; body?: string; avatarJpeg?: string}): boolean;
  companionAvatarThumbnail?(value: string): Promise<string | undefined>;
  getTeammateNotificationFallback: ReturnType<typeof createSessionNotificationCopy>['getTeammateNotificationFallback'];
  getNotificationImageLabel: ReturnType<typeof createSessionNotificationCopy>['getNotificationImageLabel'];
  getSessionExternalNotificationText: ReturnType<typeof createSessionNotificationCopy>['getSessionExternalNotificationText'];
}
export interface ShowSessionEventPayload {
  sessionId: string;
  title: string;
  kind: SessionEventKind;
  /**
   * 渠道偏好。renderer 侧 gate 后填入,缺省时按"仅桌面"兼容,防御漏传——
   * 当前唯一 invoke 调用方 CCAgentSidebarUpper.tsx 总是显式传 channels,
   * 这层 default 仅为新增调用方留兜底。
   * mobile 通道没有桌面侧开关:是否收到由手机端自行注册/注销推送 token 决定,
   * 发送侧的防打扰(远程正在看该会话 / 短窗去重)在 device-link 模块内收口。
   */
  channels?: { desktop?: boolean; feishu?: boolean; mobile?: boolean };
  /** 其它设备的任务传 false:未读归属那台设备,不记本机 Dock 角标。 */
  markAttention?: boolean;
}

export function createSessionNotificationDelivery<Window, Scope extends { ownerScopeKey?: string | null; ownerStamp?: unknown }>(host: NotificationDeliveryHost<Window, Scope>) {
  const { log, getMobileNotifyGeneration, sendMobileSessionNotify, getSessionNotificationTurnSignal,
    drainSessionActiveTurnWrites, readSessionNotificationPreview, captureDataOwnerBroadcastScope,
    isDataOwnerBroadcastScopeCurrent, drainPersistQueue, markSessionNeedsAttention,
    showDesktopSessionEvent, getTeammateNotificationFallback, getNotificationImageLabel, getSessionExternalNotificationText } = host;
type NotifiedReply = ({ eventId: string } | { fallbackSentAt: number }) & { handledByTeammate?: true };
const notifiedReplies = new Map<string, NotifiedReply>();
const pendingFeishuReplies = new Set<string>();
const pendingFeishuFallbacks = new Map<string, number>();
type ReplyNotificationChannel = 'desktop' | 'mobile' | 'feishu';

function replyNotificationKey(scope: string | number, sessionId: string, channel: ReplyNotificationChannel): string {
  return `${scope}:${sessionId}:${channel}`;
}

function wasReplyNotified(key: string, eventId: string | undefined): boolean {
  const notified = notifiedReplies.get(key);
  if (!notified) return false;
  if (!eventId) return !('eventId' in notified);
  if ('eventId' in notified) return notified.eventId === eventId;
  // An accepted fallback had no DB identity. Once persistence recovers,
  // reconcile it with the turn that was already running when sent.
  // A turn started afterwards is new, even if it finishes immediately.
  const startedAt = /^turn:(\d+):\d+$/.exec(eventId)?.[1];
  if (startedAt && Number(startedAt) < notified.fallbackSentAt) {
    notifiedReplies.set(key, { eventId, ...(notified.handledByTeammate ? { handledByTeammate: true as const } : {}) });
    return true;
  }
  return false;
}

function isFeishuReplyPending(key: string, eventId: string | undefined): boolean {
  if (pendingFeishuReplies.has(`${key}:${eventId ?? 'pending'}`)) return true;
  const fallbackSentAt = pendingFeishuFallbacks.get(key);
  if (fallbackSentAt === undefined || !eventId) return false;
  const startedAt = /^turn:(\d+):\d+$/.exec(eventId)?.[1];
  return startedAt !== undefined && Number(startedAt) < fallbackSentAt;
}
// A slow transcript must not indefinitely hide a completion or an action request.
const NOTIFICATION_PREVIEW_WAIT_MS = 1_000;


function createHandler(deps: NotificationServiceDeps<Window>) {
const { getWindow, feishuIm } = deps;
return async function showSessionEvent(payload: ShowSessionEventPayload): Promise<void> {

      // renderer payload 不可信:mobile 通道会把 title/kind 送出本机(经 relay/APNs),
      // main 必须做运行时形状校验,TS 类型不算(electron-security 规则)。正文摘要
      // 不来自 renderer(main 侧读库),relay 有 per-user 频控、main 侧另有 5s
      // 去重与「被远程观看则不推」收口。
      assertValidSessionEventPayload(payload);
      const { sessionId, title, kind, channels } = payload;
      const markAttention = payload.markAttention !== false;
      const generation = getMobileNotifyGeneration();
      // Capture at IPC arrival, not after the asynchronous preview: a newer
      // turn can begin while the current completion waits on persistence.
      const signal = kind === 'done' ? getSessionNotificationTurnSignal(sessionId) : undefined;
      // A late idle for the previous turn must not claim the identity of a
      // newer turn that is still running, even if preview persistence stalls.
      if (signal && !signal.ended) return;
      const ownerScope = captureDataOwnerBroadcastScope();
      const safeTitle = title.trim() || sessionId.slice(0, 8);
      const wantDesktop = channels?.desktop ?? true;
      const wantFeishu = channels?.feishu === true;
      if (markAttention) markSessionNeedsAttention(sessionId);

      // Content is read from main's transcript. Bound only enrichment, not delivery;
      // a timeout is not a dedupe window and never causes a second late toast.
      void (async () => {
        let preview: SessionNotificationPreview | undefined;
        // Only routes the phone to the teammate chat; titles and fallbacks stay per kind.
        let teammateBotId: string | undefined;
        let postDrainPreviewReady = false;
        let detail: string | undefined;
        let avatarJpeg: string | undefined;
        if (kind === 'done' || wantDesktop || channels?.mobile === true) {
          let finished = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const readAvatar = async (identity: SessionNotificationPreview) => {
            if (!wantDesktop) return;
            const avatar = identity.teammateAvatar;
            const jpeg = avatar?.kind === 'jpeg' ? avatar.value
              : avatar?.kind === 'preset' ? await host.companionAvatarThumbnail?.(`cindy://avatar/preset/${avatar.value}`) : undefined;
            if (!finished) avatarJpeg = jpeg;
          };
          // Routing is optional: read it beside the reply so it never spends the
          // preview's wait window, and a failed identity read costs nothing.
          const routeRead = kind !== 'done'
            ? readSessionNotificationPreview(sessionId, false, true).then(
              async (identity) => { if (!finished) { teammateBotId = identity.teammateBotId; preview = identity; await readAvatar(identity); } },
              () => undefined)
            : undefined;
          try {
            await Promise.race([
              Promise.all([(async () => {
                if (kind !== 'done') return;
                if (kind === 'done') {
                  // Read the teammate identity first so a blocked write still
                  // has the correct fallback. This snapshot may predate the
                  // terminal marker, so its turn ID is not authoritative.
                  const identity = await readSessionNotificationPreview(sessionId, false);
                  // The turn marker may still be queued separately from the
                  // message broadcaster. Keep only the teammate name here;
                  // an old event ID must never identify this completion.
                  preview = { teammateName: identity.teammateName };
                  teammateBotId = identity.teammateBotId;
                }
                if (finished || !isDataOwnerBroadcastScopeCurrent(ownerScope)) return;
                await drainPersistQueue();
                if (kind === 'done') await drainSessionActiveTurnWrites(sessionId);
                if (finished || !isDataOwnerBroadcastScopeCurrent(ownerScope)) return;
                if (kind === 'done') {
                  preview = await readSessionNotificationPreview(sessionId);
                  postDrainPreviewReady = true;
                  detail = preview.reply?.text;
                  await readAvatar(preview);
                }
              })(), routeRead]),
              new Promise<void>((resolve) => { timer = setTimeout(resolve, NOTIFICATION_PREVIEW_WAIT_MS); }),
            ]);
          } catch (err) {
            log.warn('[notification] preview unavailable; using fallback', err);
          } finally {
            finished = true;
            clearTimeout(timer);
          }
        }
        if (!isDataOwnerBroadcastScopeCurrent(ownerScope)) return;
        // Preview enrichment can outlive an entire later turn. Never send that
        // later reply under the terminal signal captured for this IPC event.
        const currentSignal = kind === 'done' ? getSessionNotificationTurnSignal(sessionId) : undefined;
        if (kind === 'done') {
          if (currentSignal?.id !== signal?.id || (currentSignal && !currentSignal.ended)) return;
        }
        if (postDrainPreviewReady && preview?.suppress) {
          // The terminal marker write may have failed after the in-memory turn
          // already ended. Keep its generic notice, but never use old DB text.
          if (kind !== 'done' || !signal?.ended || currentSignal?.id !== signal.id) return;
          detail = undefined;
        }
        const teammate = !!preview?.teammateName;
        const notificationTitle = preview?.teammateName ?? safeTitle;
        const eventId = signal?.id ?? preview?.eventId;
        const mobileEventId = preview?.eventId ?? signal?.fallbackEventId;
        // A device-link handoff advances only the mobile send generation. It
        // must not make an already accepted desktop/Feishu reply eligible again.
        const ownerKey = ownerScope.ownerScopeKey ?? JSON.stringify(ownerScope.ownerStamp ?? null);
        const desktopKey = replyNotificationKey(ownerKey, sessionId, 'desktop');
        const mobileKey = replyNotificationKey(generation, sessionId, 'mobile');
        const feishuKey = replyNotificationKey(ownerKey, sessionId, 'feishu');
        if (kind === 'done' && notifiedReplies.get(desktopKey)?.handledByTeammate && wasReplyNotified(desktopKey, eventId)) return;
        // Decide at the send boundary, after preview enrichment. The native
        // receipt and durable completion handoff are authoritative, never titles.
        const handledByTeammate = kind === 'done' && deps.isCompletionHandledByTeammate
          ? await deps.isCompletionHandledByTeammate(sessionId).catch((error) => {
              log.warn('delegation completion notification check failed', { error: String(error) });
              return false;
            }) : false;
        if (!isDataOwnerBroadcastScopeCurrent(ownerScope)) return;
        if (kind === 'done' && deps.isCompletionHandledByTeammate) {
          const afterHandoffSignal = getSessionNotificationTurnSignal(sessionId);
          if (afterHandoffSignal?.id !== signal?.id || (afterHandoffSignal && !afterHandoffSignal.ended)) return;
        }
        if (kind === 'done' && handledByTeammate) {
          // Consume this event in the existing per-channel ledger. Removing a
          // delegation later must not replay a completion already handed off.
          for (const key of [desktopKey, mobileKey, feishuKey]) {
            notifiedReplies.set(key, eventId ? { eventId, handledByTeammate: true } : { fallbackSentAt: Date.now(), handledByTeammate: true });
          }
          return;
        }
        const fallbackBody = teammate && kind === 'done' ? getTeammateNotificationFallback() : undefined;
        const mobileTeammateBotId = preview?.teammateBotId ?? teammateBotId;
        if (wantDesktop && (kind !== 'done' || !wasReplyNotified(desktopKey, eventId))) {
          try {
            const accepted = showDesktopSessionEvent(getWindow, {
              sessionId, title: notificationTitle, kind, teammate, markAttention, avatarJpeg,
              body: teammate ? notificationPreview(detail ?? '', 240, getNotificationImageLabel()) || fallbackBody : undefined,
            });
            if (kind === 'done' && accepted) {
              notifiedReplies.set(desktopKey, eventId ? { eventId } : { fallbackSentAt: Date.now() });
            }
          } catch (err) {
            log.warn('[notification] desktop reply notification failed (non-fatal)', err);
          }
        }
        if (channels?.mobile === true && (kind !== 'done' || !wasReplyNotified(mobileKey, eventId))) {
          try {
            const accepted = sendMobileSessionNotify({
              sessionId, title: notificationTitle, kind, generation, ...(detail ? { detail } : {}),
              ...(fallbackBody ? { fallbackBody } : {}), ...(mobileEventId ? { eventId: mobileEventId } : {}),
              ...(mobileTeammateBotId ? { teammateBotId: mobileTeammateBotId } : {}),
              ...(preview?.teammateAvatar ? { teammateAvatar: preview.teammateAvatar } : {}),
            });
            if (kind === 'done' && accepted) {
              notifiedReplies.set(mobileKey, eventId ? { eventId } : { fallbackSentAt: Date.now() });
            }
          } catch (err) {
            log.warn('[notification] mobile reply notification failed (non-fatal)', err);
          }
        }
        if (wantFeishu && kind === 'done' && !wasReplyNotified(feishuKey, eventId)) {
          const pendingKey = `${feishuKey}:${eventId ?? 'pending'}`;
          if (!isFeishuReplyPending(feishuKey, eventId)) {
            pendingFeishuReplies.add(pendingKey);
            if (!eventId) pendingFeishuFallbacks.set(feishuKey, Date.now());
            try {
              const body = teammate ? notificationPreview(detail ?? '', 240, getNotificationImageLabel()) || fallbackBody : undefined;
              const accepted = await sendFeishuMessage(feishuIm, notificationTitle, kind, body);
              if (accepted) {
                notifiedReplies.set(feishuKey, eventId ? { eventId } : { fallbackSentAt: Date.now() });
              }
            } finally {
              pendingFeishuReplies.delete(pendingKey);
              if (!eventId) pendingFeishuFallbacks.delete(feishuKey);
            }
          }
        }
      })().catch((err) => log.warn('[notification] reply notification failed (non-fatal)', err));

      if (wantFeishu && kind !== 'done') {
        await sendFeishuMessage(feishuIm, safeTitle, kind);
      }

};
}
const SESSION_EVENT_KINDS: ReadonlySet<string> = new Set(['done', 'error', 'needs-reply']);
const SESSION_ID_MAX_LENGTH = 256;
const SESSION_TITLE_MAX_LENGTH = 1024;

/** show-session-event 的运行时校验:非法直接抛(invoke reject),不进任何通知通道。 */
function assertValidSessionEventPayload(
  payload: unknown,
): asserts payload is ShowSessionEventPayload {
  const p = payload as Partial<ShowSessionEventPayload> | null;
  if (
    !p ||
    typeof p !== 'object' ||
    typeof p.sessionId !== 'string' ||
    p.sessionId.length === 0 ||
    p.sessionId.length > SESSION_ID_MAX_LENGTH ||
    typeof p.title !== 'string' ||
    p.title.length > SESSION_TITLE_MAX_LENGTH ||
    typeof p.kind !== 'string' ||
    !SESSION_EVENT_KINDS.has(p.kind) ||
    (p.channels !== undefined && (typeof p.channels !== 'object' || p.channels === null)) ||
    (p.markAttention !== undefined && typeof p.markAttention !== 'boolean')
  ) {
    throw new TypeError('invalid session event payload');
  }
}

async function sendFeishuMessage(
  feishuIm: FeishuIM,
  safeTitle: string,
  kind: SessionEventKind,
  teammateBody?: string,
): Promise<boolean> {
  const ownerOpenId = feishuIm.getOwnerOpenId();
  if (!ownerOpenId) {
    log.warn('[notification] feishu skipped: no bot owner bound (user must DM the bot once)');
    return false;
  }
  try {
    if (teammateBody) {
      await feishuIm.sendText(ownerOpenId, `${safeTitle}\n${teammateBody}`);
    } else {
      await feishuIm.sendMarkdownText(
        ownerOpenId,
        getSessionExternalNotificationText(safeTitle, kind),
      );
    }
    return true;
  } catch (err) {
    // 飞书 SDK 包了一层 axios; 400 等业务错误的真正 message 在 response.data 里,
    // 显式拆出来 log。与 scheduler-host/notifier.ts 的 catch 写法对齐。
    const r = (err as { response?: { data?: unknown; status?: number } }).response;
    log.warn(
      `[notification] feishu send failed status=${r?.status ?? 'n/a'} body=${JSON.stringify(r?.data ?? null)} target=...${ownerOpenId.slice(-8)}`,
    );
    return false;
  }
}

return { createHandler };
}
