import type { MakerSessionCreateOpts } from '../maker-ipc/sessionRequest.js';

/** Apply the non-negotiable runtime policy for a fresh or rehydrated Review task. */
export function enforceReviewCreateOptions(options: MakerSessionCreateOpts): void {
  options.reviewMode = true;
  options.makerMemoryEnabled = false;
  options.userPrompt = undefined;
  // A retained Review task is only an audit record. Reopening it must not
  // resume the native Codex/Claude/Pi thread and recover prior model context.
  options.resumeSessionId = undefined;
  options.permissionMode = 'ask';
  options.planMode = false;
  options.orcaRole = null;
}
