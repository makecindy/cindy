import { randomUUID } from 'node:crypto';
import type { IpcMainInvokeEvent } from 'electron';
import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import type { HostClient } from '../host-delegation.js';
import { rendererProjectRequest } from '../projectConfirmation.desktop.js';
import type { ProjectRendererCheck } from '../projectInfoAuthorization.js';
import { requireObject, throwIpcError } from '../utils/ipcValidate.js';

// Only the in-flight Main → Host invocation knows its id. Nothing is returned to the page.
const requests = new Map<string, ReturnType<typeof rendererProjectRequest>>();

export async function forwardProjectWrite(
  client: HostClient,
  event: IpcMainInvokeEvent,
  input: unknown,
  readOwner?: () => DataOwnerPushStamp,
) {
  const authorization = rendererProjectRequest(event, input, readOwner);
  authorization.assertCurrent?.();
  const body = requireObject(input, 'project');
  if (
    !body.create &&
    (body.field === 'name' ||
      body.field === 'icon' ||
      (body.field === 'profile' && !('directories' in requireObject(body.value, 'value'))))
  ) {
    return client.request('/api/project-info/set', input);
  }
  const requestId = randomUUID();
  requests.set(requestId, authorization);
  try {
    return await client.request('/api/project-info/desktop-set', { requestId, input });
  } finally {
    requests.delete(requestId);
  }
}

/** Called only by the owner- and instance-bound platform socket. */
export async function checkForwardedProjectWrite(
  requestId: string,
  check: ProjectRendererCheck,
  signal: AbortSignal,
) {
  const request = requests.get(requestId);
  if (!request) throwIpcError('PERMISSION_DENIED', 'Project request is no longer available');
  signal.throwIfAborted();
  await request.check(check, signal);
  signal.throwIfAborted();
  if (requests.get(requestId) !== request)
    throwIpcError('PERMISSION_DENIED', 'Project request ended');
  return true;
}
