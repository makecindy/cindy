/**
 * Codex 跨凭证家族切换时不能 resume 原 thread。
 *
 * 旧 rollout 先经 Codex 的安全 fork 清掉供应商私有 reasoning payload，再用 CAS
 * 把同一个 Cindy session 指向新 thread。这样既保留任务上下文，也不会把 XD 网关
 * 创建的 thread 直接交给 ChatGPT 订阅（反向同理）。
 */

export interface CodexProviderThreadRelinkSource {
  sdkSessionId: string | null;
  workingDir: string | null;
}

export interface CodexProviderThreadRelinkDeps {
  readSource(sessionId: string): Promise<CodexProviderThreadRelinkSource | null>;
  fork(input: {
    sourceSdkSessionId: string;
    model: string;
    providerId: string | null;
    workingDir?: string;
  }): Promise<{ newSdkSessionId: string }>;
  commit(input: {
    sessionId: string;
    expectedSdkSessionId: string;
    newSdkSessionId: string;
  }): Promise<boolean>;
  onCommitted?(input: {
    sessionId: string;
    previousSdkSessionId: string;
    newSdkSessionId: string;
  }): void;
}

export async function relinkCodexProviderThread(
  deps: CodexProviderThreadRelinkDeps,
  input: { sessionId: string; model: string; providerId: string | null },
): Promise<{ previousSdkSessionId: string; newSdkSessionId: string } | null> {
  const source = await deps.readSource(input.sessionId);
  if (!source?.sdkSessionId) return null;

  const forked = await deps.fork({
    sourceSdkSessionId: source.sdkSessionId,
    model: input.model,
    providerId: input.providerId,
    ...(source.workingDir ? { workingDir: source.workingDir } : {}),
  });
  const committed = await deps.commit({
    sessionId: input.sessionId,
    expectedSdkSessionId: source.sdkSessionId,
    newSdkSessionId: forked.newSdkSessionId,
  });
  if (!committed) {
    throw new Error(`Codex provider thread relink was superseded for session ${input.sessionId}`);
  }
  deps.onCommitted?.({
    sessionId: input.sessionId,
    previousSdkSessionId: source.sdkSessionId,
    newSdkSessionId: forked.newSdkSessionId,
  });
  return {
    previousSdkSessionId: source.sdkSessionId,
    newSdkSessionId: forked.newSdkSessionId,
  };
}
