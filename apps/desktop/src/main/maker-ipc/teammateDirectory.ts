import { REMOTE_RESOURCE_LIST_CHANNEL } from '@cindy/device-link';
import type {
  RemoteCollectionItem,
  RemoteCollectionListResponse,
  InvokeResultPayload,
} from '@cindy/device-link';
import type { DeviceLinkDeviceView } from '../../shared/deviceLinkIpc.js';
import { botPeerAddress } from '../../shared/botPeerAddress.js';
import type { TeammateDirectory } from './botDirectMessageService.js';

const client = { protocolVersion: 1, primitives: ['status', 'session-link'] };
const unavailable = (code: string): Error => Object.assign(new Error(code), { code });
function conversationSession(item: RemoteCollectionItem): string | undefined {
  const link = item.links?.find(
    (entry) => entry.rel === 'conversation' && entry.target.kind === 'session',
  );
  return link?.target.kind === 'session' ? link.target.sessionId : undefined;
}

/** Uses the same directory, resource projection and authenticated IPC tunnel as the clients. */
export function createTeammateDirectory(deps: {
  listDevices(): Promise<{ devices: DeviceLinkDeviceView[] }>;
  invoke(deviceId: string, channel: string, args: unknown[]): Promise<InvokeResultPayload>;
}): TeammateDirectory {
  const value = async <T>(deviceId: string, channel: string, args: unknown[]): Promise<T> => {
    const result = await deps.invoke(deviceId, channel, args);
    if (!result.ok) {
      const code =
        result.error.code === 'IPC_ERROR'
          ? (/^\[([A-Z_]+)\]/.exec(result.error.message)?.[1] ?? 'REMOTE_UNAVAILABLE')
          : result.error.code;
      throw unavailable(code);
    }
    return result.result as T;
  };
  return {
    async list() {
      const devices = (await deps.listDevices()).devices.filter(
        (row) => !row.isSelf && !['ios', 'android'].includes(row.platform ?? ''),
      );
      const agents: Awaited<ReturnType<TeammateDirectory['list']>>['agents'] = [];
      const unavailableDevices: Awaited<
        ReturnType<TeammateDirectory['list']>
      >['unavailableDevices'] = [];
      // Bound fanout independently of how many devices an account has registered.
      for (let offset = 0; offset < devices.length; offset += 3) {
        await Promise.all(
          devices.slice(offset, offset + 3).map(async (row) => {
            try {
              if (!row.controlEnabled || !row.remoteControlEnabled)
                throw unavailable('REMOTE_DISABLED');
              if (!row.online) throw unavailable('DEVICE_OFFLINE');
              const result = await value<RemoteCollectionListResponse>(
                row.deviceId,
                REMOTE_RESOURCE_LIST_CHANNEL,
                [{ client, collectionId: 'teammates', limit: 200 }],
              );
              for (const item of result.items) {
                if (item.ref.collectionId !== 'teammates' || item.ref.kind !== 'bot') continue;
                const name =
                  typeof item.display.title === 'string'
                    ? item.display.title
                    : item.display.title.fallback;
                const sessionId = conversationSession(item);
                agents.push({
                  id: botPeerAddress(row.deviceId, item.ref.id),
                  name,
                  deviceId: row.deviceId,
                  deviceName: row.name,
                  ...(sessionId ? { sessionId } : {}),
                });
              }
              if (result.nextCursor || result.items.length >= 200)
                throw unavailable('ROSTER_MAY_BE_TRUNCATED');
            } catch (error) {
              unavailableDevices.push({
                deviceId: row.deviceId,
                deviceName: row.name,
                errorCode:
                  error && typeof error === 'object' && 'code' in error
                    ? String(error.code)
                    : 'REMOTE_UNAVAILABLE',
              });
            }
          }),
        );
      }
      return { agents, unavailableDevices };
    },
  };
}
