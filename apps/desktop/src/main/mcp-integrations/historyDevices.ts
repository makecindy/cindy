import {
  DL_HISTORY_QUERY_CHANNEL,
  DeviceLinkError,
  type InvokeResultPayload,
} from '@cindy/device-link';
import type { HistoryRemoteDeps } from '@cindy/mcps';
import type { DeviceLinkDeviceView } from '../../shared/deviceLinkIpc.js';
import { classifyRemoteHistoryError } from './remoteChatHistory.js';

export function createHistoryRemoteDeps(deps: {
  listDevices(): Promise<{ devices: DeviceLinkDeviceView[] }>;
  captureAccess(): () => void;
  invoke(
    deviceId: string,
    channel: string,
    args: unknown[],
    options?: { preSend?: () => void },
  ): Promise<InvokeResultPayload>;
}): HistoryRemoteDeps {
  return {
    captureAccess: deps.captureAccess,
    async listDevices() {
      const assertCurrent = deps.captureAccess();
      const { devices } = await deps.listDevices();
      assertCurrent();
      const result = devices
        .filter((d) => d.isSelf || !['ios', 'android'].includes(d.platform ?? ''))
        .map((d) => ({
          deviceId: d.isSelf ? 'local' : d.deviceId,
          deviceName: d.name,
          local: d.isSelf,
          available: d.isSelf || (d.online && d.controlEnabled && d.remoteControlEnabled),
          ...(!d.isSelf && (!d.online || !d.controlEnabled || !d.remoteControlEnabled)
            ? { unavailableReason: !d.online ? 'REMOTE_DEVICE_OFFLINE' : 'REMOTE_DISABLED' }
            : {}),
        }));
      if (!result.some((d) => d.local))
        result.unshift({ deviceId: 'local', deviceName: 'Local', local: true, available: true });
      return result;
    },
    async query(deviceId, tool, args) {
      const assertCurrent = deps.captureAccess();
      try {
        const response = await deps.invoke(deviceId, DL_HISTORY_QUERY_CHANNEL, [{ tool, args }], {
          preSend: assertCurrent,
        });
        assertCurrent();
        if (!response.ok)
          return {
            ok: false,
            ...classifyRemoteHistoryError(response.error.code, response.error.message),
          };
        if (
          !response.result ||
          typeof response.result !== 'object' ||
          Array.isArray(response.result) ||
          typeof (response.result as Record<string, unknown>).ok !== 'boolean'
        ) {
          return { ok: false, errorCode: 'REMOTE_INVALID_RESPONSE' };
        }
        return response.result as Record<string, unknown>;
      } catch (error) {
        assertCurrent();
        return {
          ok: false,
          ...(error instanceof DeviceLinkError
            ? classifyRemoteHistoryError(error.code, error.message)
            : { errorCode: 'REMOTE_UNAVAILABLE' }),
        };
      }
    },
  };
}
