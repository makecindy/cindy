/**
 * notificationService — 系统级桌面通知（CC Agent session 完成 / 待回复提醒）
 * ---------------------------------------------------------------------------
 * 主进程层。提供单一 IPC handler `notification:show-session-event`：
 *   - macOS / Linux / Windows：统一走 Electron 原生 `Notification`。
 *   - 点通知后通过持久到 renderer 就绪的 deep-link 队列打开原任务及其所属电脑。
 *   - 飞书通道：payload.channels.feishu === true 时通过 feishuIm 给当前 owner
 *     私聊发通知。伙伴回复用纯文本，普通任务沿用 markdown；复用现有 IM API。
 *
 * Windows AUMID（AppUserModelID）契约：
 *   - 运行时由 main/bootstrap-electron.ts 通过 `app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID)`
 *     声明；安装态由 NSIS（forge.config.ts 里的 `appId`）写到 Start Menu 快捷方式
 *     `System.AppUserModel.ID` 属性上。两边必须一致，Windows 通知中枢才会
 *     接收并显示对应 toast，否则会被静默丢弃（连 Action Center 都收不到）。
 *   - dev 下 electron.exe 启动没有 NSIS 装的快捷方式，原生 toast 可能不弹——
 *     把 dev 环境当成"通知功能要在 packaged 构建里测"即可，不再额外兜底。
 *
 * 通知偏好仍由 renderer 的 localStorage 持久化。普通会话在 renderer gate 后通过
 * payload.channels 分发；scheduler 从 main 直接发桌面通知，因此 renderer 会把
 * `notifications.enabled` 的当前值轻量同步到 main。飞书仍只按调用方 channels 分发，
 * 且额外要求 ownerOpenId 存在（TOFU 绑定前不发，只 warn）。
 */

import { app, ipcMain, nativeImage, Notification, type BrowserWindow } from 'electron';
import type { FeishuIM } from '@cindy/im';
import * as path from 'node:path';

import { markSessionNeedsAttention } from './appBadgeService';
import { getMobileNotifyGeneration, sendMobileSessionNotify } from './device-link';
import { notificationPreview } from './notificationPreview';
import { companionAvatarThumbnail } from './agent-island/companionIdentity';
import { getDeepLinkMainWindow, openMainWindowChatMessage, openMainWindowSession } from './deepLink';
import { isSessionNotificationsMutedSync } from './localDb/sessionFlagRegistry';
import type { ChatMessageNotification } from './maker-ipc/chatMessageNotifications';
import { readSessionNotificationPreview, type SessionNotificationPreview } from './localDb/sessionNotificationPreview';
import { drainSessionActiveTurnWrites, getSessionNotificationTurnSignal } from './localDb/sessionActiveTurn';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from './device-link/broadcast-tap';
import { drainPersistQueue } from './messagePersistBroadcaster.desktop';
import { getInputHandoffNoticeOwnership } from './im/shared/inputHandoffChannelNotice';
import { createLogger } from './logger';
import {
  getNotificationImageLabel,
  getSessionExternalNotificationText,
  getSessionNotificationBody,
  getTeammateNotificationFallback,
  getSessionNotificationUntitled,
  type SessionEventKind,
} from './sessionNotificationCopy';

export type { SessionEventKind } from './sessionNotificationCopy';

const log = createLogger('notificationService');
let desktopNotificationsEnabled = true;
let shouldSilenceTaskNotification: (kind: SessionEventKind) => boolean = () => false;

/** Renderer owns persistence; main keeps the current value for scheduler-originated toasts. */
export function getDesktopNotificationsEnabled(): boolean {
  return desktopNotificationsEnabled;
}

/** Chat uses the same system permission and global desktop preference as task notifications. */
export async function showDesktopChatMessage(payload: ChatMessageNotification, current: () => boolean): Promise<void> {
  const visible = () => {
    // A group URL cannot tell which side-panel thread is being read. Thread
    // notifications rely on the consumer's authoritative read-receipt check.
    if (payload.threadRootId) return false;
    const window = getDeepLinkMainWindow();
    if (!window?.isFocused() || !window.isVisible()) return false;
    try { return new URL(window.webContents.getURL()).hash.split('?')[0] === `#/bots/groups/${payload.groupId}`; }
    catch { return false; }
  };
  if (!current() || !desktopNotificationsEnabled || visible() || !Notification.isSupported()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const thumbnail = await Promise.race([
    companionAvatarThumbnail(payload.avatar).catch(() => undefined),
    new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 600); }),
  ]).finally(() => clearTimeout(timer));
  if (!current() || !desktopNotificationsEnabled || visible()) return;
  const icon = thumbnail ? nativeImage.createFromBuffer(Buffer.from(thumbnail, 'base64')) : undefined;
  const notification = new Notification({ title: payload.conversationKind === 'direct' ? payload.senderName : [payload.groupName,payload.threadName].filter(Boolean).join(' · '),
    body: payload.conversationKind === 'direct' ? payload.preview : [payload.senderName,payload.preview].filter(Boolean).join(': '),
    ...(icon && !icon.isEmpty() ? { icon } : devNotificationIcon ? { icon: devNotificationIcon } : {}),
  });
  liveNotifications.add(notification);
  const release = () => { liveNotifications.delete(notification); };
  notification.on('click', () => {
    release();
    if (current()) {
      if (payload.conversationKind === 'direct') openMainWindowChatMessage(payload.groupId, payload.messageId, payload.threadRootId, 'direct');
      else openMainWindowChatMessage(payload.groupId, payload.messageId, payload.threadRootId);
    }
  });
  notification.on('close', release);
  notification.on('failed', release);
  notification.show();
}

