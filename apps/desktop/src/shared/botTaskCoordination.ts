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
    + 'This incoming report is internal context, not a new request from the owner. Process it and use tools as needed. '
    + 'Your replies appear in the owner conversation: directly explain meaningful progress, results or blockers; '
    + 'if there is nothing useful to report, you may stay silent. Use question/permission tools for necessary user decisions. '
    + 'Ending your reply ends only this turn; delegated work may continue. State what remains in progress and report completion only when verified. '
    + 'Normal task completion is delivered separately.\n\n';
}
