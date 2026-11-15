import { createHash, randomUUID } from 'node:crypto';
import { notificationPreview, truncateNotificationText } from '../notificationPreview.js';
import {
  NOTIFY_ACTION_DETAIL_MAX_LENGTH,
  NOTIFY_ACTION_MAX_OPTIONS,
  NOTIFY_ACTION_OPTION_MAX_LENGTH,
  NOTIFY_ACTION_QUESTION_MAX_LENGTH,
  NOTIFY_ACTION_REQUEST_ID_MAX_LENGTH,
  NOTIFY_BODY_MAX_LENGTH,
  NOTIFY_DEEP_LINK_MAX_LENGTH,
  NOTIFY_TITLE_MAX_LENGTH,
  type NotifyCategory,
  type NotifyPayload,
  type NotifySender,
} from '@cindy/device-link';
import {
  askQuestionOptions,
  describePermissionAction,
  normalizeAskQuestions,
  permissionAlertOperation,
  permissionInput,
  permissionRiskSummary,
  permissionToolName,
  type InteractionRequestLike,
} from '@cindy/maker-shared/interaction';

/**
 * 手机推送(notify 帧)的纯逻辑:payload 组装 + 短窗去重。
 * 接线(client 持有、订阅注册表防打扰)在 ./index.ts 的 sendMobileSessionNotify;
 * 本文件无 Electron / client 依赖,可直接单测。
 */

export type MobileSessionEventKind = 'done' | 'error' | 'needs-reply';

const CATEGORY_BY_KIND: Record<MobileSessionEventKind, NotifyCategory> = {
  done: 'session-done',
  error: 'session-error',
  'needs-reply': 'session-needs-reply',
};

/** The question a phone alert asks; the same wording as the permission card's title. */
export type PermissionAlertQuestion = 'command' | 'file-read' | 'file-write' | 'browser' | 'plugin';

/** One waiting tool permission, worded so it can be answered from the alert itself. */
export interface PermissionAlert {
  requestId: string;
  /** Exact text: the question and the whole operation, never shortened. */
  body: string;
}

/**
 * A waiting tool permission as a phone alert with Approve / Deny, or undefined
 * when the alert has to stay the plain "reply needed" one and be answered in
 * the app. Approving from an alert is only offered when the person can read
 * everything they approve:
 *  - the whole operation fits the alert (nothing is cut);
 *  - it is a kind the card also asks about in plain words (command, files,
 *    browser step, plugin call); raw tool / MCP arguments stay in the app;
 *  - it is not a high-risk command, which the card confirms twice.
 * `request` is the copy already redacted for clients, so the alert shows the
 * same text as the card on the phone.
 */
export function buildPermissionAlert(
  request: InteractionRequestLike,
  question: (kind: PermissionAlertQuestion, plugin?: string) => string,
): PermissionAlert | undefined {
  const requestId = usableRequestId(request);
  if (request.kind !== 'permission' || !requestId) return undefined;
  if (permissionRiskSummary(request)) return undefined;
  const action = describePermissionAction(permissionToolName(request), permissionInput(request));
  if (action.kind === 'tool' || action.kind === 'mcp') return undefined;
  if (action.kind === 'plugin' && !action.subject) return undefined;
  const operation = permissionAlertOperation(action);
  if (!operation) return undefined;
  const body = `${question(action.kind, action.subject)}\n${operation}`;
  return body.length <= NOTIFY_BODY_MAX_LENGTH ? { requestId, body } : undefined;
}

/** One question the agent is waiting on, worded so it can be answered from the alert itself. */
export interface QuestionAlert {
  requestId: string;
  /** The question and its numbered options, shortened to fit a push. */
  body: string;
  /** Choices offered as buttons, in the order the body numbers them. */
  options?: string[];
  /** Their explanations by the same index; '' where an option has none. */
  details?: string[];
  /** The whole question, present only when the body could not hold it. */
  question?: string;
}

function usableRequestId(request: InteractionRequestLike): string | undefined {
  const requestId = typeof request.requestId === 'string' ? request.requestId : '';
  return requestId && requestId.length <= NOTIFY_ACTION_REQUEST_ID_MAX_LENGTH && !/[\u0000-\u001f\u007f]/.test(requestId)
    ? requestId : undefined;
}

/**
 * A waiting question as a phone alert that can be answered in place, or undefined
 * when it has to be answered in the app: several questions at once, a multi-select,
 * a question that only notifies while the agent keeps working (its late answer is
 * delivered differently), or a fixed set of choices the alert cannot offer as buttons.
 * Unlike a permission, a shortened question is still worth showing: answering it
 * runs nothing by itself, and the whole text travels beside the alert when it fits.
 */
