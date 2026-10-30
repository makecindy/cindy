import { UI_ACTION_TRIGGER_PREFIX } from '../../shared/interruptedTurn.js';
import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import type { AgentInputCoordinator } from './agent-input-coordinator.js';

/** The hidden greeting request the invitation queues: text-only, marked as a host UI trigger. */
function isQueuedInvitationWelcome(item: Pick<AgentInputQueuedMessage, 'text' | 'toolsDisabled'>): boolean {
  return item.toolsDisabled === true && item.text.startsWith(UI_ACTION_TRIGGER_PREFIX);
}

/**
 * Drop the greeting request an unfinished meeting left in a task's queue (also one restored from
 * the crash snapshot, which would otherwise be released by the owner's next input). Everything
 * else queued there stays. Best effort: null when the queue cannot be read (nothing is removed).
 */
export async function discardQueuedInvitationWelcomes(
  queue: Pick<AgentInputCoordinator, 'ensureQueueRestored' | 'isQueueRestored' | 'getQueueControlSnapshot' | 'remove'>,
  sessionId: string,
): Promise<number | null> {
  await queue.ensureQueueRestored(sessionId).catch(() => undefined);
  if (!queue.isQueueRestored(sessionId)) return null;
  const welcomes = queue.getQueueControlSnapshot(sessionId).pendingQueue.filter(isQueuedInvitationWelcome);
  for (const item of welcomes) queue.remove(sessionId, item.clientId);
  return welcomes.length;
}
