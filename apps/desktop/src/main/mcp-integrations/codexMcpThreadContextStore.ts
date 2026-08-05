import type { LiziMcpSessionContext } from '@cindy/mcps';

export interface CodexMcpThreadContextStore {
  registerThreadContext(threadId: string, ctx: LiziMcpSessionContext): void;
  unregisterThreadContext(threadId: string): void;
  getContextForThreadId(threadId: string | undefined): LiziMcpSessionContext | undefined;
  registeredThreadCount(): number;
}

export function createCodexMcpThreadContextStore(): CodexMcpThreadContextStore {
  const contextsByThread = new Map<string, LiziMcpSessionContext>();

  return {
    registerThreadContext(threadId, ctx) {
      contextsByThread.set(threadId, ctx);
    },

    unregisterThreadContext(threadId) {
      contextsByThread.delete(threadId);
    },

    getContextForThreadId(threadId) {
      if (!threadId) return undefined;
      return contextsByThread.get(threadId);
    },

    registeredThreadCount() {
      return contextsByThread.size;
    },
  };
}
