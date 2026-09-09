/**
 * main/im/shared/pendingInteractions.ts
 * ---------------------------------------------------------------------------
 * Promise-correlation table for outstanding interactive cards. The agent's
 * InteractionResolver returns a Promise; we register that promise's resolve fn
 * here keyed by `requestId`, then `cardActionHandler` looks up by requestId
 * (carried in the card button's payload) and resolves it.
 *
 * One pending interaction per requestId. Agent may have many in flight (per
 * tool call), but each is uniquely keyed.
 */

import type { AskUserQuestionItem, InteractionDecision } from '@cindy/maker-core';

import {
  buildAskNoAnswerDecision,
  buildPermissionDenyDecision,
  buildPlanDenyDecision,
} from './interactionCardModel';

interface PendingEntry {
  resolve: (decision: InteractionDecision) => void;
  reject: (err: Error) => void;
  /** Card messageId we sent — orchestrator can patch it after resolve. */
  messageId: string;
  /** For sanity / log: which kind we're awaiting. */
  kind: InteractionDecision['kind'];
  /**
   * Original toolName from the InteractionRequest (only set when kind ===
   * 'permission'). Needed to construct `permissionUpdates` for "always
   * allow this tool" semantics — cardActionHandler doesn't have access to
   * the request, so we stash it here at register time.
   */
  toolName?: string;
  /**
   * 授权卡原始正文(title + body, 仅 kind === 'permission')。点击后收口时
   * 保留它再追加决策结果 — 用户需要看到自己批准的是什么, 不能整卡换成
   * 一句「✅ 已允许」。
   */
  permissionCard?: { title: string; body: string };
  /**
   * 多题/多选打勾卡的原始问题(仅 kind === 'ask_user_question' 且
   * needsAskMultiCard 时登记)。ask:multi 按键要按问题下标改写勾选态并
   * 重建卡片, cardActionHandler 拿不到原始请求, 与 toolName 同理登记在此。
   */
  askQuestions?: AskUserQuestionItem[];
  /**
   * 打勾卡的勾选态: 问题下标 -> 已选选项下标集合。注册时置空 Map,
   * cardActionHandler 在每次 ask:multi 按键时原地改动; 随 entry 一同
   * 删除(resolve / cancel)即自动回收, 无需单独清理。
   */
  askSelections?: Map<number, Set<number>>;
}

const pending = new Map<string, PendingEntry>();

export function registerPending(
  requestId: string,
  kind: InteractionDecision['kind'],
  messageId: string,
  extras?: {
    toolName?: string;
    permissionCard?: { title: string; body: string };
    askQuestions?: AskUserQuestionItem[];
    askSelections?: Map<number, Set<number>>;
  },
): Promise<InteractionDecision> {
  return new Promise<InteractionDecision>((resolve, reject) => {
    try {
      registerPendingExternal(requestId, kind, messageId, resolve, reject, extras);
    } catch (err) {
      reject(err as Error);
    }
  });
}

/**
 * 低级注册 — 用 caller 提供的 resolve/reject 直接 set entry, 不创建新 Promise。
 *
 * 用途: feishu 接管时把 desktop 那边已经在等的 InteractionRequest 迁移过来 ——
 * desktop pending 里的 resolve fn 就是 SDK listener 在 await 的那个, 我们要让
 * 飞书 cardActionHandler 触发回调时直接 resolve 它(而不是 resolve 一个新 Promise
 * 然后再桥接), 否则就要在两套 pending 之间维护一对 forwarder, 容易漏。
 */
export function registerPendingExternal(
  requestId: string,
  kind: InteractionDecision['kind'],
  messageId: string,
  resolve: (decision: InteractionDecision) => void,
  reject: (err: Error) => void,
  extras?: {
    toolName?: string;
    permissionCard?: { title: string; body: string };
    askQuestions?: AskUserQuestionItem[];
    askSelections?: Map<number, Set<number>>;
  },
): void {
  if (pending.has(requestId)) {
    throw new Error(`pending interaction already exists for requestId=${requestId}`);
  }
  pending.set(requestId, {
    resolve,
    reject,
    messageId,
    kind,
    toolName: extras?.toolName,
    permissionCard: extras?.permissionCard,
    askQuestions: extras?.askQuestions,
    askSelections: extras?.askSelections,
  });
}

export function lookupPending(requestId: string): PendingEntry | null {
  return pending.get(requestId) ?? null;
}

export function resolvePending(
  requestId: string,
  decision: InteractionDecision,
): { messageId: string; permissionCard?: { title: string; body: string } } | null {
  const entry = pending.get(requestId);
  if (!entry) return null;
  pending.delete(requestId);
  entry.resolve(decision);
  return { messageId: entry.messageId, permissionCard: entry.permissionCard };
}

/**
 * Resolve one pending card with the safe decision used when its turn ends.
 * 安全默认与 hook 链路同源(interactionCardModel), 只有 reason 文案按渠道给。
 *
 * Returns the card's messageId (same shape as `resolvePending`) so the caller
 * can close the card off. Without that, the card stays on screen with live
 * buttons after the interaction is already gone — pressing it then does
 * nothing at all, which is exactly what a dropped turn looks like to the user.
 */
export function cancelPending(requestId: string, reason: string): { messageId: string } | null {
  const entry = pending.get(requestId);
  if (!entry) return null;
  pending.delete(requestId);
  if (entry.kind === 'ask_user_question') {
    entry.resolve(buildAskNoAnswerDecision());
  } else if (entry.kind === 'plan_review') {
    entry.resolve(buildPlanDenyDecision(reason));
  } else {
    entry.resolve(buildPermissionDenyDecision(reason));
  }
  return { messageId: entry.messageId };
}

/** Reject all pending interactions (used on session close / error). */
export function rejectAllPending(reason: string): void {
  for (const [, entry] of pending) {
    entry.reject(new Error(reason));
  }
  pending.clear();
}

export function getPendingCount(): number {
  return pending.size;
}
