/** Host-owned receipt. Never accepted from renderer/device-link input. */
export interface BotTaskCoordination {
  delegationId: string;
  runSequence: number;
  senderSessionId: string;
}

export type SessionMessagePurpose = 'coordination' | 'user-visible';

/** Per-input model instruction; never included in visible queue/history text. */
export function coordinationModelPrefix(receipt: BotTaskCoordination): string {
  return `[Internal task coordination from session ${receipt.senderSessionId}; delegation ${receipt.delegationId}; run ${receipt.runSequence}]\n`
    + 'Process this coordination and use tools as needed. Prose in this turn is internal. '
    + 'Use question/permission tools for necessary user decisions. For a user-facing result or a failure requiring user intervention, '
    + 'use send_to_session with message_purpose="user-visible". Normal task completion is delivered separately.\n\n';
}
