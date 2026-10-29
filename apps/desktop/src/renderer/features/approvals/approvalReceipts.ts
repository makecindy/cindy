/**
 * Receipts for requests that are no longer waiting. makerChatStore clears a card for an accepted
 * decision, a rejected ("request ended") one and a host dismissal alike, and does not say which, so
 * the renderer cannot know whether a decision was confirmed. The inbox therefore only ever says that
 * a request is "no longer waiting". If the lead approves a tiny read-only store event later, an
 * implementation of this interface can return a confirmed outcome without touching the UI shell.
 */
export type ApprovalOutcome = 'unknown';

export interface ApprovalReceiptSource {
  outcomeFor(sessionId: string, requestId: string): ApprovalOutcome;
}

export const neutralReceiptSource: ApprovalReceiptSource = {
  outcomeFor: () => 'unknown',
};

export const OUTCOME_TEXT_KEYS: Record<ApprovalOutcome, string> = {
  unknown: 'approvalsInbox.ended',
};
