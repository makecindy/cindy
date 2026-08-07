/**
 * assistantReplyHook.ts — will-assistant-message 出口钩子的应用编排(可测核心)。
 *
 * 机制(Design A,先定案 → 一拍后替换,2026-07-13 定案):AI 回复照常流式 +
 * 正常落库显示;turn 结束后主机在**独立异步续跑**里把全文交给声明了
 * will-assistant-message 的意识裁决(网关串行链式,超时 fail-open),裁决回来
 * 再对**那条已落库的 assistant 消息**原地更新:
 *   - allow  → 什么都不做(原文即最终);
 *   - rewrite→ 用改写正文覆盖该消息内容(落库 + 广播,气泡静默换文本);
 *   - render → 意识自绘卡片(净化后持久化 + 广播,按消息 clientId 寻址),原文
 *              仍在库里,renderer 提供"查看原文"切回(信任边界)。
 * 全程不阻塞 turn 结束记账/发下一条;不碰 maker-core 热路径(规则 10)。
 *
 * 依赖全注入(规则 14):真实装配在 cindy-brain/index.ts,单测直喂内存 deps。
 */

import type { GhostAssistantScreenResult } from './subscriptionGateway.js';

/** render 裁决落地所需的净化后卡片(html 已净化、height 已 clamp)。 */
export interface AssistantRenderCard {
  ghostId: string;
  ghostName: string;
  html: string;
  height?: number;
}

export interface AssistantReplyHookDeps {
  /** 是否有启用的意识声明了 will-assistant-message(快路径:无则整段跳过)。 */
  hasHook(): boolean;
  /** 会话是否在投递范围(用户主会话:desktop、非 orca)。 */
  isEligible(sessionId: string): Promise<boolean>;
  /** 网关串行链式裁决(allow/rewrite/render)。 */
  screen(sessionId: string, text: string): Promise<GhostAssistantScreenResult>;
  /** rewrite:用改写正文覆盖该 assistant 消息内容(落库)。 */
  persistRewrite(sessionId: string, clientId: string, text: string): Promise<void>;
  /**
   * render:净化 + 持久化 + 广播自绘卡片(卡片 callId = 该消息 clientId)。
   * renderer 靠"byCallId 出现了以本消息 clientId 为键的卡"即判定该气泡被自绘
   * 替换,故无需另一条"已自绘"广播——卡片推送本身即信号。
   */
  applyRenderCard(sessionId: string, clientId: string, card: AssistantRenderCard): Promise<void>;
  /** rewrite 完成广播(renderer 气泡静默换文本;updateMessageContent 不广播,靠它)。 */
  broadcastRewritten(p: {
    sessionId: string;
    clientId: string;
    ghostId: string;
    ghostName: string;
    text: string;
  }): void;
  /** "意识处理中"轻指示开/关(回复已显示、后台意识还在跑的那段)。 */
  setPending(sessionId: string, clientId: string, pending: boolean): void;
  /** Optional owner-boundary fence for the async continuation. */
  isCurrent?(): boolean;
  log?: {
    warn(msg: string, meta?: Record<string, unknown>): void;
  };
}

/**
 * 出口钩子编排主体。异常一律吞掉收敛为无副作用(绝不能因意识故障影响会话)。
 * clientId = 本轮 assistant 消息的持久化 id(== messages.client_id,渲染 key)。
 */
export async function runAssistantReplyHook(
  deps: AssistantReplyHookDeps,
  sessionId: string,
  clientId: string,
  text: string,
): Promise<void> {
  try {
    if (deps.isCurrent && !deps.isCurrent()) return;
    // 快路径:无 hook 意识直接返回(register.ts 调用点也已同步守卫,双保险)。
    if (!deps.hasHook()) return;
    if (!text || text.length === 0) return;
    if (!(await deps.isEligible(sessionId))) return;
    if (deps.isCurrent && !deps.isCurrent()) return;

    deps.setPending(sessionId, clientId, true);
    try {
      const result = await deps.screen(sessionId, text);
      if (deps.isCurrent && !deps.isCurrent()) return;
      if (result.action === 'rewrite') {
        if (deps.isCurrent && !deps.isCurrent()) return;
        await deps.persistRewrite(sessionId, clientId, result.text);
        if (deps.isCurrent && !deps.isCurrent()) return;
        deps.broadcastRewritten({
          sessionId,
          clientId,
          ghostId: result.ghostId,
          ghostName: result.ghostName,
          text: result.text,
        });
      } else if (result.action === 'render') {
        if (deps.isCurrent && !deps.isCurrent()) return;
        await deps.applyRenderCard(sessionId, clientId, {
          ghostId: result.ghostId,
          ghostName: result.ghostName,
          html: result.html,
          height: result.height,
        });
      }
      // allow / 未知:不动那条消息。
    } finally {
      // Do not emit an old owner's completion frame into the new owner's UI.
      const ownerStillCurrent = deps.isCurrent?.() ?? true;
      if (ownerStillCurrent) {
        deps.setPending(sessionId, clientId, false);
      }
    }
  } catch (err) {
    deps.log?.warn('assistant reply hook failed (fail-open)', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
