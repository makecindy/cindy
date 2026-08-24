/**
 * cardActionDispatch.ts — 交互卡按钮点击回传(卡片交互 v2,card 槽)。
 * ---------------------------------------------------------------------------
 * 真实用户点了意识自绘卡上的 data-ghost-action 元素 → renderer 经 IPC 上报
 * (callId + actionId)→ 本派发器:
 *
 *   校验 actionId 形状(GHOST_CARD_ACTION_ID_RE)
 *     → 归属解析(callId → ghostId:先内存卡片服务、再持久卡库兜底——
 *       MJ 按钮常在卡 settle 很久后甚至重启后才点,内存条目早清)
 *     → 唤醒意识(按需拉起,同 subscribe askOne 的"不在跑就 wake")
 *     → 管子下行投递 { type:'event', name:'card-action', callId, actionId, ts }
 *
 * fire-and-forget:不等意识回执(意识自己干活 + card-update 换新卡,走既有
 * 回放路径)。归属查无 / 唤醒失败 / 意识不在 = 结构化失败并记日志,不抛。
 * 点击是真实用户手势、由宿主受信桥独占触发——意识跑不了脚本,伪造不了点击。
 *
 * 依赖注入(规则 14):归属查询 / 唤醒 / 投递全经 deps,单测直测零 Electron。
 */

import {
  GHOST_CARD_ACTION_ID_RE,
  GHOST_CARD_ACTION_PROMPT_MAX_LEN,
  GHOST_CARD_SPAWN_SEP,
  ghostCardRootCallId,
  type GhostPipeEventPush,
  type InstalledGhost,
} from '../../shared/ghost.js';
import { isGhostOwnerScopeUsable, type GhostOwnerScope } from './ghostOwnerScope.js';

