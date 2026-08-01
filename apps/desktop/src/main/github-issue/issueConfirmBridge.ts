/**
 * IssueConfirmBridge —— submit_github_issue 工具的「提交前用户确认」桥。
 *
 * MCP tool handler 在 main 进程发起确认请求,本桥 broadcast 一个
 * kind='issue_confirm' 的 interaction 到 renderer(复用 MAKER_PUSH.INTERACTION_REQUEST
 * channel 和 MAKER_INVOKE.RESOLVE_INTERACTION 回包通道),并用 pending promise
 * 挂起直到用户在确认卡片上确认/取消、超时或会话被关闭。
 *
 * 为什么不进 register.ts 的 pendingInteractionResolvers:
 *  1. 那套 map 服务于 agent(maker-core)发起的 InteractionRequest 闭合 union
 *     (permission/ask_user_question/plan_review),扩 union 会把 app 业务类型
 *     污染进 agent 抽象层;
 *  2. feishu /ctr 接管路径会把 pending 整体搬去飞书,而 IM 侧对未知 kind 直接
 *     deny,行为不可控 —— 独立桥保证确认卡只在 desktop 出现、超时即兜底;
 *  3. 独立模块可注入依赖、可单测(规则 14)。
 *
 * 本模块保持 electron-free(broadcast 由调用方注入),单测直接 new。
 */

import { randomUUID } from 'node:crypto';

import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

import { normalizeIssuePublicName } from '../../shared/issuePublicName.js';
import { MAKER_PUSH } from '../maker-ipc/channels';
import { HOST_CONFIRM_TIMEOUT_MS } from '../maker-ipc/hostConfirmTiming.js';

export interface IssueDraft {
  title: string;
  body: string;
  type: 'bug' | 'feature';
}

/** 确认卡片只读展示的环境信息(最终会被附进 issue body)。 */
export interface IssueEnvInfo {
  appVersion: string;
  platform: string;
  arch: string;
  osVersion: string;
  /**
   * 本构建的区域身份(中国版 / 国际版 / 开发版)。构建期烘焙、运行时不可切换,
   * 但同一个版本号在两区是两个不同的包——反馈里没有它就分不清用户装的是哪一个。
   */
  region: CindyRegion;
}

/** 确认后真正写入 GitHub 的身份；卡片必须原样展示，避免把平台代提交误认成用户本人。 */
export type IssueSubmissionIdentity =
  { kind: 'github-user'; login: string } | { kind: 'platform'; login: string };

export type IssueConfirmDecision =
  | {
      confirmed: true;
      /** 用户确认时卡片上的最终值(可能被编辑过)。 */
      title: string;
      body: string;
      type: 'bug' | 'feature';
      /** 平台代发时由用户确认的公开署名；GitHub 用户直发时不存在。 */
      publicName?: string;
      /** renderer 当前界面语言(i18n.language);main 侧 OS locale 仅作 fallback。 */
      uiLanguage?: string;
    }
  | {
      confirmed: false;
      reason: 'cancelled' | 'timeout' | 'session_closed' | 'session_aborted';
    };

/** Renderer 可重放的提交确认请求；主进程持有它直到确认流程 settle。 */
export interface IssueConfirmInteractionSnapshot {
  kind: 'issue_confirm';
  requestId: string;
  draft: IssueDraft;
  env: IssueEnvInfo;
  submissionIdentity: IssueSubmissionIdentity;
  suggestedPublicName?: string;
}

export interface IssueConfirmBridgeDeps {
  broadcast: (channel: string, payload: unknown) => void;
  /** 确认超时,默认 9 分钟,须早于外层 MCP 的 10 分钟 deadline。测试注小值。 */
  timeoutMs?: number;
  logger?: { warn: (...args: unknown[]) => void };
  /**
   * 确认卡已派发的回调(#926):确认卡有意只在桌面出现,IM 绑定会话的用户可能
   * 人在 IM 侧看不到 —— 接线方在这里给 IM 发「去桌面确认」的文字提示。
   * fire-and-forget,不得阻塞或影响确认流程。
   */
  onDesktopOnlyConfirmPending?: (sessionId: string) => void;
}

