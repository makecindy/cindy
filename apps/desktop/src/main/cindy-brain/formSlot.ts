/**
 * formSlot.ts — 表单弹窗槽(form,2026-11-23)。
 * ---------------------------------------------------------------------------
 * 插件经管子上行 `{type:'form-request', title, fields, values?, submitText?, cancelText?, action?}`,
 * 请主机弹一个主机画的表单弹窗,拿回用户保存的值。载荷形状与校验在 shared/ghostForm.ts。
 *
 * 安全模型沿用确认弹窗(confirmSlot):
 * - 资格审:已装、启用、声明 form;
 * - 主机拥有壳:身份头(图标+名字)来自已装清单,插件写不了;插件给的所有文案都过
 *   sanitizeGhostNoticeText 净化并卡长度上限;按钮由主机画,插件点不了;
 * - 骚扰钳制:同插件两次最小间隔 GHOST_FORM_MIN_INTERVAL_MS(从上一次请求或上一个表单
 *   关掉算起),全局同时只允许一个表单在场(BUSY,不排队);
 * - **只在用户正看着 Cindy 时弹**:没有获得焦点的 Cindy 窗口就回 UNAVAILABLE。表单要
 *   用户填一阵子,在用户没在看的时候冒出来只会打断别的事;远程查看设置页时点的按钮
 *   也不会在无人的被控电脑上弹出一个等十分钟的框——插件据此退回自己的页面;
 * - fail closed:超时、窗口关闭、回包非法一律当「取消」;renderer 回传的值按原表单
 *   再收口一遍(coerceGhostFormValues),不信回包形状。
 *
 * 手机插件页(mobilePageId)暂不支持,回 UNAVAILABLE。
 * 处理结果永不 reject——一切失败折叠成结构化 { ok:false, errorCode, message }。
 * 纯逻辑 + 依赖注入:窗口投递由 cindy-brain/index.ts 组装时注入,单测喂假 deps。
 */

import type { InstalledGhost } from '../../shared/ghost.js';
import {
  GHOST_FORM_MIN_INTERVAL_MS,
  coerceGhostFormValues,
  parseGhostFormRequest,
  type GhostFormAnswer,
  type GhostFormSpec,
  type GhostPipeFormResult,
} from '../../shared/ghostForm.js';
import { sanitizeGhostNoticeText } from './notifySlot.js';

/** 交给桥去弹的一单(身份由主机按已装清单填,不信插件自报)。 */
export interface GhostFormShowParams {
  ghostId: string;
  ghostName: string;
  iconDataUrl?: string;
  spec: GhostFormSpec;
}

export interface FormSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  /** 现在有没有获得焦点的 Cindy 窗口(用户正看着 Cindy)。 */
  hasFocusedWindow(): boolean;
  /**
   * 弹表单并等用户操作。通道不可用(投不出去)时应 reject —— 槽据此回 UNAVAILABLE,
   * 而不是谎报成「用户取消」。超时、窗口关闭等一律 resolve 成 cancel。
   */
  showForm(params: GhostFormShowParams): Promise<GhostFormAnswer>;
  now?(): number;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

function fail(
  errorCode: Extract<GhostPipeFormResult, { ok: false }>['errorCode'],
  message: string,
): GhostPipeFormResult {
  return { ok: false, errorCode, message };
}

/** 表单弹窗槽:资格审 → 校验/净化 → 限速/单飞/前台 → 弹窗 → 收口答案。 */
export class GhostFormSlot {
  /** 插件 id → 上次请求或上个表单关掉的时刻(体量 = 已装插件数)。 */
  private readonly lastAttemptAt = new Map<string, number>();
  /** 全局在场标记(模态框一次一个,不排队)。 */
  private dialogInFlight = false;

  constructor(private readonly deps: FormSlotDeps) {}

  async handleRequest(ghostId: string, payload: unknown): Promise<GhostPipeFormResult> {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost?.enabled || ghost.manifest.form !== true) {
      return fail('PERMISSION_DENIED', '插件未申请表单弹窗权限(form),或当前未启用');
    }
    if (payload && typeof payload === 'object' && 'mobilePageId' in payload) {
      return fail('UNAVAILABLE', '手机上的插件页面暂不支持表单弹窗');
    }
    const parsed = parseGhostFormRequest(payload, sanitizeGhostNoticeText);
    if (!parsed.ok) return fail('INVALID_REQUEST', parsed.message);
    const spec = parsed.value;

    // 骚扰钳制:限速按尝试记账(spam 顺延窗口),再看全局在场标记。
    const now = this.deps.now?.() ?? Date.now();
    const last = this.lastAttemptAt.get(ghostId);
    this.lastAttemptAt.set(ghostId, now);
    if (last !== undefined && now - last < GHOST_FORM_MIN_INTERVAL_MS) {
      return fail('RATE_LIMITED', '表单请求太频繁,稍后再试');
    }
    if (this.dialogInFlight) return fail('BUSY', '已有一个表单在等用户填写');
    if (!this.deps.hasFocusedWindow()) {
      return fail('UNAVAILABLE', 'Cindy 窗口不在前台;表单只在用户正看着 Cindy 时弹出');
    }

    this.dialogInFlight = true;
    let answer: GhostFormAnswer;
    try {
      answer = await this.deps.showForm({
        ghostId,
        ghostName: ghost.manifest.name,
        ...(ghost.iconDataUrl ? { iconDataUrl: ghost.iconDataUrl } : {}),
        spec,
      });
    } catch (error) {
      this.deps.log?.warn('ghost form dialog failed', {
        ghostId,
        err: error instanceof Error ? error.message : String(error),
      });
      return fail('UNAVAILABLE', '表单打不开(没有可挂靠的窗口)');
    } finally {
      this.dialogInFlight = false;
      this.lastAttemptAt.set(ghostId, this.deps.now?.() ?? Date.now());
    }

    this.deps.log?.info('ghost form answered', { ghostId, outcome: answer.outcome });
    if (answer.outcome === 'submit') {
      return { ok: true, outcome: 'submit', values: coerceGhostFormValues(spec.fields, answer.values) };
    }
    if (answer.outcome === 'action' && spec.action) return { ok: true, outcome: 'action', action: spec.action.id };
    return { ok: true, outcome: 'cancel' };
  }
}
