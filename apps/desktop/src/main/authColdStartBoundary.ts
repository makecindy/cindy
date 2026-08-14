import type { ActiveAppSession } from './appSessionState.js';

/**
 * Decide whether cold-start auth may need to tear down an existing owner runtime.
 *
 * `appSessionState` is process-local. A new process intentionally initializes a
 * persisted `cloud` intent as `signed-out` with generation 0, before the
 * refresh token proves the membership. There is no previous owner runtime in
 * that process to tear down; the account-switch teardown hook is for a runtime
 * that this process has already committed and may still own.
 */
export function shouldTeardownColdStartRuntime(
  previousAppSession: Pick<ActiveAppSession, 'mode' | 'dataOwnerId' | 'generation'>,
  nextOwnerId: string,
): boolean {
  if (previousAppSession.generation === 0) return false;
  return (
    previousAppSession.mode !== 'cloud' || previousAppSession.dataOwnerId !== nextOwnerId
  );
}