// dev 下 electron.exe / Electron.app 自带的是默认图标，notification toast 没有
// AUMID/.icns 兜底会显示成空白或 Electron logo——给 toast 显式塞一张 PNG
// 让 dev 体验和 packaged 一致。packaged 模式不动：Win toast 顶图由 AUMID 关联
// 的 .exe 图标渲染，Mac 由 .app bundle 的 .icns 渲染，再塞 inline icon 反而
// 让单条 toast 同时出现两个图标，破坏既定视觉(见下方 buildBody 注释)。
const devNotificationIcon = !app.isPackaged
  ? (() => {
      const p = path.join(__dirname, '../../resources/icon.png');
      const img = nativeImage.createFromPath(p);
      return img.isEmpty() ? undefined : img;
    })()
  : undefined;

/**
 * kind:
 *   - 'done'        — agent 真完成了一轮，没有待回复事项
 *   - 'error'       — agent 本轮以报错结束
 *   - 'needs-reply' — agent 抛出 ask-user / permission / plan-review，等用户处理
 */
const CLIENT_NOTIFICATION_NAME = 'Cindy';

interface ShowSessionEventPayload {
  sessionId: string;
  title: string;
  kind: SessionEventKind;
  /** Local handoff event identity, verified against Main's request-scoped notice record. */
  inputHandoffRequestId?: string;
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
  /** Execution host for a device-link session; absent for local tasks. */
  remoteDeviceId?: string;
  /**
   * Stable identity for a repeated needs-reply or error. Absent on older clients
   * and on completions, which keep using the turn signal. Same id twice is one
   * desktop toast; a different id is a new request and must still notify.
   */
  alertEventId?: string;
}

/**
 * Toast 文案分两层：title 同时标识 Cindy 与任务，body 放结构化终态。
 * 不能只依赖 Windows AUMID / macOS bundle 元数据标识来源：不同系统和通知中心
 * 展示的 app 元数据并不一致，只显示任务名时容易被误认成同名插件主动发出的通知。
 */
// 防 GC：Electron Notification 实例如果不持引用，JS 引擎可能在 toast 还在显示
// 时就回收掉，导致 click handler 丢失甚至触发异常事件。用 Set 持引用，等
// close/click 后再 release。
const liveNotifications = new Set<Notification>();
type NotifiedReply = { eventId: string } | { fallbackSentAt: number };
const notifiedReplies = new Map<string, NotifiedReply>();
/**
 * needs-reply / error 的去重账本，和上面的完成通知账本分开。完成通知在拿不到
 * 轮次标识、正文又读失败时会记一条只有发送时刻的兜底；如果告警也来查那本账，
 * 同一任务随后的无标识告警会被当成“已经通知过”吞掉。两本账互不读取。
 *
 * 账本按「事件产生顺序」而不是 preview 读完顺序记。同一任务两条告警会并发去读
 * preview：后产生的那条可能先读完并已经弹过。此时若把账本改回较早的标识，后产生
 * 的告警再投一次就会被当成没弹过。所以每个 key 留最近若干个已接受的标识，并记下它们
 * 产生时的序号；序号更早的完成不能把更晚的标识盖掉。
 */
interface NotifiedAlert {
  /** 告警标识。同一标识再来不再弹。 */
  id: string;
  /**
   * 产生顺序。`turn` 来自标识里的轮次开始时间；没有这段时间时，`delivery` 是
   * 投递入口同步分配的单调序号。两者只在同一种来源之间比较，不混成一条数轴。
   */
  order: { source: 'turn' | 'delivery'; value: number };
  /**
   * 这条告警进入主进程投递入口的时刻。跨窗合并用它比较两次到达，
   * 不用 renderer 各自采样的轮次时钟。
   */
  arrivedAt: number;
  /**
   * 去掉 `turn:<毫秒>` 之后的内容尾。主窗和「在新窗口打开」的副窗会给
   * 同一帧采出相差几毫秒的轮次时钟，标识因不相同；请求或错误内容不同时这段尾也不同。
   */
  content: string;
  /** 告警种类。账本 key 只有任务和通道，错误和需要回复共用一本，合并时还得再比这一位。 */
  kind: 'error' | 'needs-reply';
  /**
   * 投进来的窗口。Electron 里每个 BrowserWindow 的 webContents id 不同，同一窗口恒定。
   * 拿不到时不参与跨窗合并：宁可少合并，也不把同一窗口的两次失败并成一次。
   * 这是写下这条记录的那一扇；后来并进来的窗口在 `senders` 里。
   */
  senderId: number | undefined;
  /**
   * 参与过这条合并事件的全部窗口。只记下条的那一个时，另一扇窗的下一轮失败
   * 仍会因为「不是这个 sender」被并掉。跨窗命中后把当前窗口并进来；写入时新建集合，不改已有的。
   */
  senders?: ReadonlySet<number>;
  /**
   * 另一扇窗已经弹过，这条只是同一事件换了个标识。精确标识再来仍不弹；
   * 但它不能当跨窗合并的锚点，否则下一轮失败会撞上这扇窗的别名被吞掉。
   */
  alias?: true;
  /**
   * 仅别名使用：这条标识所属的锚点（原本弹过的那条）。精确标识命中别名时沿它找回锚点，
   * 把当前窗口记进那条的 `senders`。锚点自己不写这个字段。
   */
  anchorId?: string;
}
const NOTIFIED_ALERTS_PER_KEY = 8;
/**
 * 同一条事件的两扇窗进入主进程可以隔开的最长时间。这不是「跨窗」的判据：
 * 判据是 webContents id，每个窗口不同、同一窗口恒定。错误标识去掉时钟后都是 `error`，
 * 只靠内容尾加这个窗口，同一窗口里一秒内的两次失败会被合成一次。
 * 1 秒只留给副窗展开侧栏、主进程调度和 preview 读取的差额；来自同一窗口的下一次失败即使落在这 1 秒里也各弹一次。
 */
