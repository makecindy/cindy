import { isAutoRecoveringRemoteError } from '@/device-link/remoteStatus';

/** A new object for every error occurrence, even when the text repeats. */
export interface SessionOperationError {
  message: string;
}

export function shouldClearOperationErrorAfterSync(
  current: SessionOperationError | null,
  atSyncStart: SessionOperationError | null,
): boolean {
  return current !== null
    && current === atSyncStart
    && isAutoRecoveringRemoteError(current.message);
}
