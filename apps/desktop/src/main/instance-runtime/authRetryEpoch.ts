/**
 * The auth state a transient retry of a managed instance's sign-in belongs to. Committing the
 * rotated tokens moves the auth state on as it starts, so a commit that then fails still belongs to
 * this attempt; anything else that moved it in between means the retry is no longer this attempt's.
 */
export function managedAuthRetryEpoch(started: number, beforeCommit: number | null, now: number): number {
  return beforeCommit === started && now === beforeCommit + 1 ? now : started;
}