const CROSS_WINDOW_ALERT_WINDOW_MS = 1_000;
const notifiedAlerts = new Map<string, NotifiedAlert[]>();
/**
 * preview 还没读完、因此还没写进账本的投递。按账本 key 再按内容尾分桶。
 * 进入异步 preview 之前就推进来，所以跨窗比的是到达顺序，不是读完顺序。
 * 同一内容尾里，轮次时钟差超过两扇窗采样抖动的是另一轮失败，不跟这一桶里的别轮互认。
 */
interface PendingAlertDelivery {
  alertEventId: string;
  order: NotifiedAlert['order'];
  arrivedAt: number;
  senderId: number | undefined;
  kind: 'error' | 'needs-reply';
}
const pendingAlertDeliveries = new Map<string, Map<string, PendingAlertDelivery[]>>();
/** 没有 turn 时间的告警，在投递入口同步分配的单调序号。只和同样没有 turn 时间的告警比先后。 */
let nextAlertDeliveryOrder = 0;
const pendingFeishuReplies = new Set<string>();
const pendingFeishuFallbacks = new Map<string, number>();
type ReplyNotificationChannel = 'desktop' | 'mobile' | 'feishu';

function replyNotificationKey(scope: string | number, sessionId: string, channel: ReplyNotificationChannel): string {
  return `${scope}:${sessionId}:${channel}`;
}

/**
 * 告警的产生顺序。renderer 把轮次开始时间写在标识开头（`turn:<毫秒>:...`）；
 * 拿不到这段时间（旧客户端、或这一轮还没有开始时刻）时，用投递入口同步分配的序号。
 * 序号在进入异步 preview 之前就定下来，所以比较的是产生顺序，不是读完顺序。
 */
function alertOrder(alertEventId: string, deliveryOrder: number): NotifiedAlert['order'] {
  const turn = /^turn:(\d{1,16})(?::|$)/.exec(alertEventId)?.[1];
  if (turn !== undefined) {
    const value = Number(turn);
    if (Number.isSafeInteger(value) && value > 0) return { source: 'turn', value };
  }
  return { source: 'delivery', value: deliveryOrder };
}

/** 去掉 renderer 各自采样的 `turn:<毫秒>:`。剩下的才是请求或错误内容；没有这段前缀就整串都算内容。 */
function alertContentKey(alertEventId: string): string {
  return alertEventId.replace(/^turn:\d{1,16}:/, '');
}

/** 投递来自哪扇窗。id 在窗口存活期间不变；测试或残缺事件拿不到时返回 undefined，不当成另一扇窗。 */
function readAlertSenderId(event: unknown): number | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const id = (event as { sender?: { id?: unknown } }).sender?.id;
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : undefined;
}

type NotifiedAlertMatch =
  | { matched: 'exact' }
  | { matched: 'cross-window'; order: NotifiedAlert['order']; anchorId: string };

/**
 * 这扇窗还没算进这条合并事件。没有窗口 id 时，只有对方记下过窗口才算另一扇；
 * 两边都拿不到窗口就不合并，避免同一窗口的两次失败碰在一起。
 */
function senderHasNotJoinedAlert(alert: NotifiedAlert, senderId: number | undefined): boolean {
  if (alert.senders) {
    if (senderId === undefined) return alert.senders.size > 0;
    return !alert.senders.has(senderId);
  }
  return alert.senderId !== senderId;
}

/** 跨窗命中后把当前窗口记进锚点。新建集合和条目，不改账本里原来那一份。 */
function rememberJoinedSender(key: string, anchorId: string, senderId: number | undefined): void {
  if (senderId === undefined) return;
  const current = notifiedAlerts.get(key);
  if (!current) return;
  const index = current.findIndex(alert => alert.id === anchorId && alert.alias !== true);
  if (index < 0) return;
  const alert = current[index]!;
  const previous = alert.senders ?? new Set(alert.senderId === undefined ? [] : [alert.senderId]);
  if (previous.has(senderId)) return;
  const senders = new Set(previous);
  senders.add(senderId);
  const next = current.slice();
  next[index] = { ...alert, senders };
  notifiedAlerts.set(key, next);
}

/** 精确标识落在别名上时回到原本弹过的那条；锚点自己就是自己。 */
function anchorIdForAlert(alert: NotifiedAlert): string {
  return alert.alias === true && alert.anchorId !== undefined ? alert.anchorId : alert.id;
}

function pendingDeliveriesFor(key: string, content: string): PendingAlertDelivery[] {
  return pendingAlertDeliveries.get(key)?.get(content) ?? [];
}

/** 进入异步 preview 之前记下这一份。新建数组，不改已经在途的那一份。 */
function trackPendingAlertDelivery(key: string, delivery: PendingAlertDelivery): void {
  const byContent = new Map(pendingAlertDeliveries.get(key) ?? []);
  const content = alertContentKey(delivery.alertEventId);
  const bucket = byContent.get(content) ?? [];
  byContent.set(content, [...bucket, delivery]);
  pendingAlertDeliveries.set(key, byContent);
}