interface PendingConfirmEntry {
  sessionId: string;
  request: IssueConfirmInteractionSnapshot;
  requiresPublicName: boolean;
  resolve: (decision: IssueConfirmDecision) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class IssueConfirmBridge {
  private readonly pending = new Map<string, PendingConfirmEntry>();

  constructor(private readonly deps: IssueConfirmBridgeDeps) {}

  /** 向 renderer 派发确认卡片,挂起直到用户响应/超时/会话清理。 */
  request(
    sessionId: string,
    draft: IssueDraft,
    env: IssueEnvInfo,
    submissionIdentity: IssueSubmissionIdentity,
    suggestedPublicName?: string,
  ): Promise<IssueConfirmDecision> {
    const requestId = randomUUID();
    const request: IssueConfirmInteractionSnapshot = {
      kind: 'issue_confirm',
      requestId,
      draft,
      env,
      submissionIdentity,
      suggestedPublicName,
    };
    return new Promise<IssueConfirmDecision>((resolve) => {
      const timeoutMs = this.deps.timeoutMs ?? HOST_CONFIRM_TIMEOUT_MS;
      const timeoutId = setTimeout(() => {
        this.settle(requestId, { confirmed: false, reason: 'timeout' }, 'timeout');
      }, timeoutMs);
      this.pending.set(requestId, {
        sessionId,
        request,
        requiresPublicName: submissionIdentity.kind === 'platform',
        resolve,
        timeoutId,
      });
      this.deps.broadcast(MAKER_PUSH.INTERACTION_REQUEST, {
        sessionId,
        request,
      });
      try {
        this.deps.onDesktopOnlyConfirmPending?.(sessionId);
      } catch (err) {
        // 旁路提示绝不反噬确认流程:回调同步抛错会在 Promise executor 里把
        // request() 直接 reject(review 反馈)——吞错只 warn。
        this.deps.logger?.warn('onDesktopOnlyConfirmPending threw (ignored)', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  /** 打开、重连或刷新会话时供 renderer 补回错过的确认卡。 */
  pendingSnapshots(sessionId?: string): Array<{
    sessionId: string;
    request: IssueConfirmInteractionSnapshot;
  }> {
    return Array.from(this.pending.values())
      .filter((entry) => sessionId === undefined || entry.sessionId === sessionId)
      .map((entry) => ({ sessionId: entry.sessionId, request: entry.request }));
  }

  /**
   * renderer 经 RESOLVE_INTERACTION 回包。返回是否命中本桥的 pending
   * (false = requestId 不属于本桥,调用方继续走原有 resolver 查找/告警)。
   */
  resolve(requestId: string, rawDecision: unknown): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    let decision = parseDecision(rawDecision, entry.requiresPublicName);
    if (!decision) {
      // shape 非法按取消兜底,避免 tool handler 永久挂起。
      this.deps.logger?.warn('issue-confirm: invalid decision shape, fallback to cancelled', {
        requestId,
      });
      decision = { confirmed: false, reason: 'cancelled' };
    }
    this.settlePending(requestId, entry, decision);
    // 同会话开在多个窗口时,确认卡 broadcast 给了所有窗口;响应窗口在发 IPC 前
    // 已自清 state,其余窗口靠这条 DISMISSED 收卡(store 按 requestId 匹配,
    // 响应窗口收到时 pending 已空,no-op)。
    this.deps.broadcast(MAKER_PUSH.INTERACTION_DISMISSED, {
      sessionId: entry.sessionId,
      requestId,
      reason: 'resolved',
      resolvedAs: decision.confirmed ? 'allow' : 'deny',
    });
    return true;
  }

  /** 会话关闭/中止时清掉该会话所有 pending,并让 renderer 收卡。 */
  cleanupForSession(sessionId: string, reason: 'session_closed' | 'session_aborted'): void {
    for (const [requestId, entry] of Array.from(this.pending.entries())) {
      if (entry.sessionId !== sessionId) continue;
      this.settle(requestId, { confirmed: false, reason }, reason);
    }
  }

  /** 内部统一收口:resolve + 清 pending + 广播 DISMISSED 让 renderer 关卡片。 */
  private settle(
    requestId: string,
    decision: IssueConfirmDecision & { confirmed: false },
    dismissReason: string,
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.settlePending(requestId, entry, decision);
    this.deps.broadcast(MAKER_PUSH.INTERACTION_DISMISSED, {
      sessionId: entry.sessionId,
      requestId,
      reason: dismissReason,
      resolvedAs: 'deny',
    });
  }

  private settlePending(
    requestId: string,
    entry: PendingConfirmEntry,
    decision: IssueConfirmDecision,
  ): void {
    this.pending.delete(requestId);
    clearTimeout(entry.timeoutId);
    entry.resolve(decision);
  }
}

function parseDecision(raw: unknown, requiresPublicName: boolean): IssueConfirmDecision | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.confirmed === false) {
    return { confirmed: false, reason: 'cancelled' };
  }
  if (
    obj.confirmed === true &&
    typeof obj.title === 'string' &&
    obj.title.trim().length > 0 &&
    typeof obj.body === 'string' &&
    obj.body.trim().length > 0 &&
    (obj.type === 'bug' || obj.type === 'feature')
  ) {
    const publicName = requiresPublicName ? normalizeIssuePublicName(obj.publicName) : undefined;
    if (requiresPublicName && !publicName) return null;
    return {
      confirmed: true,
      title: obj.title.trim(),
      body: obj.body.trim(),
      type: obj.type,
      ...(publicName ? { publicName } : {}),
      uiLanguage: typeof obj.uiLanguage === 'string' ? obj.uiLanguage : undefined,
    };
  }
  return null;
}
