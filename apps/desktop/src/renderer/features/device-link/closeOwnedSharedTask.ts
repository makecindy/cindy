import { SHARED_TASK_HOST_CHANNEL, type SharedTaskCloseResult } from '@cindy/device-link';

/** Remote hosts must revoke local guest access before cancellation completes. */
export async function closeOwnedSharedTask(
  sharedTaskId: string,
  hostDeviceId: string | undefined,
  current: () => boolean,
): Promise<boolean> {
  if (!current()) return false;
  if (hostDeviceId) {
    await window.electronAPI.deviceLink.openLink(hostDeviceId);
    if (!current()) return false;
    const result = await window.electronAPI.deviceLink.invoke(hostDeviceId, SHARED_TASK_HOST_CHANNEL,
      [{ action: 'close', sharedTaskId }]) as { ok?: boolean };
    return current() && result?.ok === true;
  }
  // The account adapter routes locally hosted tasks through the host journal.
  const result = await window.electronAPI.sharedTask.account({ action: 'close', sharedTaskId }) as SharedTaskCloseResult;
  return current() && result.closed.includes(sharedTaskId);
}
