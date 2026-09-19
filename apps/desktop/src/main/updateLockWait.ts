/**
 * Windows startup must not enter the install directory while cindy-updater
 * still owns `.updating`. Retry reopens that handle with FILE_SHARE_READ, so
 * unlinkSync fails with a sharing violation; a fixed 30s timeout is not enough
 * for a large ZIP. Unrelated ACL / deny-delete errors are not proof of Retry
 * and must not block the pre-window startup loop forever.
 */

export type WindowsUpdateLockWaitInput = {
  lockExists: boolean;
  elapsedMs: number;
  maxWaitMs: number;
  holderPid: number | null;
  holderAlive: boolean;
  unlinkFailed: boolean;
  sharingViolation: boolean;
};

export function isWindowsUpdateLockSharingViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = 'code' in error ? error.code : undefined;
  const errno = 'errno' in error ? error.errno : undefined;
  return code === 'EBUSY' || errno === -4082 || errno === 32;
}

export function shouldKeepWaitingForWindowsUpdateLock(
  input: WindowsUpdateLockWaitInput,
): boolean {
  if (!input.lockExists) {
    return false;
  }
  if (input.unlinkFailed && input.sharingViolation && input.holderAlive) {
    return true;
  }
  if (input.holderAlive && input.elapsedMs < input.maxWaitMs) {
    return true;
  }
  return input.elapsedMs < input.maxWaitMs;
}
