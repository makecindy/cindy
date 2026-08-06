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
        // 同一个 context 可能暂时挂在多个 thread alias 上；不同 context 却
        // 声称同一 instance 时无法安全判断，按歧义 fail closed。
        if (match && match !== context) return undefined;
        match = context;
      }
      return match;
    },

    registeredThreadCount() {
      return contextsByThread.size;
    },
  };
}