export function buildQuestionAlert(request: InteractionRequestLike): QuestionAlert | undefined {
  const requestId = usableRequestId(request);
  if (request.kind !== 'ask_user_question' || !requestId || request.delivery === 'async') return undefined;
  const questions = normalizeAskQuestions(request.questions);
  const question = questions[0];
  if (questions.length !== 1 || !question || question.multiSelect) return undefined;
  const choices = askQuestionOptions(question);
  const offered = choices.length > 0 && choices.length <= NOTIFY_ACTION_MAX_OPTIONS
    && choices.every(choice => choice.label.length <= NOTIFY_ACTION_OPTION_MAX_LENGTH && !/[\u0000-\u001f\u007f]/.test(choice.label));
  // Only the listed choices are accepted: without buttons there is no way to pick one reliably.
  if (question.answerConstraints?.choices && !offered) return undefined;
  const text = question.question.trim();
  const full = [text, ...choices.map((choice, index) => `${index + 1}. ${choice.label}`)].join('\n');
  const body = truncateNotificationText(full, NOTIFY_BODY_MAX_LENGTH);
  const details = choices.map(choice => truncateNotificationText(choice.description?.trim() ?? '', NOTIFY_ACTION_DETAIL_MAX_LENGTH));
  return {
    requestId,
    body,
    ...(offered ? { options: choices.map(choice => choice.label) } : {}),
    ...(offered && details.some(Boolean) ? { details } : {}),
    ...(body.length < full.length ? { question: truncateNotificationText(text, NOTIFY_ACTION_QUESTION_MAX_LENGTH) } : {}),
  };
}

/**
 * 组装 notify payload。deepLink 用 scheme 无关的应用内路径(手机端点击通知后自行
 * router.push),规避 cn/global 两条构建线 scheme 不同的问题。
 * 正文取 detail(该会话最近一条 assistant 内容 / 定时任务结果摘要)——2026-07 产品
 * 决策:体验优先,推送带实际内容,让用户不打开 App 就能看到结果;detail 缺省时
 * 回退终态短文案。
 */
export function buildSessionNotifyPayload(opts: {
  sessionId: string;
  title: string;
  kind: MobileSessionEventKind;
  selfDeviceId: string;
  /** Deep-link and notification identity belong to the execution host when remote. */
  targetDeviceId?: string;
  /** 由 main host 按发送时的当前 locale 解析；本纯模块不依赖 Electron i18n。 */
  fallbackBody: string;
  imageFallback?: string;
  /** 内容摘要(可选):折叠空白后按协议上限截断 */
  detail?: string;
  /**
   * 伙伴主任务的 Bot id。带上后手机把通知打开为该伙伴的聊天(伙伴页头、抽屉与已读)，
   * 而不是普通任务视图；参数与名册进入聊天时相同，旧手机同样识别，缺省保持原深链。
   */
  teammateBotId?: string;
  teammateAvatar?: NotifySender['avatar'];
  /** needs-reply only: the alert describes this request and offers Approve / Deny. */
  permission?: PermissionAlert;
  /** needs-reply only: the alert asks this question and offers its options and Reply. */
  question?: QuestionAlert;
  /** The task takes a text message, so the alert offers Reply. */
  reply?: boolean;
}): NotifyPayload {
  const safeTitle = truncateNotificationText(opts.title.trim() || opts.sessionId.slice(0, 8), NOTIFY_TITLE_MAX_LENGTH);
  const detail = opts.detail ? notificationPreview(opts.detail, NOTIFY_BODY_MAX_LENGTH, opts.imageFallback) : '';
  const targetDeviceId = opts.targetDeviceId ?? opts.selfDeviceId;
  const permission = opts.kind === 'needs-reply' ? opts.permission : undefined;
  const question = opts.kind === 'needs-reply' && !permission ? opts.question : undefined;
  return {
    category: CATEGORY_BY_KIND[opts.kind],
    title: safeTitle,
    // A permission body is the exact operation: no Markdown projection, no shortening.
    body: permission?.body ?? question?.body ?? (detail || truncateNotificationText(opts.fallbackBody, NOTIFY_BODY_MAX_LENGTH)),
    deepLink: sessionDeepLink(opts.sessionId, targetDeviceId, opts.teammateBotId),
    ...(permission ? { action: { kind: 'permission' as const, requestId: permission.requestId } }
      : question ? { action: {
        kind: 'question' as const,
        requestId: question.requestId,
        ...(question.options ? { options: question.options } : {}),
        ...(question.details ? { details: question.details } : {}),
        ...(question.question ? { question: question.question } : {}),
      } }
      : opts.reply ? { action: { kind: 'reply' as const } } : {}),
    ...(opts.teammateBotId ? {
      sender: {
        id: createHash('sha256').update(`${targetDeviceId}:bot:${opts.teammateBotId}`).digest('hex'),
        ...(opts.teammateAvatar ? { avatar: opts.teammateAvatar } : {}),
      },
    } : {}),
    // 同会话的通知按 thread-id 分组；新版服务端用 notificationId 单独标识各事件。
    // 旧服务端仍使用此键合并(APNs collapse-id)；混入任务归属设备 ID,
    // 多台桌面推同名会话时互不顶替。原样拼接不可行:deviceId 可能是 64 位
    // machineId,拼出 100+ 字符会被 APNs 的 64 字节 collapse-id 上限截断成
    // 设备级合并键(该设备所有会话的通知互相顶替)。取 sha256 前 32 hex:
    // 确定性、每(设备,会话)唯一、稳低于协议与 APNs 双上限。
    collapseId: createHash('sha256')
      .update(`${targetDeviceId}:${opts.sessionId}`)
      .digest('hex')
      .slice(0, 32),
  };
}

