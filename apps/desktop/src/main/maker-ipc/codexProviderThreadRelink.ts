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

export interface CodexProviderThreadRelinkReceipt {
  previousSdkSessionId: string;
  newSdkSessionId: string;
  /** Restore the source thread only while this relink still owns sdk_session_id. */
  rollback(): Promise<boolean>;
}

export interface PersistedCodexRuntimeSelectionState {
  sdkSessionId: string | null;
  model: string;
  providerId: string | null;
  effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  fastMode: boolean;
}

/**
 * Turn a route write plus an optional Codex relink into one compensation record.
 * The injected restore must compare the complete applied tuple and replace it with
 * the complete previous tuple atomically against the captured profile database.
 */
export async function rollbackPersistedCodexRuntimeSelection(input: {
  previous: PersistedCodexRuntimeSelectionState;
  appliedRoute: Omit<PersistedCodexRuntimeSelectionState, 'sdkSessionId'>;
  relinkReceipt?: Pick<
    CodexProviderThreadRelinkReceipt,
    'previousSdkSessionId' | 'newSdkSessionId'
  >;
  restore: (states: {
    expected: PersistedCodexRuntimeSelectionState;
    previous: PersistedCodexRuntimeSelectionState;
  }) => Promise<boolean>;
}): Promise<boolean> {
  return input.restore({
    expected: {
      sdkSessionId: input.relinkReceipt?.newSdkSessionId ?? input.previous.sdkSessionId,
      ...input.appliedRoute,
    },
    previous: {
      ...input.previous,
      sdkSessionId:
        input.relinkReceipt?.previousSdkSessionId ?? input.previous.sdkSessionId,
    },
  });
}

/**
 * Commit a relink only while its owner/generation boundary remains current.
 * The write itself may yield, so a boundary change after the preflight check
 * must be compensated against the same captured database before returning.
 */
export async function commitCodexProviderThreadRelinkWithBoundaryGuard(input: {
  isBoundaryCurrent: () => boolean;
  commit: () => Promise<boolean>;
  rollback: () => Promise<boolean>;
}): Promise<boolean> {
  if (!input.isBoundaryCurrent()) return false;
  const committed = await input.commit();
  if (!committed) return false;
  if (input.isBoundaryCurrent()) return true;
  await input.rollback();
  return false;
}

function resolveForkSourceProviderId(
  sourceProviderId: string | null,
  sourceThreadModelProviderId: string | null | undefined,
): string | null {
  // thread/start|resume is the fact source when a control plane already overwrote the
  // route store. Feed forkSdkSession a public provider id that resolves to the same
  // credential family as the source thread, never the target selection.
  if (sourceThreadModelProviderId === 'cindy_openai') return 'openai';
  if (sourceThreadModelProviderId === 'cindy_gateway' && sourceProviderId === 'openai') {
    return 'xd';
  }
  return sourceProviderId;
}

export interface CodexProviderThreadRelinkDeps {
  readSource(sessionId: string): Promise<CodexProviderThreadRelinkSource | null>;
  fork(input: {
    sourceSdkSessionId: string;
    sourceModel: string;
    sourceProviderId: string | null;
    workingDir?: string;
  }): Promise<{ newSdkSessionId: string }>;
  commit(input: {
    sessionId: string;
    expectedSdkSessionId: string;
    newSdkSessionId: string;
    isCurrent?: () => boolean;
  }): Promise<boolean>;
  onCommitted?(input: {
    sessionId: string;
    previousSdkSessionId: string;
    newSdkSessionId: string;
  }): void;
}

export async function relinkCodexProviderThread(
  deps: CodexProviderThreadRelinkDeps,
  input: {
    sessionId: string;
    sourceModel: string;
    sourceProviderId: string | null;
    sourceThreadModelProviderId?: string | null;
    isCurrent?: () => boolean;
  },
): Promise<{ previousSdkSessionId: string; newSdkSessionId: string } | null> {
  const source = await deps.readSource(input.sessionId);
  if (!source?.sdkSessionId) return null;

  const forked = await deps.fork({
    sourceSdkSessionId: source.sdkSessionId,
    sourceModel: input.sourceModel,
    sourceProviderId: resolveForkSourceProviderId(
      input.sourceProviderId,
      input.sourceThreadModelProviderId,
    ),
    ...(source.workingDir ? { workingDir: source.workingDir } : {}),
  });
  const committed = await deps.commit({
    sessionId: input.sessionId,
    expectedSdkSessionId: source.sdkSessionId,
    newSdkSessionId: forked.newSdkSessionId,
    ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
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
