import { readCreateSessionOpts, type ReadCreateSessionOptsDeps } from '../../desktop/src/main/maker-ipc/sessionRequest.js';
import { createBusinessSessionId } from '../../desktop/src/main/sessionIds.js';

/** Remote controllers may omit the id of a dialogue task (no project, no
 * preset id), so Host mints one exactly as the desktop create handler does. */
export function readHostCreateSessionOpts(
  input: unknown,
  allocateDialogueWorkspace: NonNullable<ReadCreateSessionOptsDeps['allocateDialogueWorkspace']>,
) {
  return readCreateSessionOpts(input, { allocateDialogueWorkspace, createSessionId: createBusinessSessionId });
}
