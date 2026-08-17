import { throwIpcError } from '../utils/ipcValidate.js';

export type ReviewSessionSourceReader = (
  sessionId: string,
) => string | null | Promise<string | null>;

/** Reject every user/controller input path for a host-owned isolated Review task. */
export async function assertReviewSessionExternalInputAllowed(
  sessionId: string,
  readSessionSource: ReviewSessionSourceReader,
): Promise<void> {
  if ((await readSessionSource(sessionId)) !== 'review') return;
  throwIpcError(
    'UNSUPPORTED_CAPABILITY',
    'Review tasks only accept the host-owned initial review prompt',
  );
}
