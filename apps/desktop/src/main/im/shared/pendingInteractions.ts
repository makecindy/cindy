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

import type { InteractionDecision } from '@cindy/maker-core';

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
}

const pending = new Map<string, PendingEntry>();

export function registerPending(
  requestId: string,
  kind: InteractionDecision['kind'],
  messageId: string,
  extras?: { toolName?: string },
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
  extras?: { toolName?: string },
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
  });
}

export function lookupPending(requestId: string): PendingEntry | null {
  return pending.get(requestId) ?? null;
}

export function resolvePending(
  requestId: string,
  decision: InteractionDecision,
): { messageId: string } | null {
  const entry = pending.get(requestId);
  if (!entry) return null;
  pending.delete(requestId);
  entry.resolve(decision);
  return { messageId: entry.messageId };
}

/** Resolve one pending card with the safe decision used when its turn ends. */
export function cancelPending(requestId: string, reason: string): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  pending.delete(requestId);
  if (entry.kind === 'ask_user_question') {
    entry.resolve({ kind: 'ask_user_question', answers: {} });
    return true;
  }
  if (entry.kind === 'plan_review') {
    entry.resolve({ kind: 'plan_review', behavior: 'deny', reason, dismissed: true });
    return true;
  }
  entry.resolve({ kind: 'permission', behavior: 'deny', reason });
  return true;
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
