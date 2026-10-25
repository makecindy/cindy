import type { DeviceLinkClient, NotifySender } from '@cindy/device-link';
import { MobileNotifyDeduper, buildSessionNotifyPayload, buildBotGroupNotifyPayload, type MobileSessionEventKind } from './mobileNotify.js';
export interface MobileNotificationSenderHost {
  getClient(): Pick<DeviceLinkClient, 'getSelfDeviceId' | 'sendNotify'> | null;
  getGeneration(): number;
  getControllersForTopic(topic: string): readonly unknown[];
  getSessionNotificationBody(kind: MobileSessionEventKind): string;
  log: { debug(message: string): void };
}
export function createMobileNotificationSender(host: MobileNotificationSenderHost) {
const { log } = host;
const mobileNotifyDeduper = new MobileNotifyDeduper();

/**
 * 会话终态时给本账号已注册推送 token 的手机发系统推送(fire-and-forget)。
 * 静默跳过的场景(返回 false):
 *  - relay 未连接 / server 未声明 notify capability(老 relay,黑洞防护)
 *  - 有控制端正订阅该会话的实时流(session:<id> topic)——人已经在手机上看着这
 *    个会话,系统推送只会重复打扰
 *  - 同 session + kind 5s 短窗去重
 * 手机端是否收得到由手机侧开关决定(注册/注销 token),桌面端不再设第二个开关。
 */
function sendMobileSessionNotify(payload: {
  sessionId: string;
  title: string;
  kind: MobileSessionEventKind;
  /** 内容摘要(最近一条 assistant 内容 / 定时任务结果),缺省回退终态短文案 */
  detail?: string;
  fallbackBody?: string;
  eventId?: string;
  /** 伙伴主任务的 Bot id；让手机按伙伴聊天打开通知。 */
  teammateBotId?: string;
  teammateAvatar?: NotifySender['avatar'];
  /**
   * 发起时捕获的 getMobileNotifyGeneration()。调用路径里有 await(取正文/等
   * 其它通道)时必传:与当前代次不一致说明期间发生过登出/失去持有权,任务
   * 过期丢弃,不得把旧账号的通知发进新账号的链路。
   */
  generation?: number;
}): boolean {
  const client = host.getClient();
  if (!client) return false;
  if (payload.generation !== undefined && payload.generation !== host.getGeneration()) {
    log.debug(
      `mobile notify dropped: link generation changed (account/ownership boundary), session=${payload.sessionId.slice(0, 8)}`,
    );
    return false;
  }
  const selfDeviceId = client.getSelfDeviceId();
  if (!selfDeviceId) return false;
  if (host.getControllersForTopic(`session:${payload.sessionId}`).length > 0) {
    log.debug(
      `mobile notify skipped: session ${payload.sessionId.slice(0, 8)} is being watched remotely`,
    );
    return false;
  }
  const now = Date.now();
  if (!mobileNotifyDeduper.shouldSend(payload.sessionId, payload.kind, now, payload.eventId)) return false;
  const sent = client.sendNotify(
    buildSessionNotifyPayload({
      sessionId: payload.sessionId,
      title: payload.title,
      kind: payload.kind,
      selfDeviceId,
      fallbackBody: payload.fallbackBody ?? host.getSessionNotificationBody(payload.kind),
      detail: payload.detail,
      ...(payload.teammateBotId ? { teammateBotId: payload.teammateBotId } : {}),
      ...(payload.teammateAvatar ? { teammateAvatar: payload.teammateAvatar } : {}),
    }),
  );
  if (sent) {
    mobileNotifyDeduper.recordSent(payload.sessionId, payload.kind, now, payload.eventId);
    log.debug(`mobile notify sent: session=${payload.sessionId.slice(0, 8)} kind=${payload.kind}`);
  }
  return sent;
}

/** Phone push for a 分工 step that stopped for the user (bot-group-chat.md §8.3). */
function sendMobileBotGroupNotify(payload: {
  groupId: string;
  title: string;
  body: string;
  /** Unique per settled step, so a redo of the same step notifies again. */
  eventId: string;
  generation?: number;
}): boolean {
  const client = host.getClient();
  if (!client) return false;
  if (payload.generation !== undefined && payload.generation !== host.getGeneration()) return false;
  const selfDeviceId = client.getSelfDeviceId();
  if (!selfDeviceId) return false;
  const key = `bot-group:${payload.groupId}`;
  const now = Date.now();
  if (!mobileNotifyDeduper.shouldSend(key, 'needs-reply', now, payload.eventId)) return false;
  const sent = client.sendNotify(buildBotGroupNotifyPayload({
    groupId: payload.groupId,
    title: payload.title,
    body: payload.body,
    selfDeviceId,
  }));
  if (sent) mobileNotifyDeduper.recordSent(key, 'needs-reply', now, payload.eventId);
  return sent;
}

return { sendMobileSessionNotify, sendMobileBotGroupNotify };
}
