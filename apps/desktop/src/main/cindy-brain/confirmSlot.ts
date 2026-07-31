/**
 * confirmSlot.ts — 确认弹窗槽(confirm,2026-07-31)。
 * ---------------------------------------------------------------------------
 * 插件经管子上行 `{type:'confirm-request', body, confirmText?, cancelText?, danger?}`,
 * 请主机弹**主机同款**的二选一确认框(renderer 的 ConfirmDialogProvider),拿回
 * 用户的真实点击。
 *
 * 为什么单独开一个槽:notify 槽是「说一句就走」(无按钮、无回执),插件要
 * 「动手前问一句」时只能自己在面板里画一个,每个插件画一套、长得都不一样,
 * 而且面板外的场景(工具调用链里)根本没法问。本槽把基座自己在用的通用弹窗
 * 接口开放出来,形态与基座一致。
 *
 * 安全模型(与 pick 槽同一套哲学:决定权在用户的点击上):
 *
 * - 资格审:已装、启用、声明 confirm 槽;
 * - 主机拥有壳:标题是主机文案(带插件名)、身份头(图标+名字)由 renderer 从
 *   已装清单取——**不用载荷里的自报字段**。插件只供 body 与按钮字,全部过
 *   sanitizeGhostNoticeText 净化并卡长度上限;伪装不了主机文案、冒充不了别的
 *   插件,也点不了自己的按钮(点击链路主机独占);
 * - 骚扰钳制:同插件两次最小间隔 GHOST_CONFIRM_MIN_INTERVAL_MS(按尝试记账,
 *   spam 顺延窗口),**全局**同时只允许一个确认框在场(BUSY)——排队就是骚扰
 *   队列,模态框比 toast 更不能排;
 * - fail closed:超时、无可挂靠窗口、桥未就绪、载荷非法一律当「没同意」,
 *   绝不把「问不出来」错当成「用户同意了」;
 * - 不开放「下次不再提示」:那等于插件点一次换来永久免问,直接废掉确认的意义。
 *   三状态(confirmThree)与业务复选框同理,v1 都不开。
 *
 * 处理结果永不 reject——一切失败折叠成结构化 { ok:false, errorCode, message }
 * (与 pick / cindy 槽同纪律,沙箱拿到的是拒绝而不是异常穿透)。
 * 纯逻辑 + 依赖注入(规则 14):弹窗投递由 cindy-brain/index.ts 组装时注入,
 * 单测喂假 deps 直测。
 */

import {
  GHOST_CONFIRM_BODY_MAX_CHARS,
  GHOST_CONFIRM_BUTTON_MAX_CHARS,
  GHOST_CONFIRM_MIN_INTERVAL_MS,
  type GhostPipeConfirmResult,
  type InstalledGhost,
} from '../../shared/ghost.js';
import { sanitizeGhostNoticeText } from './notifySlot.js';

/** 交给桥去弹的一单(身份三件套由主机按已装清单填,不信插件自报)。 */
export interface GhostConfirmShowParams {
  ghostId: string;
  /** 插件展示名(主机拼标题用)。 */
  ghostName: string;
  /** 插件图标 data URL(身份头;未声明图标时缺省)。 */
  iconDataUrl?: string;
  /** 净化后的问句正文。 */
  body: string;
  /** 净化后的主按钮文案;null = 用主机缺省文案。 */
  confirmText: string | null;
  /** 净化后的次按钮文案;null = 用主机缺省文案。 */
  cancelText: string | null;
  danger: boolean;
}

export interface ConfirmSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  /**
   * 弹确认框并等用户点击:true = 点了主按钮;false = 取消 / Esc / 点外部 / 超时。
   * 通道不可用(没有可挂靠的 Cindy 窗口、桥还没装配)时应 reject —— 槽据此回
   * UNAVAILABLE,而不是谎报成「用户拒绝」。
   */
  showConfirm(params: GhostConfirmShowParams): Promise<boolean>;
  now?(): number;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

function fail(
  errorCode: Extract<GhostPipeConfirmResult, { ok: false }>['errorCode'],
  message: string,
): GhostPipeConfirmResult {
  return { ok: false, errorCode, message };
}

