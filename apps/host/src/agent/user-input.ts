import { withSessionPermissionChange } from '../../../desktop/src/main/maker-ipc/sessionPermissionChange.ts';
import { throwIpcError } from '../../../desktop/src/main/utils/ipcValidate.ts';

/**
 * A client's new input to a task, as the desktop's maker:send and INPUT_ENQUEUE take it (register.ts):
 * it waits for the task's permission and Plan changes in flight (the permission queue,
 * sessionPermissionChange.ts) before anything takes the task's send lock, and is refused if the account
 * changed while it waited. Only these client entries wait: the queue's own next input, recovery replays
 * and other internal sends do not come through here, so a turn can always finish and drain.
 */
export function createUserInputEnqueue<T>(ports: {
  getOwner(): unknown;
  enqueue(sessionId: string, input: unknown): Promise<T>;
}) {
  return async (sessionId: string, input: unknown): Promise<T> => {
    const owner = ports.getOwner();
    await withSessionPermissionChange(sessionId, async () => undefined);
    if (!owner || owner !== ports.getOwner()) throwIpcError('PRECONDITION_FAILED', 'Account changed before input');
    return ports.enqueue(sessionId, input);
  };
}
