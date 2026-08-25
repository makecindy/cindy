/**
 * notifySlot.ts — 系统提示槽(notify,2026-07-14)。
 * ---------------------------------------------------------------------------
 * 意识经管子上行 `{type:'notify', text, tone?}`,请主机在屏幕顶部弹一条
 * 轻提示(toast)。设计边界:
 *
 *   - 意识只供**纯文本**:控制字符剥除(保留 \n)、超限拒收,不存在 HTML 面;
 *   - 提示壳与身份头(意识图标+名字)由主机画——与订阅槽红条同一信任边界,
 *     意识伪装不了主机通知、冒充不了别的意识;
 *   - 无阻塞、无按钮、无回执:确认类交互不在本槽(面板自绘 / 卡槽③交互卡);
 *   - 限速:同一意识两条提示最小间隔 GHOST_NOTIFY_MIN_INTERVAL_MS,超发拒收
 *     (结构化 message 告知作者,不静默丢——作者需要知道被限速了)。
 *
 * 处理结果永不 reject——一切失败折叠成 { ok:false, message }(与 cindy 槽
 * 同纪律,沙箱拿到的是结构化拒绝而不是异常穿透)。
 * 依赖注入(规则 14):取意识/广播/时钟全部经 deps,单测直测。
 */

import {
  GHOST_NOTIFY_MAX_CHARS,
  GHOST_NOTIFY_MIN_INTERVAL_MS,
  GHOST_NOTIFY_TONES,
  type GhostNotifyTone,
  type GhostPipeNotifyResult,
  type InstalledGhost,
} from '../../shared/ghost.js';

/** 推给 renderer 的提示载荷(身份三件套由主机按已装清单填,不信意识自报)。 */
export interface GhostNotifyPush {
  ghostId: string;
  /** 意识展示名(身份头,主机画)。 */
  name: string;
  /** 意识图标 data URL(身份头;未声明图标时缺省)。 */
  iconDataUrl?: string;
  text: string;
  tone: GhostNotifyTone;
}

export interface NotifySlotDeps {
  getGhost(id: string): InstalledGhost | null;
  /** 把提示推给全部宿主窗口(renderer 走统一 Toast 体系渲染)。 */
  broadcast(payload: GhostNotifyPush): void;
  now?(): number;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/** 控制字符(保留 \n = U+000A;\r 在归一化时已并入 \n)。 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0009\u000B-\u001F\u007F]/g;

/**
 * 提示文本净化(notify 槽与主机代言 notice 共用一处收口):\r\n / \r 归一成
 * \n,剥控制字符,收首尾空白。toast 正文是 whitespace-pre-line,控制字符
 * 不剥会给撑版面/视觉欺骗留面——所有进 toast 的意识可控文本(自发正文、
 * manifest label、OAuth 身份标签)都必须过这里。
 */
export function sanitizeGhostNoticeText(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS_RE, '').trim();
}

export class GhostNotifySlot {
  /** 每意识最近一次成功提示的时刻(限速账本;沉睡/唤醒不清零——间隔本来就该跨状态算)。 */
  private readonly lastSentAt = new Map<string, number>();

  constructor(private readonly deps: NotifySlotDeps) {}

  /** 处理一条 notify(ghost-pipe:send 的 invoke 返回值即本结果)。 */
  handleNotify(ghostId: string, payload: unknown): GhostPipeNotifyResult {
    const p = payload as { text?: unknown; tone?: unknown };

    const ghost = this.deps.getGhost(ghostId);
    if (!ghost || !ghost.enabled) {
      return { ok: false, message: '意识不在可用状态' };
    }
    if (ghost.manifest.notify !== true) {
      return { ok: false, message: '本意识未声明 notify 能力,无权弹系统提示' };
    }

    if (typeof p?.text !== 'string') {
      return { ok: false, message: 'text 必须是字符串' };
    }
    // 先净化再验空与超限(防用控制字符注水绕过上限)。
    const text = sanitizeGhostNoticeText(p.text);
    if (text.length === 0) {
      return { ok: false, message: 'text 不能为空' };
    }
    if (text.length > GHOST_NOTIFY_MAX_CHARS) {
      return { ok: false, message: `text 过长(上限 ${GHOST_NOTIFY_MAX_CHARS} 字符)` };
    }

    let tone: GhostNotifyTone = 'info';
    if (p.tone !== undefined) {
      if (typeof p.tone !== 'string' || !(GHOST_NOTIFY_TONES as readonly string[]).includes(p.tone)) {
        return { ok: false, message: `未知语气(可用:${GHOST_NOTIFY_TONES.join(' / ')})` };
      }
      tone = p.tone as GhostNotifyTone;
    }

    const now = this.deps.now?.() ?? Date.now();
    const last = this.lastSentAt.get(ghostId);
    if (last !== undefined && now - last < GHOST_NOTIFY_MIN_INTERVAL_MS) {
      return {
        ok: false,
        message: `提示过于频繁(同一意识最小间隔 ${GHOST_NOTIFY_MIN_INTERVAL_MS / 1000} 秒),本条已丢弃`,
      };
    }
    this.lastSentAt.set(ghostId, now);

    this.deps.broadcast({
      ghostId,
      name: ghost.manifest.name,
      ...(ghost.iconDataUrl ? { iconDataUrl: ghost.iconDataUrl } : {}),
      text,
      tone,
    });
    this.deps.log?.info('ghost notify shown', { ghostId, tone, chars: text.length });
    return { ok: true };
  }
}
