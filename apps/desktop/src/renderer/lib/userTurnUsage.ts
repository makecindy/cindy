import type { ChatMessage } from './makerChatStore';
import { aggregateTurnUsageDetails, type TurnUsageDetails } from '../../shared/turnUsageDetails';

function isUserTurnBoundary(message: ChatMessage): boolean {
  return (
    message.role === 'user' &&
    message.delivery !== 'steer' &&
    message.systemCardType !== 'auto-resume'
  );
}

/**
 * Return the token/model details for the visible user turn containing an
 * assistant message. If the loaded history starts in the middle of a turn,
 * keep the target segment only instead of accidentally merging an older turn.
 */
export function aggregateAssistantTurnUsageDetails(
  messages: readonly ChatMessage[],
  assistantClientId: string,
): TurnUsageDetails | null {
  const targetIndex = messages.findIndex((message) => message.clientId === assistantClientId);
  if (targetIndex < 0 || messages[targetIndex].role !== 'assistant') return null;

  const segments: TurnUsageDetails[] = [];
  let foundBoundary = false;
  for (let index = targetIndex; index >= 0; index -= 1) {
    const message = messages[index];
    if (isUserTurnBoundary(message)) {
      foundBoundary = true;
      break;
    }
    if (message.role === 'assistant' && message.turnUsageDetails) {
      segments.push(message.turnUsageDetails);
    }
  }

  const targetDetails = messages[targetIndex].turnUsageDetails;
  if (!targetDetails) return null;
  if (!foundBoundary || segments.length <= 1) return targetDetails;
  return aggregateTurnUsageDetails(segments.reverse()) ?? targetDetails;
}

/**
 * Build user-turn usage for selected assistant messages in one linear pass.
 * MessageStream calls this while tokens stream, so repeated backward scans
 * would make long histories quadratic even though only final answers consume it.
 */
export function collectAssistantTurnUsageDetails(
  messages: readonly ChatMessage[],
  assistantClientIds: ReadonlySet<string>,
): Map<string, TurnUsageDetails> {
  const out = new Map<string, TurnUsageDetails>();
  let hasBoundary = false;
  let segments: TurnUsageDetails[] = [];

  for (const message of messages) {
    if (isUserTurnBoundary(message)) {
      hasBoundary = true;
      segments = [];
      continue;
    }
    if (message.role !== 'assistant' || !message.turnUsageDetails) continue;
    segments.push(message.turnUsageDetails);
    if (!assistantClientIds.has(message.clientId)) continue;

    const details =
      hasBoundary && segments.length > 1
        ? aggregateTurnUsageDetails(segments)
        : message.turnUsageDetails;
    out.set(message.clientId, details ?? message.turnUsageDetails);
  }

  return out;
}
