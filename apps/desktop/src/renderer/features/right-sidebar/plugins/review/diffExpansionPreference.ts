/** Codex-style route memory: closing a Review tab must not reset its task-level default. */
const MAX_RETAINED_REVIEW_TASKS = 20;

const diffsExpandedBySession = new Map<string, boolean>();

export function getReviewDiffsExpanded(sessionId: string, fallback: boolean): boolean {
  return diffsExpandedBySession.get(sessionId) ?? fallback;
}

export function seedReviewDiffsExpanded(sessionId: string, expanded: boolean): void {
  if (!sessionId || diffsExpandedBySession.has(sessionId)) return;
  setReviewDiffsExpanded(sessionId, expanded);
}

export function setReviewDiffsExpanded(sessionId: string, expanded: boolean): void {
  if (!sessionId) return;
  diffsExpandedBySession.delete(sessionId);
  diffsExpandedBySession.set(sessionId, expanded);
  while (diffsExpandedBySession.size > MAX_RETAINED_REVIEW_TASKS) {
    const oldestSessionId = diffsExpandedBySession.keys().next().value;
    if (oldestSessionId === undefined) break;
    diffsExpandedBySession.delete(oldestSessionId);
  }
}

export function resetReviewDiffExpansionPreferencesForTests(): void {
  diffsExpandedBySession.clear();
}
