/**
 * pendingFirstMessage —— 跨路由把"NewMaker 草稿首条消息"递交给真实 SessionView。
 *
 * 流程:
 *   NewMakerDraftRoute.handleSend
 *     → createSession() 拿到 newId
 *     → setPending(newId, { text, files })
 *     → navigate('/cc-agent/' + newId)
 *   CCAgentSessionView mount
 *     → consumePending(newId) → sendMessage(text, files)
 *
 * 仅内存(模块级 Map):app 重启意味着发送链路被打断,丢弃不持久化。
 * 一次性消费(consume 即删):防止重复发送。
 */

import type { AttachedFile, MentionedResource } from '@/lib/fileTypes';
import type { PastedTextRange, SlashCommandRange } from '@/lib/imageRef';
import type { AgentInputReference } from '@cindy/maker-shared/agent-input-projection';

export interface PendingPayload {
  text: string;
  files?: AttachedFile[];
  mentions?: MentionedResource[];
  vendorOptions?: Record<string, unknown>;
  quotesEncoded?: boolean;
  agentReferences?: AgentInputReference[];
  pastedTextRanges?: PastedTextRange[];
  slashCommandRanges?: SlashCommandRange[];
  /** 调试用——createPending 时刻,过期清理时可参考(目前未做 GC,实际场景 navigate 立即消费)。 */
  createdAt: number;
}

const map = new Map<string, PendingPayload>();

/** 超过此时间未被 consumePending 消费的 payload 自动清理，防止导航失败时大体积附件泄漏。 */
const PENDING_TTL_MS = 60_000;

export function setPending(sessionId: string, payload: Omit<PendingPayload, 'createdAt'>): void {
  map.set(sessionId, { ...payload, createdAt: Date.now() });
  setTimeout(() => {
    if (map.has(sessionId)) {
      map.delete(sessionId);
    }
  }, PENDING_TTL_MS);
}

export function consumePending(sessionId: string): PendingPayload | null {
  const v = map.get(sessionId);
  if (!v) return null;
  map.delete(sessionId);
  return v;
}

export function hasPending(sessionId: string): boolean {
  return map.has(sessionId);
}

// ─── pendingGoal —— 跨路由把「远程草稿的新建目标」递交给真实 SessionView ────────
// device-link 远程草稿的 New Goal 流程不能在 /cc-agent/new 就发 maker:goal:set:
// 重 topic `session:<id>` 订阅要等 CCAgentSessionView mount 才建立,goal 首轮的
// maker:event/status 推送会掉在订阅建立前的窗口里(Codex review #548)。
// 与首条消息同款交接:先建会话 → setPendingGoal → navigate → SessionView 消费
// (此时订阅已随 mount 建立)→ goalApiFor(sessionId).setGoal。
// 本机草稿不走这里(本机推送不经订阅,原地 setGoal 即可)。

export interface PendingGoalPayload {
  objective: string;
  limits: { maxTurns: number | null; budgetTokens: number | null; noProgressLimit: number | null };
  createdAt: number;
}

const goalMap = new Map<string, PendingGoalPayload>();

export function setPendingGoal(
  sessionId: string,
  payload: Omit<PendingGoalPayload, 'createdAt'>,
): void {
  goalMap.set(sessionId, { ...payload, createdAt: Date.now() });
  setTimeout(() => {
    goalMap.delete(sessionId);
  }, PENDING_TTL_MS);
}

export function consumePendingGoal(sessionId: string): PendingGoalPayload | null {
  const v = goalMap.get(sessionId);
  if (!v) return null;
  goalMap.delete(sessionId);
  return v;
}

/** 测试用。 */
export function __clearAllForTest(): void {
  map.clear();
  goalMap.clear();
}