/** preview 结束（弹了、并掉了、或中途退出）后把这一份从在途桶里拿走。拿不到就不动账。 */
function releasePendingAlertDelivery(key: string, delivery: PendingAlertDelivery): void {
  const current = pendingAlertDeliveries.get(key);
  if (!current) return;
  const content = alertContentKey(delivery.alertEventId);
  const bucket = current.get(content);
  if (!bucket) return;
  const nextBucket = bucket.filter(item => item !== delivery);
  const byContent = new Map(current);
  if (nextBucket.length === 0) byContent.delete(content);
  else byContent.set(content, nextBucket);
  if (byContent.size === 0) pendingAlertDeliveries.delete(key);
  else pendingAlertDeliveries.set(key, byContent);
}

/**
 * 两扇窗给同一帧各采一次 `Date.now()`，轮次时钟可以差几毫秒，内容尾却一样。
 * 差得比这个多就是另一轮失败：在途配对和已记账的跨窗合并都不跨过它。
 * 1 秒到达窗仍是「两扇窗可以隔多远」；这一位只拆轮次，不放宽到达窗。
 */
const SAME_FAILURE_TURN_SKEW_MS = 50;

function sameFailureTurn(leftId: string, rightId: string): boolean {
  const left = alertOrder(leftId, 0);
  const right = alertOrder(rightId, 0);
  if (left.source !== 'turn' || right.source !== 'turn') return true;
  return Math.abs(left.value - right.value) <= SAME_FAILURE_TURN_SKEW_MS;
}

/**
 * 还在读 preview 的同内容尾、同一轮次里，和本份是另一扇窗的那一份。
 * 同一窗口永不合并。没有窗口 id 就不合并。到达相差 1 秒及以上的是下一次失败。
 * 轮次时钟差超过采样抖动的不在这一对里，所以 1200 不会把 1000 记成自己的别名。
 * 一对里先读完的弹，后读完的并进去；读完顺序不决定它们是不是同一轮。
 */
function inflightCrossWindowPartner(
  key: string,
  delivery: PendingAlertDelivery,
): PendingAlertDelivery | undefined {
  const content = alertContentKey(delivery.alertEventId);
  const ordered = pendingDeliveriesFor(key, content)
    .filter(pending => pending.kind === delivery.kind && sameFailureTurn(pending.alertEventId, delivery.alertEventId))
    .slice()
    .sort((left, right) => left.arrivedAt - right.arrivedAt || left.alertEventId.localeCompare(right.alertEventId));
  const partnerOf = new Map<PendingAlertDelivery, PendingAlertDelivery>();
  for (const pending of ordered) {
    const partner = ordered.find(earlier =>
      earlier !== pending
      && earlier.arrivedAt <= pending.arrivedAt
      && !partnerOf.has(earlier)
      && differentAlertSender(earlier.senderId, pending.senderId)
      && Math.abs(pending.arrivedAt - earlier.arrivedAt) < CROSS_WINDOW_ALERT_WINDOW_MS,
    );
    if (partner) {
      partnerOf.set(pending, partner);
      partnerOf.set(partner, pending);
    }
  }
  return partnerOf.get(delivery);
}

/** 两扇窗的 webContents id 都拿得到且不相同，才算跨窗。缺一个就不合并。 */
function differentAlertSender(left: number | undefined, right: number | undefined): boolean {
  return left !== undefined && right !== undefined && left !== right;
}

/**
 * 同一告警标识只弹一次。没有标识的调用不去重，照常通知：宁可多弹一次，
 * 也不能把新的提问或失败吞掉。
 *
 * 跨窗是另一回事，不靠时间窗判断：每个窗口的 webContents id 不同，同一窗口恒定。
 * 只有这扇窗还没参与过这条记录、种类相同、内容尾相同、到达相差不到 1 秒，才当成同一条事件的另一扇窗。
 * 同一窗口发来的两条永不合并，所以一秒内的两次失败各弹一次。
 * 别名（另一扇窗那条没弹、只为记住标识）不参与这次查找：它只靠精确标识挡住重放，
 * 不能把下一轮失败再并掉。命中跨窗时把已经弹过那条的顺序带回去，调用方记新标识时沿用它，不把副本排成最近一条。
 * 精确标识命中同样不再弹，但要把当前窗口记进该标识所属锚点；命中的是别名就沿 `anchorId` 找回原本弹过的那条。
 */
function matchNotifiedAlert(
  key: string,
  alertEventId: string | undefined,
  arrivedAt: number,
  senderId: number | undefined,
  kind: 'error' | 'needs-reply',
): NotifiedAlertMatch | undefined {
  if (!alertEventId) return undefined;
  const current = notifiedAlerts.get(key);
  if (!current) return undefined;
  const exact = current.find(alert => alert.id === alertEventId);
  if (exact) {
    // 相同标识不再弹。两扇窗采出同一个 id 时，第二扇也得算进这条合并事件，
    // 否则它下一轮失败仍会因为「没参与过锚点」被并进上一轮。
    rememberJoinedSender(key, anchorIdForAlert(exact), senderId);
    return { matched: 'exact' };
  }
  const content = alertContentKey(alertEventId);
  const cross = current.find(alert =>
    alert.alias !== true
    && alert.kind === kind
    && alert.content === content
    && sameFailureTurn(alert.id, alertEventId)
    && senderHasNotJoinedAlert(alert, senderId)
    && Math.abs(arrivedAt - alert.arrivedAt) < CROSS_WINDOW_ALERT_WINDOW_MS,
  );
  return cross ? { matched: 'cross-window', order: cross.order, anchorId: cross.id } : undefined;
}

