import type { InvokeResultPayload } from '@cindy/device-link';
import { extractIpcError } from '../../shared/ipcError.js';

interface NavigationPorts {
  selfDeviceId(): string | null;
  readLocal(sessionId: string): Promise<unknown>;
  readRemote(deviceId: string, sessionId: string, assertCurrent: () => void): Promise<InvokeResultPayload>;
  closeEpoch(deviceId: string): number;
  navigate(sessionId: string, deviceId?: string): void;
}

/** Verify exactly the requested owner/session pair before handing it to native navigation. */
export async function openPluginSession(
  ports: NavigationPorts,
  sessionId: string,
  device: string | undefined,
  assertAuthorized: () => void,
): Promise<void> {
  const deviceId = device && device !== 'local' && device !== ports.selfDeviceId() ? device : undefined;
  const epoch = deviceId === undefined ? undefined : ports.closeEpoch(deviceId);
  const assertCurrent = () => {
    assertAuthorized();
    if (deviceId !== undefined && ports.closeEpoch(deviceId) !== epoch) throw new Error('REMOTE_UNAVAILABLE');
  };
  assertCurrent();
  let value: unknown;
  if (deviceId === undefined) {
    value = await ports.readLocal(sessionId);
  } else {
    const reply = await ports.readRemote(deviceId, sessionId, assertCurrent).catch(() => {
      assertCurrent();
      throw new Error('REMOTE_UNAVAILABLE');
    });
    assertCurrent();
    if (!reply.ok) {
      const missing = reply.error.code === 'IPC_ERROR'
        && extractIpcError(new Error(reply.error.message))?.code === 'NOT_FOUND';
      throw new Error(missing ? 'TARGET_UNAVAILABLE' : 'REMOTE_UNAVAILABLE');
    }
    value = reply.result;
  }
  assertCurrent();
  const row = value as { id?: unknown; status?: unknown; hiddenAt?: unknown; orcaRole?: unknown; source?: unknown; companion?: unknown } | null;
  if (row?.id !== sessionId || (row.status !== 'active' && row.status !== 'archived')
    || row.hiddenAt != null || row.orcaRole === 'worker' || row.source === 'bot' || row.source === 'review' || row.companion) {
    throw new Error('TARGET_UNAVAILABLE');
  }
  ports.navigate(sessionId, deviceId ?? 'local');
}