export interface CardActionDispatchDeps {
  /** 内存卡片服务:in-flight + 宽限窗内的条目(归属 + 会话;命中最快)。 */
  resolveLiveInfo(callId: string): { ghostId: string; sessionId: string | null } | null;
  /** 持久卡库兜底:settle 后 / 重启后仍能查到卡的归属 + 会话(内存查无时用)。 */
  resolvePersistedCard(callId: string): Promise<{ ghostId: string; sessionId: string | null } | null>;
  /**
   * 重开卡片更新窗口:让意识在结算很久后 / 重启后仍能 card-update 换新卡
   * (cardService.reopenForAction)。sessionId 仅在内存条目已被清扫、需重建时用。
   */
  reopenForAction(callId: string, info: { ghostId: string; sessionId: string | null }): void;
  /** 取意识(校验在场 + 启用 + 声明了 card 槽)。 */
  getGhost(id: string): InstalledGhost | null;
  /** 是否已在跑(不在跑则 wake)。 */
  isRunning(ghostId: string): boolean;
  /** 按需拉起意识电子脑(幂等)。 */
  wake(ghost: InstalledGhost): Promise<void>;
  /** 管子下行投递(electronSandboxAdapter.sendToGhostLogic)。 */
  sendToGhost(ghostId: string, payload: GhostPipeEventPush): void;
  /**
   * 为本次受信点击签发 Agent 一次性票据。插件没申请 agent 槽或卡片没有
   * session 归属时返回 null，card-action 仍照常投递。
   */
  issueUserActionToken?(ghostId: string, sessionId: string | null): string | null;
  /**
   * 后台活动起点(会话呼吸链路,可选):点击成功投递给意识后上报——
   * 从用户点下按钮那刻起会话侧栏就该亮呼吸,不等意识的第一版过程卡。
   * key = 新结果的画布卡位(衍生卡位,极端回退原 callId)。sessionId 查无
   * (老卡无会话归属)时不上报。
   */
  onActivityStart?(key: string, sessionId: string): void;
  ownerScope?: GhostOwnerScope;
  now?(): number;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/** 归因号长度上限(与 cardService / cindySlot 同口径)。 */
const MAX_CALL_ID_LEN = 128;

export type CardActionResult =
  | { ok: true }
  | { ok: false; reason: string };

export class GhostCardActionDispatcher {
  constructor(private readonly deps: CardActionDispatchDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * 处理一次卡片按钮点击。永不抛——一切失败折叠成 { ok:false, reason }
   * (IPC 层对 renderer 恒可回,reason 仅诊断)。prompt 仅 data-ghost-prompt
   * 类动作有(宿主输入框收集的用户文字),可选;非法形状整次拒。
   */
  async dispatch(callId: unknown, actionId: unknown, prompt?: unknown): Promise<CardActionResult> {
    if (typeof callId !== 'string' || callId.length === 0 || callId.length > MAX_CALL_ID_LEN) {
      return { ok: false, reason: 'bad-call-id' };
    }
    if (typeof actionId !== 'string' || !GHOST_CARD_ACTION_ID_RE.test(actionId)) {
      return { ok: false, reason: 'bad-action-id' };
    }
    // prompt:缺省/空串视为"没有";有值必须是限长字符串(不信 renderer)。
    let promptText: string | undefined;
    if (prompt !== undefined && prompt !== null && prompt !== '') {
      if (typeof prompt !== 'string' || prompt.length > GHOST_CARD_ACTION_PROMPT_MAX_LEN) {
        return { ok: false, reason: 'bad-prompt' };
      }
      const trimmed = prompt.trim();
      if (trimmed.length > 0) promptText = trimmed;
    }

    // 归属:内存优先(快),持久兜底(settle/重启后仍成立)。查无 = 拒
    // (不区分"卡不存在"与"不属于任何在场意识",不给探测面)。
    // sessionId 一并取出:重建被清扫条目、登记衍生卡位都要续会话归属。
    let capturedOwner: unknown;
    if (this.deps.ownerScope) {
      try {
        capturedOwner = this.deps.ownerScope.capture();
      } catch {
        return { ok: false, reason: 'owner-boundary' };
      }
      if (!isGhostOwnerScopeUsable(this.deps.ownerScope, capturedOwner)) {
        return { ok: false, reason: 'owner-boundary' };
      }
    }

    const ownerUsable = (): boolean =>
      isGhostOwnerScopeUsable(this.deps.ownerScope, capturedOwner);
    const rejectStaleOwner = (ghostId?: string): CardActionResult => {
      if (ghostId) this.deps.ownerScope?.onInvalidated?.(ghostId);
      return { ok: false, reason: 'owner-boundary' };
    };

    let info = this.deps.resolveLiveInfo(callId);
    if (!info) info = await this.deps.resolvePersistedCard(callId);
    if (!ownerUsable()) return rejectStaleOwner(info?.ghostId);
    if (!info) {
      this.deps.log?.warn('card-action rejected: unknown card', { callId });
      return { ok: false, reason: 'unknown-card' };
    }
    const { ghostId, sessionId } = info;

    const ghost = this.deps.getGhost(ghostId);
    if (!ghost || !ghost.enabled) {
      this.deps.log?.warn('card-action rejected: ghost unavailable', { ghostId, callId });
      return { ok: false, reason: 'ghost-unavailable' };
    }
    if (!ghost.manifest.slots?.includes('card')) {
      // 卡片是它发的却没 card 槽 = 不该发生;保险起见拒。
      this.deps.log?.warn('card-action rejected: no card slot', { ghostId, callId });
      return { ok: false, reason: 'no-card-slot' };
    }

    // 重开被点卡的更新窗口(意识仍可原地换它,向后兼容),并铸一个衍生卡位:
    // 新结果画到 spawnCallId = 原卡下方长出新卡,母卡(四宫格+按钮)原封不动。
    // 衍生卡一律以根 callId 为前缀平铺(点衍生卡按钮再 spawn 也不嵌套),
    // 长度可控;极端超限(不该发生)回退原 callId,意识退化为原地换卡。
    this.deps.reopenForAction(callId, { ghostId, sessionId });
    const root = ghostCardRootCallId(callId);
    let spawnCallId = `${root}${GHOST_CARD_SPAWN_SEP}${this.now().toString(36)}`;
    if (spawnCallId.length > MAX_CALL_ID_LEN) spawnCallId = callId;
    if (spawnCallId !== callId) {
      this.deps.reopenForAction(spawnCallId, { ghostId, sessionId });
    }

    try {
      if (!ownerUsable()) return rejectStaleOwner(ghostId);
      if (!this.deps.isRunning(ghostId)) {
        await this.deps.wake(ghost);
        if (!ownerUsable()) return rejectStaleOwner(ghostId);
      }
      // 卡片路径只发这一张一次性票；不另记面板手势，避免一次点击两份凭据。
      const userActionToken = this.deps.issueUserActionToken?.(ghostId, sessionId) ?? null;
      if (!ownerUsable()) return rejectStaleOwner(ghostId);
      this.deps.sendToGhost(ghostId, {
        type: 'event',
        name: 'card-action',
        callId,
        actionId,
        ...(sessionId ? { sessionId } : {}),
        ...(userActionToken ? { userActionToken } : {}),
        ...(promptText !== undefined ? { prompt: promptText } : {}),
        spawnCallId,
        ts: this.now(),
      });
    } catch (err) {
      this.deps.log?.warn('card-action deliver failed', {
        ghostId,
        callId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, reason: 'deliver-failed' };
    }

    // 呼吸起点:投递成功即亮(意识后台干活从这一刻开始;结束/兜底由
    // 活动跟踪器按 card-update state / TTL 收口)。
    if (sessionId) this.deps.onActivityStart?.(spawnCallId, sessionId);

    this.deps.log?.info('card-action delivered', { ghostId, callId, actionId, spawnCallId });
    return { ok: true };
  }
}
