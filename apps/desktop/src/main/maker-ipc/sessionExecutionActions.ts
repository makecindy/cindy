import type { InteractionDecision } from '@cindy/maker-core';

/** Agent and plugin calls share the input owner and native compact transaction. */
export async function runSessionExecutionAction(params: {
  targetSessionId: string;
  action: 'pause' | 'resume' | 'retry' | 'compact';
  instructions?: string;
  beforeMutation: () => Promise<void>;
  beforeDelivery?: () => Promise<void>;
}, deps: {
  coordinator: {
    ensureQueueRestored(id: string): Promise<void>;
    setExecutionPaused(id: string, paused: boolean): void;
    isExecutionPaused(id: string): boolean;
    isQueuePaused(id: string): boolean;
    resume(id: string): unknown;
    retryLastError(id: string, expectedQueueHeadClientId?: string, expectedSwitchRevision?: number,
      guards?: { beforeMutation: () => Promise<void>; beforeDelivery: () => Promise<void> }): Promise<unknown>;
  };
  persist(id: string): Promise<void>;
  compact(id: string, instructions: string | undefined, beforeMutation: () => Promise<void>, beforeDelivery: () => Promise<void>): Promise<unknown>;
  interactions?: {
    pending: ReadonlyMap<string, { sessionId: string; deferredDecision?: InteractionDecision;
      timeoutId?: ReturnType<typeof setTimeout>; timeoutDeadlineAt?: number; timeoutRemainingMs?: number }>;
    resolve(requestId: string, decision: InteractionDecision): void;
    resumeTimeout(requestId: string): void;
  };
}) {
  const { targetSessionId: id, action, beforeMutation } = params;
  const { coordinator } = deps;
  await coordinator.ensureQueueRestored(id);
  await beforeMutation();
  const beforeDelivery = params.beforeDelivery ?? beforeMutation;
  if (action === 'compact') {
    const native = await deps.compact(id, params.instructions, beforeMutation, beforeDelivery) as {
      error?: unknown; tokensBefore?: unknown; estimatedTokensAfter?: unknown; noop?: unknown } | null;
    if (typeof native?.error === 'string' && native.error) {
      return { ok: false as const, errorCode: 'COMPACT_FAILED', message: native.error };
    }
    return { ok: true as const, result: { status: 'requested' as const,
      ...(typeof native?.tokensBefore === 'number' ? { tokensBefore: native.tokensBefore } : {}),
      ...(typeof native?.estimatedTokensAfter === 'number' ? { estimatedTokensAfter: native.estimatedTokensAfter } : {}),
      ...(typeof native?.noop === 'boolean' ? { noop: native.noop } : {}) } };
  }
  if (action === 'pause' || action === 'resume') {
    const paused = action === 'pause';
    coordinator.setExecutionPaused(id, paused);
    for (const [requestId, entry] of deps.interactions?.pending ?? []) {
      if (entry.sessionId !== id) continue;
      if (paused) {
        if (entry.timeoutId !== undefined) clearTimeout(entry.timeoutId);
        entry.timeoutId = undefined;
        if (entry.timeoutDeadlineAt !== undefined) entry.timeoutRemainingMs = Math.max(0, entry.timeoutDeadlineAt - Date.now());
        entry.timeoutDeadlineAt = undefined;
      } else if (entry.deferredDecision) {
        const decision = entry.deferredDecision;
        entry.deferredDecision = undefined;
        deps.interactions!.resolve(requestId, decision);
      } else deps.interactions!.resumeTimeout(requestId);
    }
    if (!paused) coordinator.resume(id);
  } else await coordinator.retryLastError(id, undefined, undefined, { beforeMutation, beforeDelivery });
  await deps.persist(id);
  await beforeMutation();
  return { ok: true as const, result: { executionPaused: coordinator.isExecutionPaused(id), queuePaused: coordinator.isQueuePaused(id) } };
}