/**
 * 按钮文案净化:空串/纯空白当「没给」(回 null → 用主机缺省文案),超长直接拒单
 * ——按钮被塞长文会挤坏弹窗版式,静默截断会让作者以为自己写的话完整显示了。
 */
function normalizeButtonText(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false };
  const text = sanitizeGhostNoticeText(raw);
  if (!text) return { ok: true, value: null };
  if (text.length > GHOST_CONFIRM_BUTTON_MAX_CHARS) return { ok: false };
  return { ok: true, value: text };
}

/** 确认弹窗槽:资格审 → 校验/净化 → 限速/单飞 → 弹窗 → 回答案。 */
export class GhostConfirmSlot {
  /** 插件 id → 上次尝试时刻(按尝试记账;体量 = 已装插件数,无需清理)。 */
  private readonly lastAttemptAt = new Map<string, number>();
  /** 全局在场标记(模态框一次一个,不排队——排队就是骚扰队列)。 */
  private dialogInFlight = false;

  constructor(private readonly deps: ConfirmSlotDeps) {}

  async handleRequest(ghostId: string, payload: unknown): Promise<GhostPipeConfirmResult> {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost?.enabled || !ghost.manifest.slots.includes('confirm')) {
      return fail('PERMISSION_DENIED', '插件未申请确认弹窗权限(confirm 槽),或当前未启用');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return fail('INVALID_REQUEST', 'confirm-request 载荷必须是对象');
    }
    const request = payload as Record<string, unknown>;

    if (typeof request.body !== 'string') {
      return fail('INVALID_REQUEST', 'body 必须是字符串(要问用户的话)');
    }
    // 先净化再验空与超限(防用控制字符注水绕过上限)。
    const body = sanitizeGhostNoticeText(request.body);
    if (!body) {
      return fail('INVALID_REQUEST', 'body 不能为空——没写要问什么,弹出来用户也不知道在同意啥');
    }
    if (body.length > GHOST_CONFIRM_BODY_MAX_CHARS) {
      return fail('INVALID_REQUEST', `body 过长(上限 ${GHOST_CONFIRM_BODY_MAX_CHARS} 字符)`);
    }
    if (request.danger !== undefined && typeof request.danger !== 'boolean') {
      return fail('INVALID_REQUEST', 'danger 必须是布尔值');
    }
    const confirmText = normalizeButtonText(request.confirmText);
    if (!confirmText.ok) {
      return fail(
        'INVALID_REQUEST',
        `confirmText 必须是字符串且不超过 ${GHOST_CONFIRM_BUTTON_MAX_CHARS} 字符`,
      );
    }
    const cancelText = normalizeButtonText(request.cancelText);
    if (!cancelText.ok) {
      return fail(
        'INVALID_REQUEST',
        `cancelText 必须是字符串且不超过 ${GHOST_CONFIRM_BUTTON_MAX_CHARS} 字符`,
      );
    }

    // 骚扰钳制:限速按尝试记账(spam 顺延窗口),再看全局在场标记。
    const now = this.deps.now?.() ?? Date.now();
    const last = this.lastAttemptAt.get(ghostId);
    this.lastAttemptAt.set(ghostId, now);
    if (last !== undefined && now - last < GHOST_CONFIRM_MIN_INTERVAL_MS) {
      return fail('RATE_LIMITED', '确认请求太频繁,稍后再试');
    }
    if (this.dialogInFlight) {
      return fail('BUSY', '已有一个确认框在等用户操作');
    }

    this.dialogInFlight = true;
    let confirmed: boolean;
    try {
      confirmed = await this.deps.showConfirm({
        ghostId,
        ghostName: ghost.manifest.name,
        ...(ghost.iconDataUrl ? { iconDataUrl: ghost.iconDataUrl } : {}),
        body,
        confirmText: confirmText.value,
        cancelText: cancelText.value,
        danger: request.danger === true,
      });
    } catch (error) {
      this.deps.log?.warn('ghost confirm dialog failed', {
        ghostId,
        err: error instanceof Error ? error.message : String(error),
      });
      return fail('UNAVAILABLE', '确认框打不开(没有可挂靠的窗口)');
    } finally {
      this.dialogInFlight = false;
    }

    this.deps.log?.info('ghost confirm answered', { ghostId, confirmed });
    return { ok: true, confirmed };
  }
}
