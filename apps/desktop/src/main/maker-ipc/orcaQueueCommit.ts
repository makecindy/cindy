/**
 * Shared final commit boundary for queue-backed sends.
 *
 * Preparation and queue restoration may both yield while end_team has already
 * installed the shutdown fence. Keep the fence check immediately adjacent to
 * callback registration and the synchronous enqueue so no async gap can reopen
 * the shutdown race.
 */
export type OrcaQueueCommitResult = 'enqueued' | 'fenced';

export async function commitQueuedMessageAfterOrcaFence<T>(params: {
  targetSessionId: string;
  prepare: () => Promise<T>;
  restoreQueue: () => Promise<void>;
  isFenced: (sessionId: string) => boolean;
  registerAccepted?: () => void;
  enqueue: (sessionId: string, item: T) => void;
}): Promise<OrcaQueueCommitResult> {
  const item = await params.prepare();
  await params.restoreQueue();
  if (params.isFenced(params.targetSessionId)) return 'fenced';
  params.registerAccepted?.();
  params.enqueue(params.targetSessionId, item);
  return 'enqueued';
}
