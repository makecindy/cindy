/**
 * scheduleSlot.ts — 自动化草稿槽(agent 槽的 schedule 加档,2026-08-04)。
 * ---------------------------------------------------------------------------
 * 插件经管子上行 `{type:'schedule-request', name, prompt, intervalMs?}`,请主机
 * **打开自动化创建面板并预填**。典型用法:插件在自己面板上给用户一个「提醒我
 * Codex 重置时间快到了」之类的选项,用户点了就跳到自动化面板,选个模型点保存。
 *
 * 安全模型 —— 一句话:**它只能开面板,不能建任务。**
 *
 * - 资格审:已装、启用、声明 'agent' 槽 **且** `agent.schedule === true`;
 * - 授权动作 = 用户在自动化面板上**亲手点保存**。本槽全程不碰 schedule storage
 *   (deps 里压根没有建任务的能力,不是"忍着不调"——是给不了),所以不存在
 *   "插件偷偷给自己排一条后台任务"的面。用户不保存,什么都不会发生;
 * - 插件也**拿不到结果**:返回值只表示"面板已打开"。不给它探测用户是否照做的
 *   通道(想知道就等任务真跑起来调它自己的 tool);
 * - 身份不信自报:面板上显示的插件名/图标由主机按已装清单填;
 * - 文本净化 + 截断:name / prompt 都过 sanitizeGhostNoticeText(去控制字符),
 *   再按上限截断——预填内容会进用户的表单,不允许塞控制字符或超长正文;
 * - 频率钳制:插件建议的 intervalMs 一律不低于 30 分钟。这不是权限闸门(用户
 *   自己在面板上改成 1 分钟是他的自由),是防插件预填出一个每分钟烧一次模型
 *   额度的任务、而用户点保存时未必看清频率;
 * - 骚扰钳制:同一插件两次请求最小间隔 GHOST_SCHEDULE_DRAFT_MIN_INTERVAL_MS
 *   (按尝试记账,spam 顺延窗口)。比 preview 长一档 —— 这个面板是打断式的
 *   (把用户从当前页带走),预览标签只是右侧栏多开一页。
 *
 * 纯逻辑 + 依赖注入(规则 14):广播在 cindy-brain/index.ts 组装时注入,
 * 单测喂假 deps 直测。
 */

import { randomUUID } from 'node:crypto';

import {
  GHOST_SCHEDULE_DRAFT_MIN_INTERVAL_MS,
  GHOST_SCHEDULE_DRAFT_MIN_INTERVAL_SUGGESTION_MS,
  GHOST_SCHEDULE_DRAFT_NAME_MAX_CHARS,
  GHOST_SCHEDULE_DRAFT_PROMPT_MAX_CHARS,
  type GhostPipeScheduleDraftResult,
  type GhostScheduleDraftPush,
  type InstalledGhost,
} from '../../shared/ghost.js';
import { sanitizeGhostNoticeText } from './notifySlot.js';

export interface ScheduleSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  /** 把"开面板并预填"推给宿主窗口;false = 一个窗口都不在(HOST_NOT_READY)。 */
  broadcast(payload: GhostScheduleDraftPush): boolean;
  now?(): number;
  /** 仅测试注入;生产用 randomUUID。 */
  newRequestId?(): string;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

function fail(
  errorCode: Extract<GhostPipeScheduleDraftResult, { ok: false }>['errorCode'],
  message: string,
): GhostPipeScheduleDraftResult {
  return { ok: false, errorCode, message };
}

/** 自动化草稿槽:资格审 → 载荷净化 → 频率钳制 → 限速 → 广播开面板。 */
export class GhostScheduleSlot {
  /** 意识 id → 上次尝试时刻(按尝试记账;体量 = 已装意识数,无需清理)。 */
  private readonly lastAttemptAt = new Map<string, number>();

  constructor(private readonly deps: ScheduleSlotDeps) {}

  handleRequest(ghostId: string, payload: unknown): GhostPipeScheduleDraftResult {
    const ghost = this.deps.getGhost(ghostId);
    if (
      !ghost?.enabled ||
      !ghost.manifest.slots.includes('agent') ||
      ghost.manifest.agent?.schedule !== true
    ) {
      return fail(
        'PERMISSION_DENIED',
        '插件未申请「可以请你新建自动化任务」权限(agent 槽的 schedule 加档),或当前未启用',
      );
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return fail('INVALID_REQUEST', 'schedule-request 载荷必须是对象');
    }
    const request = payload as Record<string, unknown>;
    if (typeof request.name !== 'string' || request.name.trim().length === 0) {
      return fail('INVALID_REQUEST', 'name 必填且必须是非空字符串(预填的任务名)');
    }
    if (typeof request.prompt !== 'string' || request.prompt.trim().length === 0) {
      return fail(
        'INVALID_REQUEST',
        'prompt 必填且必须是非空字符串(这条任务到点要干什么,用自然语言写)',
      );
    }
    if (request.intervalMs !== undefined) {
      if (typeof request.intervalMs !== 'number' || !Number.isFinite(request.intervalMs)) {
        return fail('INVALID_REQUEST', 'intervalMs 必须是有限数字(毫秒)');
      }
      if (request.intervalMs <= 0) {
        return fail('INVALID_REQUEST', 'intervalMs 必须大于 0');
      }
    }

    const name = sanitizeGhostNoticeText(request.name).slice(0, GHOST_SCHEDULE_DRAFT_NAME_MAX_CHARS);
    const prompt = sanitizeGhostNoticeText(request.prompt).slice(
      0,
      GHOST_SCHEDULE_DRAFT_PROMPT_MAX_CHARS,
    );
    // 净化后可能只剩空白(全是控制字符/空格)——那等于没给,如实拒而不是推一个空面板。
    if (!name || !prompt) {
      return fail('INVALID_REQUEST', 'name / prompt 净化后为空');
    }

    // 限速按尝试记账:spam 会不断顺延窗口,对真实节奏(用户点一下)无感。
    const now = this.deps.now?.() ?? Date.now();
    const last = this.lastAttemptAt.get(ghostId);
    this.lastAttemptAt.set(ghostId, now);
    if (last !== undefined && now - last < GHOST_SCHEDULE_DRAFT_MIN_INTERVAL_MS) {
      return fail('RATE_LIMITED', '打开自动化面板的请求太频繁,稍后再试');
    }

    // 频率建议只上调不下调(见文件头注释)。
    const intervalMs =
      typeof request.intervalMs === 'number'
        ? Math.max(
            Math.floor(request.intervalMs),
            GHOST_SCHEDULE_DRAFT_MIN_INTERVAL_SUGGESTION_MS,
          )
        : undefined;

    const delivered = this.deps.broadcast({
      requestId: this.deps.newRequestId?.() ?? randomUUID(),
      ghostId,
      ghostName: ghost.manifest.name,
      ...(ghost.iconDataUrl ? { iconDataUrl: ghost.iconDataUrl } : {}),
      name,
      prompt,
      ...(intervalMs !== undefined ? { intervalMs } : {}),
    });
    if (!delivered) {
      return fail('HOST_NOT_READY', '当前没有可用的宿主窗口');
    }
    this.deps.log?.info('ghost schedule draft requested', {
      ghostId,
      intervalMs: intervalMs ?? null,
      // 只记长度不记正文:预填 prompt 是用户面前的业务内容,日志里没必要留副本。
      promptChars: prompt.length,
    });
    return { ok: true };
  }
}
