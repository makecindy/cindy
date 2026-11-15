/**
 * Marks one agent turn whose only requester is a timer.
 *
 * A scheduled fire has nobody in the loop, and the interaction layer is
 * deliberately unbounded for human decisions: ask_user_question / plan_review
 * cards get no timeout (see PERMISSION_INTERACTION_TIMEOUT_MS) and the session
 * turn watchdog suspends while `pendingInteractions > 0`. A question asked from
 * a scheduled turn therefore waits forever, and the only backstop left is the
 * 60min run-level stall guard, which kills the run and leaves the turn with no
 * final answer at all.
 *
 * Turn-scoped and ref-counted for the same reason as
 * beginHeadlessGhostSetupTurn: scheduler runs reuse live Desktop and teammate
 * sessions, and later user-driven turns must go back to interactive.
 */
const unattendedDepthBySession = new Map<string, number>();

/**
 * Plan reviews this turn had to decline because no one could approve them.
 * Denying is right (plan mode means "act only after I approve"), but a run that
 * silently produces a plan and executes nothing looks broken — the runner reads
 * this once per run and says so in the run result.
 */
const declinedPlanReviewBySession = new Map<string, number>();

export function beginUnattendedTurn(sessionId: string): () => void {
  const depth = (unattendedDepthBySession.get(sessionId) ?? 0) + 1;
  unattendedDepthBySession.set(sessionId, depth);
  // A turn starts with a clean record: an earlier fire that ended without
  // finalizing must not leak its note into this run.
  if (depth === 1) declinedPlanReviewBySession.delete(sessionId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (unattendedDepthBySession.get(sessionId) ?? 1) - 1;
    if (next > 0) unattendedDepthBySession.set(sessionId, next);
    else unattendedDepthBySession.delete(sessionId);
  };
}

export function isUnattendedTurn(sessionId: string): boolean {
  return (unattendedDepthBySession.get(sessionId) ?? 0) > 0;
}

export function noteUnattendedPlanReviewDeclined(sessionId: string): void {
  declinedPlanReviewBySession.set(
    sessionId,
    (declinedPlanReviewBySession.get(sessionId) ?? 0) + 1,
  );
}

/** Read-and-clear: the run reports the declines once, then the record is gone. */
export function takeUnattendedPlanReviewDeclines(sessionId: string): number {
  const count = declinedPlanReviewBySession.get(sessionId) ?? 0;
  declinedPlanReviewBySession.delete(sessionId);
  return count;
}
