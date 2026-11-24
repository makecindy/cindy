import type { IpcRenderer } from 'electron';
import type { LinkAcceptPayload } from '@cindy/device-link';
import { DEVICE_LINK_INVOKE, DEVICE_LINK_PUSH } from '../shared/deviceLinkIpc';
import { extractRemoteOptionalReadMiss } from '../shared/ipcError';

const missingHandlerReads = new Set([
  'maker:remote-resources:list', 'local-db:history:query',
  'maker:schedule:list-sidebar-index-runs', 'maker:schedule:list',
  'maker:git-safety:get', 'model-groups:get',
]);

// `maker:model-context-limit:get` 在 `registerMakerIpcsAfterSplash` 才注册：
// 只记远端 `REMOTE_INVOKE_ALLOWLIST` 明确拒绝，不记冷启动期间的 `NOT_FOUND` 缺 handler。
const optionalReads = new Set([
  ...missingHandlerReads,
  'maker:model-context-limit:get',
]);

interface PeerReads {
  missing: Map<string, string>;
  version?: string;
  offer?: string;
}

type BridgeIpc = Pick<IpcRenderer, 'invoke'> & { on: (...args: Parameters<IpcRenderer['on']>) => void };

export function createRemoteReadBridge(ipc: BridgeIpc) {
  const peers = new Map<string, PeerReads>();
  const knownVersions = new Map<string, string>();
  let observing = false;

  function forgetPeer(deviceId: string): void {
    peers.delete(deviceId);
    knownVersions.delete(deviceId);
  }

  function forgetAll(): void {
    peers.clear();
    knownVersions.clear();
  }

  function observe(): void {
    if (observing) return;
    observing = true;
    for (const event of [DEVICE_LINK_PUSH.PEER_LINK_RESET, DEVICE_LINK_PUSH.PEER_LINK_REOPENED,
      DEVICE_LINK_PUSH.ACCESS_REVOKED, DEVICE_LINK_PUSH.CONTROL_TARGET_CHANGED]) {
      ipc.on(event, (_event, { deviceId }) => { forgetPeer(deviceId); });
    }
    ipc.on(DEVICE_LINK_PUSH.PRESENCE_CHANGED, (_event, { deviceId, online, remoteControlEnabled, appVersion }) => {
      if (!online || remoteControlEnabled === false) {
        forgetPeer(deviceId);
        return;
      }
      if (typeof appVersion === 'string') {
        if (!knownVersions.has(deviceId) && knownVersions.size >= 256) {
          knownVersions.delete(knownVersions.keys().next().value!);
        }
        knownVersions.set(deviceId, appVersion);
      }
      const peer = peers.get(deviceId);
      if (!peer || typeof appVersion !== 'string') return;
      if (peer.version !== undefined && peer.version !== appVersion) {
        peers.set(deviceId, { missing: new Map(), version: appVersion });
      } else {
        peer.version = appVersion;
      }
    });
    ipc.on(DEVICE_LINK_PUSH.STATUS_CHANGED, (_event, { status, dataPathChangedDeviceId }) => {
      if (dataPathChangedDeviceId) forgetPeer(dataPathChangedDeviceId);
      else if (status !== 'online') forgetAll();
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
      ipc.on(event, () => forgetAll());
    }
  }

  function scope(deviceId: string): PeerReads {
    observe();
    const existing = peers.get(deviceId);
    if (existing) return existing;
    if (peers.size >= 256) peers.delete(peers.keys().next().value!);
    const peer: PeerReads = { missing: new Map<string, string>(), version: knownVersions.get(deviceId) };
    peers.set(deviceId, peer);
    return peer;
  }

  return {
    async openLink(deviceId: string): Promise<LinkAcceptPayload> {
      const peer = scope(deviceId);
      const accepted: LinkAcceptPayload = await ipc.invoke(DEVICE_LINK_INVOKE.OPEN_LINK, { deviceId });
      const offer = JSON.stringify([accepted.allowlistHash, Array.isArray(accepted.capabilities) ? [...accepted.capabilities].sort() : []]);
      if (peers.get(deviceId) === peer) {
        if (typeof accepted.appVersion === 'string') {
          if (!knownVersions.has(deviceId) && knownVersions.size >= 256) {
            knownVersions.delete(knownVersions.keys().next().value!);
          }
          knownVersions.set(deviceId, accepted.appVersion);
        }
        if (peer.version !== accepted.appVersion || peer.offer !== offer) {
          peers.set(deviceId, { missing: new Map(), version: accepted.appVersion, offer });
        }
      }
      return accepted;
    },
    closeLink(deviceId: string): Promise<{ ok: true }> {
      forgetPeer(deviceId);
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
        if (peers.get(deviceId) === peer) peer.missing.delete(channel);
        return result;
      } catch (error) {
        if (peers.get(deviceId) === peer) {
          const remembered = extractRemoteOptionalReadMiss(error, channel, {
            allowMissingHandler: missingHandlerReads.has(channel),
          });
          if (remembered) peer.missing.set(channel, remembered);
        }
        throw error;
      }
    },
  };
}
