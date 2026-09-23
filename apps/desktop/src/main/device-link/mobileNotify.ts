import { createHash } from 'node:crypto';
import { notificationPreview } from '../notificationPreview.js';
import {
  NOTIFY_BODY_MAX_LENGTH,
  NOTIFY_TITLE_MAX_LENGTH,
  type NotifyCategory,
  type NotifyPayload,
} from '@cindy/device-link';

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
  /** 由 main host 按发送时的当前 locale 解析；本纯模块不依赖 Electron i18n。 */
  fallbackBody: string;
  /** 内容摘要(可选):折叠空白后按协议上限截断 */
  detail?: string;
}): NotifyPayload {
  const safeTitle = (opts.title.trim() || opts.sessionId.slice(0, 8)).slice(
    0,
    NOTIFY_TITLE_MAX_LENGTH,
  );
  const detail = opts.detail ? notificationPreview(opts.detail, NOTIFY_BODY_MAX_LENGTH) : '';
  return {
    category: CATEGORY_BY_KIND[opts.kind],
    title: safeTitle,
    body: detail || opts.fallbackBody.slice(0, NOTIFY_BODY_MAX_LENGTH),
    deepLink: `/sessions/${encodeURIComponent(opts.sessionId)}?deviceId=${encodeURIComponent(opts.selfDeviceId)}`,
    // 同会话的通知在系统层合并(APNs collapse-id / thread-id);混入 srcDeviceId,
    // 多台桌面推同名会话时互不顶替。原样拼接不可行:deviceId 可能是 64 位
    // machineId,拼出 100+ 字符会被 APNs 的 64 字节 collapse-id 上限截断成
    // 设备级合并键(该设备所有会话的通知互相顶替)。取 sha256 前 32 hex:
    // 确定性、每(设备,会话)唯一、稳低于协议与 APNs 双上限。
    collapseId: createHash('sha256')
      .update(`${opts.selfDeviceId}:${opts.sessionId}`)
      .digest('hex')
      .slice(0, 32),
  };
}

/**
 * 有回复标识时按同 session + 同 kind + 回复去重；不同回复不受时间窗口限制。
 * 无标识的调度事件保留短窗兜底，并与同轮的持久 turn 标识对账。覆盖 renderer 事件源的重复触发
 * (如 needs-reply 连续弹多个审批);不同 kind 不互压 —— done 紧跟 error 各有信息量,
 * 系统层还有 collapseId 合并兜底。
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
        const endedAt = /^turn:\d+:(\d+)$/.exec(eventId)?.[1];
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