/**
 * A 分工 step waiting for the phone's owner (bot-group-chat.md §8.3). There is no category for
 * groups in the notify protocol, so it rides `session-needs-reply`; the deep link opens the
 * group on the phone. Phones without the group screen ignore the unknown link and just open.
 */
export function buildBotGroupNotifyPayload(opts: {
  groupId: string;
  title: string;
  body: string;
  selfDeviceId: string;
}): NotifyPayload {
  const title = truncateNotificationText(opts.title.trim() || opts.groupId.slice(0, 8), NOTIFY_TITLE_MAX_LENGTH);
  return {
    category: 'session-needs-reply',
    title,
    body: notificationPreview(opts.body, NOTIFY_BODY_MAX_LENGTH),
    deepLink: `/companions/groups/${encodeURIComponent(opts.groupId)}?deviceId=${encodeURIComponent(opts.selfDeviceId)}`
      .slice(0, NOTIFY_DEEP_LINK_MAX_LENGTH),
    collapseId: createHash('sha256')
      .update(`${opts.selfDeviceId}:bot-group:${opts.groupId}`)
      .digest('hex')
      .slice(0, 32),
  };
}

function sessionDeepLink(sessionId: string, deviceId: string, teammateBotId?: string): string {
  const base = `/sessions/${encodeURIComponent(sessionId)}?deviceId=${encodeURIComponent(deviceId)}`;
  if (!teammateBotId) return base;
  const teammate = `${base}&resourceCollectionId=teammates&resourceId=${encodeURIComponent(teammateBotId)}&resourceKind=bot`;
  // An oversized link is rejected by the protocol; the ordinary task link still opens the chat.
  return teammate.length <= NOTIFY_DEEP_LINK_MAX_LENGTH ? teammate : base;
}

/**
 * 有回复标识时按同 session + 同 kind + 回复去重；不同回复不受时间窗口限制。
 * 无标识的调度事件保留短窗兜底，并与同轮的持久 turn 标识对账。覆盖 renderer 事件源的重复触发
 * (如 needs-reply 连续弹多个审批);不同 kind 不互压 —— done 紧跟 error 各有信息量,
 * 新版系统层仅合并同一 notificationId 的重试，collapseId 继续用于任务分组。
 */
export class MobileNotifyDeduper {
  private readonly lastEvent = new Map<string, string>();
  private readonly lastSentAt = new Map<string, number>();
  private readonly lastAnonymousSentAt = new Map<string, number>();

  constructor(private readonly windowMs = 5_000) {}

  shouldSend(sessionId: string, kind: MobileSessionEventKind, now = Date.now(), eventId?: string): boolean {
    const key = `${sessionId}:${kind}`;
    if (eventId) {
      if (this.lastEvent.get(key) === eventId) return false;
      const anonymousAt = this.lastAnonymousSentAt.get(key);
      if (anonymousAt !== undefined) {
        // Scheduler still sends an unlabelled completion. Its accepted frame
        // and the renderer's durable turn ID can describe the same run. A turn
        // already finished when that frame was sent is the same completion;
        // a later completed turn keeps its own notification even if it started earlier.
        const endedAt = /^turn:\d+:(\d+)(?::signal-\d+)?$/.exec(eventId)?.[1];
        if (endedAt ? Number(endedAt) <= anonymousAt : now - anonymousAt < this.windowMs) {
          this.lastEvent.set(key, eventId);
          return false;
        }
      }
      return true;
    }
    const last = this.lastSentAt.get(key);
    return last === undefined || now - last >= this.windowMs;
  }

  /** Record only a frame accepted by the local relay client. */
  recordSent(sessionId: string, kind: MobileSessionEventKind, now = Date.now(), eventId?: string): void {
    const key = `${sessionId}:${kind}`;
    this.lastSentAt.set(key, now);
    if (eventId) {
      this.lastEvent.set(key, eventId);
    } else {
      this.lastAnonymousSentAt.set(key, now);
    }
    this.sweep(now);
  }

  /** 顺路清理过期条目(记录量 = 活跃会话数,轻量,无需独立定时器)。 */
  private sweep(now: number): void {
    for (const [key, at] of this.lastSentAt) {
      if (now - at >= this.windowMs) this.lastSentAt.delete(key);
    }
  }
}

/** Mirrored senders of the same execution-host event share one retirement identity. */
export function mobileNotificationIdentity(deviceId: string, sessionId: string, kind: MobileSessionEventKind, eventId?: string): string {
  if (!eventId) return randomUUID();
  const hash = createHash('sha256').update(JSON.stringify([deviceId, sessionId, kind, eventId])).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
