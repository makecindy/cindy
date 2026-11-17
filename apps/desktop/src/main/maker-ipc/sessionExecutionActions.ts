/** Agent and plugin calls share the input owner and native compact transaction. */
export async function runSessionExecutionAction(params: {
  targetSessionId: string;
  action: 'pause' | 'resume' | 'retry' | 'compact';
  instructions?: string;
  beforeMutation: () => Promise<void>;
}, deps: {
  coordinator: {
    ensureQueueRestored(id: string): Promise<void>;
    isPausedForUncertainDelivery(id: string): boolean;
    setExecutionPaused(id: string, paused: boolean): void;
    isExecutionPaused(id: string): boolean;
    isQueuePaused(id: string): boolean;
    resume(id: string): unknown;
    retryLastError(id: string): Promise<unknown>;
  };
  persist(id: string): Promise<void>;
  compact(id: string, instructions: string | undefined, beforeMutation: () => Promise<void>): Promise<unknown>;
}) {
  const { targetSessionId: id, action, beforeMutation } = params;
  const { coordinator } = deps;
  await coordinator.ensureQueueRestored(id);
  await beforeMutation();
  if ((action === 'resume' || action === 'retry') && coordinator.isPausedForUncertainDelivery(id)) {
    return { ok: false as const, errorCode: 'CONFLICT', message: 'A queued message may already have been delivered. Resolve it in the task before resuming or retrying.' };
  }
  if (action === 'compact') return { ok: true as const, result: await deps.compact(id, params.instructions, beforeMutation) };
  if (action === 'pause') coordinator.setExecutionPaused(id, true);
  else if (action === 'resume') {
    coordinator.setExecutionPaused(id, false);
    coordinator.resume(id);
  } else await coordinator.retryLastError(id);
  await deps.persist(id);
  await beforeMutation();
  return { ok: true as const, result: { executionPaused: coordinator.isExecutionPaused(id), queuePaused: coordinator.isQueuePaused(id) } };
}
