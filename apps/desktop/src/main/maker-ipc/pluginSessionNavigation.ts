import type { InvokeResultPayload } from '@cindy/device-link';
import { isMobilePlatform } from '@cindy/maker-shared/device-list';
import { extractIpcError, extractRemoteOptionalReadMiss } from '../../shared/ipcError.js';
import type { DeviceLinkDeviceView } from '../../shared/deviceLinkIpc.js';
import { isPluginObserveTaskStatus, SESSION_STATUS_PROJECTION, type PluginSessionStatus } from '../../shared/pluginObserve.js';

const BATCH_CHANNEL = 'local-db:sessions:get-many';

interface NavigationPorts {
  selfDeviceId(): string | null;
  readLocal(sessionId: string): Promise<unknown>;
  readRemote(deviceId: string, sessionId: string, assertCurrent: () => void): Promise<InvokeResultPayload>;
  closeEpoch(deviceId: string): number | string;
  navigate(sessionId: string, deviceId?: string): void;
}

function sessionTarget(
  ports: Pick<NavigationPorts, 'selfDeviceId' | 'closeEpoch'>,
  device: string | undefined,
  assertAuthorized: () => void,
) {
  const deviceId = device && device !== 'local' && device !== ports.selfDeviceId() ? device : undefined;
  const epoch = deviceId === undefined ? undefined : ports.closeEpoch(deviceId);
  const assertCurrent = () => {
    assertAuthorized();
    if (deviceId !== undefined && ports.closeEpoch(deviceId) !== epoch) throw new Error('REMOTE_UNAVAILABLE');
  };
  assertCurrent();
  return { deviceId, assertCurrent };
}

/** Verify exactly the requested owner/session pair before handing it to native navigation. */
export async function openPluginSession(
  ports: NavigationPorts,
  sessionId: string,
  device: string | undefined,
  assertAuthorized: () => void,
): Promise<void> {
  const { deviceId, assertCurrent } = sessionTarget(ports, device, assertAuthorized);
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

type StatusDevice = Pick<DeviceLinkDeviceView, 'deviceId' | 'platform' | 'online' | 'controlEnabled' | 'remoteControlEnabled'>;
interface StatusPorts extends Pick<NavigationPorts, 'selfDeviceId' | 'closeEpoch'> {
  listDevices(): Promise<readonly StatusDevice[]>;
  readLocal(ids: string[]): Promise<PluginSessionStatus[]>;
  invoke(device: string, channel: string, args: unknown[], options: { preSend: () => void; noResultCache: true }): Promise<InvokeResultPayload>;
}

function remoteStatusError(error: unknown): Error {
  const raw = error as { code?: string; message?: string } | null;
  const message = raw?.message ?? '';
  const envelope = new Error(raw?.code && raw.code !== 'IPC_ERROR' ? `[${raw.code}] ${message}` : message);
  const ipc = extractIpcError(envelope);
  const code = (ipc?.code ?? raw?.code)?.replace(/^DEVICE_LINK_/, '');
  if (code === 'UNSUPPORTED_CAPABILITY' || code === 'VERSION_MISMATCH'
    || extractRemoteOptionalReadMiss(envelope, BATCH_CHANNEL)
    || (code === 'INVALID_PARAMS' && /^sessionIds must be an array of at most \d+ ids$/.test(ipc?.message ?? ''))) {
    return new Error('UNSUPPORTED_CAPABILITY');
  }
  if ((code === 'IPC_ERROR' && message === 'PERMISSION_DENIED')
    || ['ACCESS_REVOKED', 'REMOTE_DISABLED', 'UNAUTHORIZED', 'PERMISSION_DENIED', 'CONTROL_DISABLED', 'CHANNEL_NOT_ALLOWED'].includes(code ?? '')) {
    return new Error('PERMISSION_DENIED');
  }
  return new Error('REMOTE_UNAVAILABLE');
}

/** Read a single physical device. Missing/hidden ids have no entry; transport failures have no statuses. */
export async function readPluginSessionStatuses(
  ports: StatusPorts, ids: string[], device: string | undefined, assertAuthorized: () => void,
): Promise<PluginSessionStatus[]> {
  const { deviceId, assertCurrent } = sessionTarget(ports, device, assertAuthorized);
  if (!deviceId) return ports.readLocal(ids);
  const devices = await ports.listDevices().catch(error => { assertAuthorized(); throw remoteStatusError(error); });
  assertCurrent();
  const target = devices.find(row => row.deviceId === deviceId && !isMobilePlatform(row.platform));
  if (!target || !target.online) throw new Error('REMOTE_UNAVAILABLE');
  if (!target.controlEnabled || !target.remoteControlEnabled) throw new Error('PERMISSION_DENIED');
  const reply = await ports.invoke(deviceId, BATCH_CHANNEL, [{ projection: SESSION_STATUS_PROJECTION, ids }], {
    preSend: assertCurrent, noResultCache: true,
  }).catch(error => { assertAuthorized(); throw remoteStatusError(error); });
  assertAuthorized();
  if (!reply.ok) throw remoteStatusError(reply.error);
  assertCurrent();
  const rows = (reply.result as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(rows) || rows.length > ids.length) throw new Error('REMOTE_UNAVAILABLE');
  const requested = new Set(ids);
  return rows.map(row => {
    if (!requested.delete(row?.id) || !isPluginObserveTaskStatus(row.status)) throw new Error('REMOTE_UNAVAILABLE');
    return { id: row.id, status: row.status };
  });
}
