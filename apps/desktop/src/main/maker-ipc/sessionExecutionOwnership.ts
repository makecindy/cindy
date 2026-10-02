/** Shared by callers of ordinary Sessions; never grants caller authorization. */
export interface SessionExecutionIdentity {
  instanceId: string;
  generation: number;
}

export function isSameSessionExecution(
  current: SessionExecutionIdentity | null | undefined,
  expected: SessionExecutionIdentity | null | undefined,
): boolean {
  return (
    !!current &&
    !!expected &&
    current.instanceId === expected.instanceId &&
    current.generation === expected.generation
  );
}

/** Recheck inside the native restart fence: the Session may change while waiting. */
export async function controlOwnedSessionExecution(params: {
  sessionId: string;
  matches: () => boolean;
  withSessionLock?: (sessionId: string, operation: () => Promise<void>) => Promise<void>;
  operation: () => Promise<void>;
}): Promise<boolean> {
  if (!params.matches()) return false;
  let applied = false;
  const guarded = async () => {
    if (!params.matches()) return;
    await params.operation();
    applied = true;
  };
  if (params.withSessionLock) await params.withSessionLock(params.sessionId, guarded);
  else await guarded();
  return applied;
}

export interface OwnedQueuedInput {
  clientId: string;
  supersedesUserClientId?: string;
  retrySourceClientId?: string;
}

/** Recovery aliases retain the original input's ownership, not a Session-wide grant. */
export function queuedInputBelongsTo(
  item: OwnedQueuedInput,
  owns: (clientId: string) => boolean,
): boolean {
  return [item.clientId, item.supersedesUserClientId, item.retrySourceClientId].some(
    (id) => typeof id === 'string' && owns(id),
  );
}

/** Ownership is supplied by a trusted adapter (Bot identity or persisted plugin input IDs). */
export async function withdrawOwnedSessionInputs(params: {
  sessionId: string;
  queue: {
    ensureQueueRestored(sessionId: string): Promise<unknown>;
    getQueueControlSnapshot(sessionId: string): { pendingQueue: readonly OwnedQueuedInput[] };
    remove(sessionId: string, clientId: string): unknown;
  };
  owns: (clientId: string) => boolean;
  flush: (sessionId: string) => Promise<void>;
}): Promise<void> {
  await params.queue.ensureQueueRestored(params.sessionId);
  for (const item of params.queue.getQueueControlSnapshot(params.sessionId).pendingQueue) {
    if (queuedInputBelongsTo(item, params.owns))
      params.queue.remove(params.sessionId, item.clientId);
  }
  await params.flush(params.sessionId);
}
