/** Renderer-only capture lease; never serialized into messages or remote outboxes. */
export interface HudScreenSubmission {
  assertCurrent(): void;
  accept(): void;
}
export class HudScreenRevokedError extends Error {
  constructor() {
    super('capture revoked');
    this.name = 'HudScreenRevokedError';
  }
}
/** Recheck after preflight awaits, but stop revoking once the queue accepts ownership. */
export function hudScreenPreflight(
  submission?: HudScreenSubmission,
  beforeEnqueue?: () => Promise<boolean>,
): (() => Promise<boolean>) | undefined {
  if (!submission) return beforeEnqueue;
  return async () => {
    submission.assertCurrent();
    if (beforeEnqueue && !(await beforeEnqueue())) return false;
    submission.assertCurrent();
    return true;
  };
}
export async function dispatchHudScreenSubmission(
  submission: HudScreenSubmission | undefined,
  dispatch: () => Promise<boolean>,
): Promise<boolean> {
  submission?.assertCurrent();
  const accepted = await dispatch();
  if (accepted) submission?.accept();
  else submission?.assertCurrent(); // Surface revocation instead of restoring stale pixels.
  return accepted;
}
