import { isDeepStrictEqual } from 'node:util';

import type { LiziMcpSessionContext } from '@cindy/mcps';

export interface CodexMcpThreadContextStore {
  registerThreadContext(threadId: string, ctx: LiziMcpSessionContext): void;
  unregisterThreadContext(threadId: string, expectedSessionInstanceId?: string): void;
  getContextForThreadId(threadId: string | undefined): LiziMcpSessionContext | undefined;
  getContextForSessionInstanceId(
    sessionInstanceId: string | undefined,
  ): LiziMcpSessionContext | undefined;
  registeredThreadCount(): number;
}

/**
 * Two aliases may share one request context only when every field that can
 * affect routing or tool policy is equivalent. Object identity is deliberately
 * ignored because registration clones contexts for descendant thread aliases.
 */
export function isSameCodexMcpSessionContext(
  left: LiziMcpSessionContext,
  right: LiziMcpSessionContext,
): boolean {
  return (
    left.sessionInstanceId === right.sessionInstanceId &&
    left.sessionId === right.sessionId &&
    left.agentKind === right.agentKind &&
    left.workingDir === right.workingDir &&
    left.remoteHostId === right.remoteHostId &&
    isDeepStrictEqual(left.vendorOptions, right.vendorOptions)
  );
}

export function createCodexMcpThreadContextStore(): CodexMcpThreadContextStore {
  const contextsByThread = new Map<string, LiziMcpSessionContext>();

  return {
    registerThreadContext(threadId, ctx) {
      contextsByThread.set(threadId, ctx);
    },

    unregisterThreadContext(threadId, expectedSessionInstanceId) {
      if (
        expectedSessionInstanceId !== undefined &&
        contextsByThread.get(threadId)?.sessionInstanceId !== expectedSessionInstanceId
      ) {
        return;
      }
      contextsByThread.delete(threadId);
    },

    getContextForThreadId(threadId) {
      if (!threadId) return undefined;
      return contextsByThread.get(threadId);
    },

    getContextForSessionInstanceId(sessionInstanceId) {
      if (!sessionInstanceId) return undefined;
      let match: LiziMcpSessionContext | undefined;
      for (const context of contextsByThread.values()) {
        if (context.sessionInstanceId !== sessionInstanceId) continue;
        // 同一个 session instance 可能暂时挂在多个 thread alias 上；注册流程
        // 会为每个 alias 展开出新的对象，因此不能用引用相等判断是否同一实例。
        // 完整执行上下文一致时复用第一个 context；其余冲突继续 fail closed，
        // 避免把不同会话实例或 tool policy 串到同一个 opaque route 上。
        if (match && !isSameCodexMcpSessionContext(match, context)) return undefined;
        match ??= context;
      }
      return match;
    },

    registeredThreadCount() {
      return contextsByThread.size;
    },
  };
}
