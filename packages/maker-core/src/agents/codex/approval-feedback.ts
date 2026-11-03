import { Method } from './app-server/protocol.js';

/** Native approval replies only accept a decision enum. Steer feedback into the
 * exact waiting turn before releasing that decision; never start/replay a turn.
 * Call the transport directly so machine feedback cannot update user authority.
 */
export async function sendCodexApprovalFeedback(
  request: (method: string, params: Record<string, unknown>, options: { timeoutMs: number }) => Promise<unknown>,
  feedback: { threadId: string; turnId: string; itemId: string; reason: string },
): Promise<void> {
  await request(Method.TurnSteer, {
    threadId: feedback.threadId,
    expectedTurnId: feedback.turnId,
    input: [{
      type: 'text',
      text: 'Cindy permission result (host-generated feedback, not a user message or additional authorization):\n'
        + JSON.stringify({ itemId: feedback.itemId, result: feedback.reason })
        + '\nThis approval request was denied. Use this reason rather than attributing a generic upstream rejection to the user.',
      text_elements: [],
    }],
  }, { timeoutMs: 5_000 });
}
