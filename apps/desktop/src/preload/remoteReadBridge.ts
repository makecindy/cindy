import type { IpcRenderer } from 'electron';
import type { LinkAcceptPayload } from '@cindy/device-link';
import { DEVICE_LINK_INVOKE, DEVICE_LINK_PUSH } from '../shared/deviceLinkIpc';
import { extractIpcError } from '../shared/ipcError';

const optionalReads = new Set([
  'maker:remote-resources:list', 'local-db:history:query',
  'maker:schedule:list-sidebar-index-runs', 'maker:schedule:list',
  'maker:git-safety:get', 'model-groups:get',
]);

interface PeerReads {
  missing: Map<string, string>;
  version?: string;
  offer?: string;
}

type BridgeIpc = Pick<IpcRenderer, 'invoke'> & { on: (...args: Parameters<IpcRenderer['on']>) => void };

export function createRemoteReadBridge(ipc: BridgeIpc) {
  const peers = new Map<string, PeerReads>();
  let observing = false;

  function observe(): void {
    if (observing) return;
    observing = true;
    for (const event of [DEVICE_LINK_PUSH.PEER_LINK_RESET, DEVICE_LINK_PUSH.PEER_LINK_REOPENED,
      DEVICE_LINK_PUSH.ACCESS_REVOKED, DEVICE_LINK_PUSH.CONTROL_TARGET_CHANGED]) {
      ipc.on(event, (_event, { deviceId }) => { peers.delete(deviceId); });
    }
    ipc.on(DEVICE_LINK_PUSH.PRESENCE_CHANGED, (_event, { deviceId, online, remoteControlEnabled, appVersion }) => {
      const peer = peers.get(deviceId);
      if (!peer) return;
      if (!online || !remoteControlEnabled) peers.delete(deviceId);
      else if (peer.version !== appVersion) peers.set(deviceId, { missing: new Map(), version: appVersion });
    });
    ipc.on(DEVICE_LINK_PUSH.STATUS_CHANGED, (_event, { status, dataPathChangedDeviceId }) => {
      if (dataPathChangedDeviceId) peers.delete(dataPathChangedDeviceId);
      else if (status !== 'online') peers.clear();
    });
    ipc.on(DEVICE_LINK_PUSH.REMOTE_PUSH, (_event, { deviceId, channel, payload }) => {
      if (channel !== 'maker:schedule:event' || payload?.type !== 'ready') return;
      const peer = peers.get(deviceId);
      if (!peer) return;
      const missing = new Map(peer.missing);
      missing.delete('maker:schedule:list');
      missing.delete('maker:schedule:list-sidebar-index-runs');
      peers.set(deviceId, { ...peer, missing });
    });
    for (const event of ['auth:state-change', 'auth:session-expired', DEVICE_LINK_PUSH.OWNERSHIP_CHANGED]) {
      ipc.on(event, () => peers.clear());
    }
  }

  function scope(deviceId: string): PeerReads {
    observe();
    const existing = peers.get(deviceId);
    if (existing) return existing;
    if (peers.size >= 256) peers.delete(peers.keys().next().value!);
    const peer = { missing: new Map<string, string>() };
    peers.set(deviceId, peer);
    return peer;
  }

  return {
    async openLink(deviceId: string): Promise<LinkAcceptPayload> {
      const peer = scope(deviceId);
      const accepted: LinkAcceptPayload = await ipc.invoke(DEVICE_LINK_INVOKE.OPEN_LINK, { deviceId });
      const offer = JSON.stringify([accepted.allowlistHash, Array.isArray(accepted.capabilities) ? [...accepted.capabilities].sort() : []]);
      if (peers.get(deviceId) === peer && (peer.version !== accepted.appVersion || peer.offer !== offer)) {
        peers.set(deviceId, { missing: new Map(), version: accepted.appVersion, offer });
      }
      return accepted;
    },
    closeLink(deviceId: string): Promise<{ ok: true }> {
      peers.delete(deviceId);
      return ipc.invoke(DEVICE_LINK_INVOKE.CLOSE_LINK, { deviceId });
    },
    async invoke(deviceId: string, channel: string, args: unknown[], scheduling?: { background?: boolean }): Promise<unknown> {
      const send = () => ipc.invoke(DEVICE_LINK_INVOKE.INVOKE, { deviceId, channel, args, ...(scheduling ? { scheduling } : {}) });
      if (!optionalReads.has(channel)) return send();
      const peer = scope(deviceId);
      const missing = peer.missing.get(channel);
      if (missing) throw new Error(missing);
      try {
        const result = await send();
        peer.missing.delete(channel);
        return result;
      } catch (error) {
        const failure = extractIpcError(error);
        if (failure?.code === 'NOT_FOUND' && failure.message === `no local IPC handler for channel '${channel}'`) {
          peer.missing.set(channel, `[${failure.code}] ${failure.message}`);
        }
        throw error;
      }
    },
  };
}