/**
 * 记下刚弹过的告警。已经弹过的标识都留着：更新的到来只是不再让更早的投递
 * 把「最近一条」改回去，不能把旧标识从账本里抹掉。顺序只决定本条插在末尾
 * （成为最近一条）还是插在已有更新记录之前。同一种来源按数值比较；来源不同
 * 时没有共同的时间轴，本条追加到末尾。每个 key 只留最近若干条，超出丢最旧的。
 */
function rememberAlert(
  key: string,
  alertEventId: string,
  order: NotifiedAlert['order'],
  arrivedAt: number,
  senderId: number | undefined,
  kind: 'error' | 'needs-reply',
  alias = false,
  anchorId?: string,
): void {
  const current = notifiedAlerts.get(key) ?? [];
  if (current.some(alert => alert.id === alertEventId)) return;
  const entry: NotifiedAlert = {
    id: alertEventId,
    order,
    arrivedAt,
    content: alertContentKey(alertEventId),
    senderId,
    // 先记下写这条的窗口。跨窗命中时再把另一扇窗并进新的集合，不在这里改已有条目。
    ...(senderId === undefined ? {} : { senders: new Set<number>([senderId]) }),
    kind,
    // 别名只记住「这条标识已经处理过」，并指向原本弹过的锚点。跨窗查找会跳过它，避免下一轮失败把它当成锚点。
    ...(alias ? { alias: true as const, ...(anchorId !== undefined ? { anchorId } : {}) } : {}),
  };
  const newerAt = current.findIndex(alert => alert.order.source === order.source && alert.order.value > order.value);
  const next = newerAt === -1
    ? [...current, entry]
    : [...current.slice(0, newerAt), entry, ...current.slice(newerAt)];
  notifiedAlerts.set(key, next.length > NOTIFIED_ALERTS_PER_KEY ? next.slice(-NOTIFIED_ALERTS_PER_KEY) : next);
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
    notifiedReplies.set(key, { eventId });
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

/**
 * 从 main 内其它模块发送与会话通知同语义的桌面 toast。
 * Scheduler 运行在 main，必须直接调用此入口；`webContents.send` 同名 IPC 只会
 * 发给 renderer，不会命中 main 的 `ipcMain.handle`。
 */
export function showDesktopSessionEvent(
  getWindow: () => BrowserWindow | null,
  payload: Pick<ShowSessionEventPayload, 'sessionId' | 'title' | 'kind'> & {
    deviceId?: string;
    messageClientId?: string;
    body?: string;
    teammate?: boolean;
    avatarJpeg?: string;
    /** 其它设备的任务传 false:未读归属那台设备,本机 Dock 角标不跟着记。 */
    markAttention?: boolean;
  },
): boolean {
  const { sessionId, title, kind } = payload;
  const isLocalSession = !!sessionId && payload.markAttention !== false;
  if (isLocalSession) markSessionNeedsAttention(sessionId);
  // 「消息免打扰」门放在这个**公共出口**上：scheduler、伙伴自主跟进等 main 内
  // 直接调用方都不经过 IPC handler 的那道判定，只挡 handler 会漏出系统 toast。
  // 其它设备的任务（markAttention === false）不查本机静音标记。
  if (isLocalSession && isSessionNotificationsMutedSync(sessionId)) return false;
  const safeTitle = title?.trim() || sessionId.slice(0, 8) || getSessionNotificationUntitled();
  const owner = captureDataOwnerBroadcastScope();
  return showDesktopToast(safeTitle, kind, () => {
    if (!isDataOwnerBroadcastScopeCurrent(owner)) return;
    if (sessionId) openMainWindowSession(sessionId, {
      ...(payload.deviceId ? { deviceId: payload.deviceId } : {}),
      ...(payload.messageClientId ? { messageClientId: payload.messageClientId } : {}),
    });
  }, payload.body, payload.teammate, payload.avatarJpeg, !sessionId);
}

/**
 * 其它设备(device-link)任务的桌面通知,只在本机灵动岛关闭时由岛服务转交过来。
 * 正文没有本机记录可读,沿用各 kind 的通用文案;未读归属那台设备,不记本机角标。
 */
export function showDeviceSessionDesktopEvent(
  getWindow: () => BrowserWindow | null,
  event: { sessionId: string; deviceId: string; title: string | null; deviceName: string | null; kind: SessionEventKind },
): void {
  if (!desktopNotificationsEnabled) return;
  showDesktopSessionEvent(getWindow, {
    sessionId: event.sessionId,
    deviceId: event.deviceId,
    title: [event.title ?? getSessionNotificationUntitled(), event.deviceName].filter(Boolean).join(' · '),
    kind: event.kind,
    markAttention: false,
  });
}

export interface NotificationServiceDeps {
  shouldSilenceTaskNotification?: (kind: SessionEventKind) => boolean;
  /**
   * The task surface already alerts for this event (Agent Notch, or the Live Activity
   * while it can show), so the OS notification would repeat it.
   */
  isTaskAlertShownElsewhere?: (kind: 'done' | 'error' | 'needs-reply') => boolean;
  getWindow: () => BrowserWindow | null;
  /**
   * 飞书 IM 实例,用于飞书通道发消息。来源与 scheduler-host/notifier.ts 相同
   * (main/im 模块单例),保证 owner openId 与卡片回执等行为一致。
   */
  feishuIm: FeishuIM;
}

export function initNotificationService(deps: NotificationServiceDeps): void {
  const { getWindow, feishuIm } = deps;
  shouldSilenceTaskNotification = deps.shouldSilenceTaskNotification ?? (() => false);

  ipcMain.handle('notification:set-desktop-enabled', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      throw new TypeError('notification desktop enabled must be a boolean');
    }
    desktopNotificationsEnabled = enabled;
    return { ok: true as const };
  });

  ipcMain.handle(
    'notification:show-session-event',
    async (event, payload: ShowSessionEventPayload): Promise<void> => {
      // 这条 handler 的 channels / markAttention 全由 renderer 自报,先验来源:只认 Cindy
      // 自有顶层 renderer(插件 webview 等其它 webContents 一律 PERMISSION_DENIED)。
      assertTrustedAppRendererEvent(event);
      // renderer payload 不可信:mobile 通道会把 title/kind 送出本机(经 relay/APNs),
      // main 必须做运行时形状校验,TS 类型不算(electron-security 规则)。正文摘要
      // 不来自 renderer(main 侧读库),relay 有 per-user 频控、main 侧另有 5s
      // 去重与「被远程观看则不推」收口。
      // 告警标识是可选的去重键,不是通知本身:超长或空串只丢掉它,
      // 需要回复 / 失败仍要弹出来。其它字段仍然不合法就整条拒绝。
      const alertEventId = takeUsableAlertEventId(payload);
      // 序号必须在任何 await 之前定下来。两条告警会并发去读 preview，后读完的
      // 不一定是后产生的；拿不到标识里的轮次时间时，就靠这个入口序号分先后。
      const alertDeliveryOrder = alertEventId === undefined ? undefined : nextAlertDeliveryOrder++;
      // 到达时刻和窗口 id 都在任何 await 之前定下来。两条并发 preview 不会互相改写它们。
      // 跨窗看的是窗口 id，不是 renderer 采到轮次时钟的时刻；1 秒只用来限制两扇窗可以隔多远。
      const alertArrivedAt = alertEventId === undefined ? undefined : Date.now();
      const alertSenderId = alertEventId === undefined ? undefined : readAlertSenderId(event);
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
      const wantDesktop = (channels?.desktop ?? true) && deps.isTaskAlertShownElsewhere?.(kind) !== true;
      const wantFeishu = channels?.feishu === true;
      if (markAttention) markSessionNeedsAttention(sessionId);
      // 「消息免打扰」任务不再走任何外向提醒通道（系统 toast / 灵动岛 / 手机 / 飞书）；
      // 未读与角标已在上一行照常记账，任务内的提醒不受影响。静音标记属于本机那行任务，
      // 其它设备的任务（markAttention === false）可能与本机有同 id 的无关任务行，不查。
      // main 没有远端任务的权威映射（device-link 镜像在 renderer），这一位仍由 renderer 报，
      // 来源边界靠上面那道 assertTrustedAppRendererEvent。
      if (markAttention && isSessionNotificationsMutedSync(sessionId)) return;

      // 到达即参与：在进入异步 preview 之前把这一份绑到它自己的内容尾上。
      // 完成顺序不再决定谁是锚点。不同轮次时钟各占一桶，交错读完也不会互相当别名。
      const pendingAlert = kind !== 'done' && wantDesktop && alertEventId !== undefined && alertArrivedAt !== undefined && alertDeliveryOrder !== undefined
        ? {
            alertEventId,
            order: alertOrder(alertEventId, alertDeliveryOrder),
            arrivedAt: alertArrivedAt,
            senderId: alertSenderId,
            kind,
          } satisfies PendingAlertDelivery
        : undefined;
      const pendingAlertKey = pendingAlert === undefined
        ? undefined
        : replyNotificationKey(ownerScope.ownerScopeKey ?? JSON.stringify(ownerScope.ownerStamp ?? null), sessionId, 'desktop');
      if (pendingAlert && pendingAlertKey) trackPendingAlertDelivery(pendingAlertKey, pendingAlert);

      // Content is read from main's transcript. Bound only enrichment, not delivery;
      // a timeout is not a dedupe window and never causes a second late toast.
      void (async () => {
        let preview: SessionNotificationPreview | undefined;
        const releasePending = () => {
          if (pendingAlert && pendingAlertKey) releasePendingAlertDelivery(pendingAlertKey, pendingAlert);
        };
        // Only routes the phone to the teammate chat; titles and fallbacks stay per kind.
        let teammateBotId: string | undefined;
        let postDrainPreviewReady = false;
        let detail: string | undefined;
        let avatarJpeg: string | undefined;
        if (kind === 'done' || wantDesktop || channels?.mobile === true) {
          let finished = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          // Resolve identity and artwork within the same bounded enrichment window.
          const readAvatar = async (identity: SessionNotificationPreview) => {
            if (!wantDesktop) return;
            const avatar = identity.teammateAvatar;
            const jpeg = avatar?.kind === 'jpeg' ? avatar.value
              : avatar?.kind === 'preset' ? await companionAvatarThumbnail(`cindy://avatar/preset/${avatar.value}`) : undefined;
            if (!finished) avatarJpeg = jpeg;
          };
          const routeRead = kind !== 'done'
            ? readSessionNotificationPreview(sessionId, false, true).then(
              async (identity) => { if (!finished) { teammateBotId = identity.teammateBotId; preview = identity; await readAvatar(identity); } },
              () => undefined)
            : undefined;
          try {
            await Promise.race([
              Promise.all([(async () => {
                if (kind !== 'done') return; // A previous answer is neither the current question nor the error.
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
        if (!isDataOwnerBroadcastScopeCurrent(ownerScope)) {
          releasePending();
          return;
        }
        // Preview enrichment can outlive an entire later turn. Never send that
        // later reply under the terminal signal captured for this IPC event.
        const currentSignal = kind === 'done' ? getSessionNotificationTurnSignal(sessionId) : undefined;
        if (kind === 'done') {
          if (currentSignal?.id !== signal?.id || (currentSignal && !currentSignal.ended)) {
            releasePending();
            return;
          }
        }
        if (postDrainPreviewReady && preview?.suppress) {
          // The terminal marker write may have failed after the in-memory turn
          // already ended. Keep its generic notice, but never use old DB text.
          if (kind !== 'done' || !signal?.ended || currentSignal?.id !== signal.id) {
            releasePending();
            return;
          }
          detail = undefined;
        }
        const teammate = !!preview?.teammateName;
        const notificationTitle = preview?.teammateName ?? safeTitle;
        const eventId = signal?.id ?? preview?.eventId;
        // needs-reply / error have no turn signal. Their alert id is the only
        // identity that can collapse a duplicate IPC without swallowing the next
        // question or a later failure of the same task. A completion never uses
        // it, and an unusable id was already stripped before validation.
        const usableAlertEventId = kind === 'done' ? undefined : alertEventId;
        const usableAlertOrder = usableAlertEventId !== undefined && alertDeliveryOrder !== undefined
          ? alertOrder(usableAlertEventId, alertDeliveryOrder)
          : undefined;
        const mobileEventId = preview?.eventId ?? signal?.fallbackEventId;
        // A device-link handoff advances only the mobile send generation. It
        // must not make an already accepted desktop/Feishu reply eligible again.
        const ownerKey = ownerScope.ownerScopeKey ?? JSON.stringify(ownerScope.ownerStamp ?? null);
        const desktopKey = replyNotificationKey(ownerKey, sessionId, 'desktop');
        const mobileKey = replyNotificationKey(generation, sessionId, 'mobile');
        const feishuKey = replyNotificationKey(ownerKey, sessionId, 'feishu');
        // 取正文 / 等交接判定期间用户可能刚开了免打扰:真正发之前再确认一次。
        // 手机通道在 sendMobileSessionNotify 内另有同一道门。
        if (markAttention && isSessionNotificationsMutedSync(sessionId)) {
          releasePending();
          return;
        }
        const fallbackBody = teammate && kind === 'done' ? getTeammateNotificationFallback() : undefined;
        const mobileTeammateBotId = preview?.teammateBotId ?? teammateBotId;
        // 账本只含已经决定过的投递。还在读 preview 的另一扇窗按到达配对，
        // 不按读完顺序：先读完的弹，后读完的并成别名。配不到上一轮已经配完的窗口。
        const inflightPartner = pendingAlert
          ? inflightCrossWindowPartner(desktopKey, pendingAlert)
          : undefined;
        const priorAlert = kind !== 'done' && usableAlertEventId !== undefined && alertArrivedAt !== undefined
          ? matchNotifiedAlert(desktopKey, usableAlertEventId, alertArrivedAt, alertSenderId, kind)
          : undefined;
        const partnerAlreadyDecided = inflightPartner !== undefined && (notifiedAlerts.get(desktopKey)?.some(alert =>
          alert.id === inflightPartner.alertEventId || alert.anchorId === inflightPartner.alertEventId,
        ) ?? false);
        const collapsedIntoInflight = priorAlert === undefined && partnerAlreadyDecided;
        if (wantDesktop && (kind === 'done'
          ? !wasReplyNotified(desktopKey, eventId)
          : priorAlert === undefined && !collapsedIntoInflight)) {
          try {
            const accepted = showDesktopSessionEvent(getWindow, {
              sessionId, title: notificationTitle, kind, teammate, markAttention, avatarJpeg,
              messageClientId: preview?.reply?.clientId,
              body: teammate ? notificationPreview(detail ?? '', 240, getNotificationImageLabel()) || fallbackBody : undefined,
            });
            if (kind === 'done' && accepted) {
              notifiedReplies.set(desktopKey, eventId ? { eventId } : { fallbackSentAt: Date.now() });
            } else if (accepted && kind !== 'done' && usableAlertEventId && usableAlertOrder && alertArrivedAt !== undefined) {
              // 只记下有标识的告警。无标识的不留记录，下一次同样无标识的调用仍要通知。
              // 更早产生、更晚读完的告警不能把这里改回旧标识。
              rememberAlert(desktopKey, usableAlertEventId, usableAlertOrder, alertArrivedAt, alertSenderId, kind);
            }
          } catch (err) {
            log.warn('[notification] desktop reply notification failed (non-fatal)', err);
          }
        } else if (
          wantDesktop
          && kind !== 'done'
          && usableAlertEventId
          && alertArrivedAt !== undefined
          && (priorAlert?.matched === 'cross-window' || collapsedIntoInflight)
        ) {
          // 另一扇窗已经弹过，或同一对里的另一扇已经先读完并弹过。这条不弹，
          // 但标识要进账本，否则 1 秒后再投一次对不上精确标识，窗口也过期了，会再弹。
          // 记成别名：精确标识仍然压住重放，跨窗查找会跳过它，下一轮失败不会被这扇窗的别名吞掉。
          // 锚点是已经决定过的那一条，不是本条自己的轮次时钟，也不是另一轮先读完的失败。
          // 当前窗口也要并进锚点：只留下条的那一个 sender 时，这扇窗下一轮失败仍会撞上旧锚点。
          const anchorId = priorAlert?.matched === 'cross-window' ? priorAlert.anchorId : inflightPartner!.alertEventId;
          const anchorOrder = priorAlert?.matched === 'cross-window' ? priorAlert.order : inflightPartner!.order;
          rememberJoinedSender(desktopKey, anchorId, alertSenderId);
          rememberAlert(
            desktopKey,
            usableAlertEventId,
            anchorOrder,
            alertArrivedAt,
            alertSenderId,
            kind,
            true,
            anchorId,
          );
        }
        releasePending();
        if (channels?.mobile === true && (kind !== 'done' || !wasReplyNotified(mobileKey, eventId))) {
          try {
            const accepted = sendMobileSessionNotify({
              sessionId, title: notificationTitle, kind, generation, ...(detail ? { detail } : {}),
              ...(fallbackBody ? { fallbackBody } : {}), ...(mobileEventId ? { eventId: mobileEventId } : {}),
              ...(mobileTeammateBotId ? { teammateBotId: mobileTeammateBotId } : {}),
              ...(preview?.teammateAvatar ? { teammateAvatar: preview.teammateAvatar } : {}),
              ...(markAttention ? {} : { muteExempt: true }),
              ...(payload.remoteDeviceId ? { remoteDeviceId: payload.remoteDeviceId } : {}),
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
        if (payload.inputHandoffRequestId) {
          const ownership = getInputHandoffNoticeOwnership(sessionId, payload.inputHandoffRequestId);
          // Unknown/expired events cannot invent a new fallback. A known event
          // keeps its actual routing decision even after the handoff ends.
          if (!ownership || await ownership.catch(err => {
            log.warn('[notification] handoff routing unavailable', err);
            return true;
          })) return;
          if (!isDataOwnerBroadcastScopeCurrent(ownerScope) || getWindow()?.isFocused()
            || isSessionNotificationsMutedSync(sessionId)) return;
        }
        await sendFeishuMessage(feishuIm, safeTitle, kind);
      }
    },
  );
}

const SESSION_EVENT_KINDS: ReadonlySet<string> = new Set(['done', 'error', 'needs-reply']);
const SESSION_ID_MAX_LENGTH = 256;
const SESSION_TITLE_MAX_LENGTH = 1024;
const ALERT_EVENT_ID_MAX_LENGTH = 256;

/**
 * 告警标识只用于桌面去重。它不合法（完成通知不该带、不是字符串、空串、超长）
 * 时从 payload 上拿掉并当作没有标识：通知照常发，只是这次不去重。
 * 返回仍可用的那一串；没有则返回 undefined。
 */
function takeUsableAlertEventId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as { alertEventId?: unknown; kind?: unknown };
  const id = record.alertEventId;
  const usable = record.kind !== 'done'
    && typeof id === 'string'
    && id.length > 0
    && id.length <= ALERT_EVENT_ID_MAX_LENGTH;
  if (!usable && id !== undefined) delete record.alertEventId;
  return usable ? id : undefined;
}

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
    (p.markAttention !== undefined && typeof p.markAttention !== 'boolean') ||
    (p.remoteDeviceId !== undefined && (typeof p.remoteDeviceId !== 'string'
      || p.remoteDeviceId.length === 0 || p.remoteDeviceId.length > SESSION_ID_MAX_LENGTH)) ||
    (p.inputHandoffRequestId !== undefined && (
      p.kind !== 'needs-reply' || typeof p.inputHandoffRequestId !== 'string'
      || p.inputHandoffRequestId.length === 0 || p.inputHandoffRequestId.length > 256
    ))
  ) {
    throw new TypeError('invalid session event payload');
  }
}

/** 桌面 toast 分支 — 原实现保持不变,只是拆出来便于 channels 选择性执行。 */
function showDesktopToast(safeTitle: string, kind: SessionEventKind, onClick: () => void, previewBody?: string, teammate = false, avatarJpeg?: string, keepSystemSound = false): boolean {
  const body = previewBody ?? getSessionNotificationBody(kind);

  // Electron Notification 在某些 Linux 桌面环境下可能不可用——静默兜底。
  if (!Notification.isSupported()) {
    log.warn('[notification] Notification.isSupported() === false, skip');
    return false;
  }

  const avatar = avatarJpeg ? nativeImage.createFromBuffer(Buffer.from(avatarJpeg, 'base64')) : undefined;
  const notif = new Notification({
    title: teammate && safeTitle.trim().toLowerCase() === 'cindy'
      ? CLIENT_NOTIFICATION_NAME : `${CLIENT_NOTIFICATION_NAME} · ${safeTitle}`,
    body,
    // Without a session there is no island state change, so no Cindy sound will play.
    silent: !keepSystemSound && shouldSilenceTaskNotification(kind),
    ...(avatar && !avatar.isEmpty() ? { icon: avatar } : devNotificationIcon ? { icon: devNotificationIcon } : {}),
  });
  liveNotifications.add(notif);

  const release = () => {
    liveNotifications.delete(notif);
  };

  notif.on('click', onClick);
  notif.on('close', release);
  notif.on('failed', (_e, error) => {
    // 通知发不出去时主动留痕，方便定位 AUMID / 系统通知开关 / Focus Assist 类问题。
    log.warn('[notification] failed to show:', error);
    release();
  });
  notif.show();
  return true;
}

/**
 * 飞书私聊分支 — 给当前 bot owner 发一条 markdown 文本。
 *
 * ownerOpenId 由 ownerGuard 在用户首次私聊 bot 时 TOFU 记录;未绑定就跳过 + warn
 * (设置里开了开关但还没绑 bot 的边界状态)。整体不能 throw — 通知失败不能影响
 * 桌面通道的展示和上层调用方。
 */
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
