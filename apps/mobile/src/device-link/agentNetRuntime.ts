import * as Network from 'expo-network';
import { AppState } from 'react-native';
import { AgentNetMembership, AgentNetSocket, NativeTransport, type SessionConfig, type SessionHandle } from '@cindy/agent-net/portable';
import { agentNetStunServer } from '@cindy/agent-net-protocol';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { getOfficialAgentNetApiBaseUrl, getOfficialDeviceLinkApiBaseUrl } from '@/config/env';
import { apiFetchRaw } from '@/api/client';
import { getActiveSelfHostedRelay, getSelfHostedRelayRouteGeneration, isAgentNetOnlyRoute, subscribeSelfHostedRelayRoute } from './selfHostedRelayRouting';
import { MobileAgentNetEngine } from './agentNetNative';
import { ensureMobileAgentNetIdentity, clearMobileAgentNetIdentity, currentMobileAgentNetIdentity, type MobileAgentNetEnrollmentOptions } from './agentNetIdentity';
import { getMobileAgentNetPreferences, mobileAgentNetRequiresEncryption, subscribeMobileAgentNetPreferences } from './agentNetPreferences';
import { clearMobileAgentNetNotifications, clearMobileAgentNetNotificationDelivery, refreshMobileAgentNetNotificationPreferences,
  mobileAgentNetNotificationScope, mutateMobileAgentNetNotificationRegistration, updateMobileAgentNetNotificationTrust,
  sendMobileAgentNetNotification } from './agentNetNotifications';
import { installMobileAgentNetPush } from './agentNetPushRegistry';
import { installMobileAgentNetMedia } from './agentNetMediaRegistry';
import { mobileAgentNetDiscovery } from './agentNetLan';
import { verifyMobileAgentNetCertificate, verifyMobileAgentNetDelegation } from './agentNetProtocol';
import { readMobileAgentNetDirectory, writeMobileAgentNetDirectory } from './agentNetDirectoryCache';
import { verifyMobileAgentNetModeProof } from './agentNetMode';
import { connectMobileAgentNetSharingSession, mobileAgentNetSharingMediaTarget, mobileAgentNetSharingReachable,
  mobileAgentNetSharingSession, setMobileAgentNetPrivateSharingSupport, useMobileAgentNetSharingSessions } from './agentNetSharing';
import { isScopedPeer } from '@cindy/device-link';

let current: { socket: AgentNetSocket; guard(): void } | null = null;
let openAttempt = 0;
function live(): AgentNetSocket | null {
  try { current?.guard(); return current?.socket ?? null; } catch { return null; }
}

// ─── Sessions (docs/agent-net-session-plan.md §10, stage 4), as the Desktop's agentNetRuntime.ts ───────────────────
let sessionConfig: SessionConfig | null = null;
/** When this phone's connection to each peer came up (or changed), `performance.now()`; the session layer waits briefly after it. */
const peerConnectedAt = new Map<string, number>();
/**
 * Turns Agent-Net sessions on for this phone's connections: the main one (same account) and each shared task's own
 * (cross-account, as a guest). Two new nodes then talk on sessions instead of Device Link frames; with an older computer,
 * or Agent-Net off, nothing changes.
 */
export function useMobileAgentNetSessions(config: SessionConfig | null): void {
  sessionConfig = config;
  if (config) live()?.useSessions(config);
  useMobileAgentNetSharingSessions(config);
}
/** The live session with this peer: a device of this account on the main connection, a shared task on its own; null otherwise. */
export function mobileAgentNetSession(peer: string): SessionHandle | null {
  if (isScopedPeer(peer)) return mobileAgentNetSharingSession(peer);
  return live()?.session(peer) ?? null;
}
/** Connects before the first link so its session exists before the first message (PortableSocket.connectSession). */
export function connectMobileAgentNetSessionPeer(peer: string): Promise<boolean> {
  if (isScopedPeer(peer)) return connectMobileAgentNetSharingSession(peer);
  const socket = live();
  if (!socket) return Promise.resolve(false);
  // Both sides dialing at once: this phone's handshake can lose to the computer's, whose connection is up meanwhile.
  return socket.connectSession(peer).then(connected => connected || socket.pathTo(peer) !== null);
}
/**
 * This peer on this phone's Agent-Net (AgentNetSessionLinksOptions.agentNetPeer): a device of this account online on it now,
 * known but offline, or null (Agent-Net off, not an Agent-Net device). A shared task: online while its own connection exists.
 */
export function mobileAgentNetPeerState(peer: string): 'online' | 'offline' | null {
  if (isScopedPeer(peer)) return mobileAgentNetSharingReachable(peer) ? 'online' : null;
  const socket = live();
  if (!socket || !isMobileAgentNetActive() || !socket.knowsPeer(peer)) return null;
  return socket.supports(peer) ? 'online' : 'offline';
}
export function mobileAgentNetPeerRoute(peer: string): { path: 'direct' | 'relay' | null; rttMs: number | null } {
  const socket = live();
  return { path: socket?.pathTo(peer) ?? null, rttMs: socket?.peerSnapshot(peer)?.rttMs ?? null };
}
export function mobileAgentNetPeerConnectedAt(peer: string): number | null { return peerConnectedAt.get(peer) ?? null; }
/** The phone changed networks: connections send from the new address now and candidates are gathered again. */
export function notifyMobileAgentNetNetworkChanged(): void { live()?.networkChanged(); }

// ─── Devices removed in Device Link (docs/dev-rules/protocol-compatibility/agent-net-device-removal.md) ─────────────
/**
 * On the official Agent-Net, a computer removed from this account in Device Link keeps a valid certificate until it signs
 * in again; like the Desktop, this phone accepts only devices in the account's Device Link list. The list is read through
 * a raw official Device Link request. The merged UI directory can contain the same removed certificate.
 */
let deviceListReader: (() => Promise<readonly string[] | null>) | null = null;
const membership = new AgentNetMembership({
  readDeviceLinkDeviceIds: () => deviceListReader?.() ?? Promise.resolve(null),
  apply: rule => { if (!getActiveSelfHostedRelay()) live()?.restrictPeers(rule); },
  active: () => !!live() && !getActiveSelfHostedRelay(),
});
/** An existing read of the official device list finished (it started at `startedAt`). */
export function noteMobileAgentNetDeviceList(deviceIds: readonly string[], startedAt: number): void {
  if (!getActiveSelfHostedRelay() && getMobileAgentNetPreferences().enabled && isMobileAgentNetActive()) {
    membership.noteDeviceList(deviceIds, startedAt);
  }
}

// ─── The relay's STUN and UDP forwarding (`/api/agent-net/info`) ─────────────────────────────────────────────────
// A foreground reconnect can reuse both an in-flight lookup and its result.
const RELAY_INFO_TTL_MS = 10 * 60_000;
const RELAY_INFO_RETRY_MS = 60_000;
interface RelayInfo { server: string | null; privateSharing: boolean; }
const relayInfo = new Map<string, RelayInfo & { nextReadAt: number; pending?: Promise<RelayInfo> }>();
function readRelayInfo(base: string): Promise<RelayInfo> {
  const entry = relayInfo.get(base) ?? { server: null, privateSharing: false, nextReadAt: 0 };
  if (entry.pending) return entry.pending;
  if (Date.now() < entry.nextReadAt) return Promise.resolve(entry);
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 5_000);
  entry.pending = (async () => {
    let interval = RELAY_INFO_RETRY_MS;
    try {
      const response = await fetch(base + '/api/agent-net/info', { signal: abort.signal });
      if (response.ok) {
        const info = await response.json();
        entry.server = agentNetStunServer(base, info);
        entry.privateSharing = Array.isArray(info?.features) && info.features.includes('private-sharing-v1');
        interval = RELAY_INFO_TTL_MS;
      }
    } catch { /* Keep the last known server while the lookup is unavailable. */ }
    finally {
      clearTimeout(timer);
      entry.nextReadAt = Date.now() + interval;
    }
    return entry;
  })().finally(() => { entry.pending = undefined; });
  relayInfo.set(base, entry);
  return entry.pending;
}
export function isMobileAgentNetActive(): boolean {
  const settings = getMobileAgentNetPreferences(), route = getActiveSelfHostedRelay();
  // 只走 V2 的网络(别人分享来的中转)不看「启用 Agent-Net」开关:没有旧版可退。
  if (isAgentNetOnlyRoute(route)) return settings.ready && MobileAgentNetEngine.available() && !!route!.signing?.agentNet?.certificate;
  return settings.ready && settings.enabled && MobileAgentNetEngine.available()
    && (route ? !!route.signing?.agentNet : !!getOfficialAgentNetApiBaseUrl());
}
export function mobileAgentNetShouldUseLegacyPeer(id: string): boolean { return live()?.knowsPeer(id) === false; }
export function mobileAgentNetShouldProbeLegacyPeer(id: string): boolean { const socket = live(); return !!socket?.knowsPeer(id) && !socket.supports(id); }
export function mobileAgentNetPrefersPrimary(payload: unknown): boolean {
  const value = payload as { transportAttestation?: { enabled?: unknown } } | null;
  return value?.transportAttestation?.enabled === true;
}
export function mobileAgentNetMediaPeer(deviceId: string) {
  const socket = live();
  if (!socket) return null;
  const certificate = socket.certificateFor(deviceId);
  return certificate ? { certificate } : null;
}
export function canUploadMobileAgentNetMedia(deviceId?: string): boolean {
  // A known V2 sharing route's errors must never permit plaintext fallback.
  if (deviceId && isScopedPeer(deviceId)) return !!mobileAgentNetSharingMediaTarget(deviceId);
  if (!deviceId || !isMobileAgentNetActive()) return false;
  const socket = live(), certificate = socket?.certificateFor(deviceId);
  if (!certificate && socket?.knowsPeer(deviceId)) throw new Error('AGENT_NET_MEDIA_PEER_UNAVAILABLE');
  return !!certificate;
}
installMobileAgentNetMedia({
  available: canUploadMobileAgentNetMedia,
  requiresEncryption: mobileAgentNetRequiresEncryption,
  async upload(options) {
    const owner = getMobileAuthOwner(), route = getSelfHostedRelayRouteGeneration(), generation = getMobileAgentNetPreferences().generation;
    const guard = () => {
      options.assertCurrent?.();
      if (!owner.accountKey || !isMobileAuthOwnerCurrent(owner) || route !== getSelfHostedRelayRouteGeneration()
        || generation !== getMobileAgentNetPreferences().generation) throw new Error('AGENT_NET_OWNER_CHANGED');
    };
    guard();
    const { uploadMobileAgentNetMedia } = await import('./agentNetMedia');
    guard();
    const result = await uploadMobileAgentNetMedia(options.deviceId, options.size, options.contentType, options.read, { ...options, assertCurrent: guard });
    guard(); return result;
  },
});
export function verifyMobileAgentNetTransportProof(peer: string, requestId: string, proof: unknown): boolean {
  const socket = live();
  if (!socket?.knowsPeer(peer)) return true;
  const certificate = socket.certificateFor(peer);
  return !!certificate && verifyMobileAgentNetModeProof(certificate, socket.deviceId, requestId, proof);
}
export function stopMobileAgentNetRuntime(): void {
  openAttempt++;
  const previous = current; current = null;
  previous?.socket.close();
  peerConnectedAt.clear();
  deviceListReader = null;
  membership.reset();
  clearMobileAgentNetNotifications();
  void clearMobileAgentNetIdentity();
}
subscribeMobileAuthOwner(stopMobileAgentNetRuntime);
subscribeSelfHostedRelayRoute(stopMobileAgentNetRuntime);
subscribeMobileAgentNetPreferences(stopMobileAgentNetRuntime);
installMobileAgentNetPush({ selected: isMobileAgentNetActive, clear: clearMobileAgentNetNotificationDelivery,
  refreshPreferences: refreshMobileAgentNetNotificationPreferences,
  scope: mobileAgentNetNotificationScope, mutate: mutateMobileAgentNetNotificationRegistration });

export async function openMobileAgentNetSocket(options: MobileAgentNetEnrollmentOptions): Promise<AgentNetSocket | null> {
  if (!isMobileAgentNetActive()) return null;
  const attempt = ++openAttempt;
  const owner = getMobileAuthOwner(), route = getSelfHostedRelayRouteGeneration();
  const preferences = getMobileAgentNetPreferences();
  const guard = () => {
    if (attempt !== openAttempt || !isMobileAuthOwnerCurrent(owner) || getSelfHostedRelayRouteGeneration() !== route
      || getMobileAgentNetPreferences().generation !== preferences.generation || !isMobileAgentNetActive()) {
      throw new Error('AGENT_NET_OWNER_CHANGED');
    }
  };
  guard();
  let identity = await ensureMobileAgentNetIdentity(options); guard();
  const cached = await readMobileAgentNetDirectory(identity); guard();
  const cachedDirectory = [...(cached?.devices ?? [])];
  // Match Desktop's offline startup: our validated local certificate keeps the
  // node alive for V1 compatibility, without authorizing any unknown remote peer
  // or extending the cached directory's original validity window.
  if (!cachedDirectory.some(view => view.certificate.deviceId === identity.api.identity.deviceId)) {
    cachedDirectory.push({ certificate: identity.api.certificate, name: '', online: false, remoteControlEnabled: false, capabilities: [] });
  }
  // Read again on every network change, for this phone's candidates (NativeTransport.networkChanged).
  const addresses = async (): Promise<string[]> => {
    try { const address = await Network.getIpAddressAsync(); return address && address !== '0.0.0.0' ? [address] : []; }
    catch { return []; /* Relay remains available without a local candidate. */ }
  };
  const official = preferences.enabled && !getActiveSelfHostedRelay();
  if (official) {
    deviceListReader = async () => {
      guard();
      const token = await options.getAccessToken();
      guard();
      if (!token) return null;
      const list = await apiFetchRaw<{ devices: { deviceId: string }[] }>('/api/device-link/devices', {
        baseUrl: getOfficialDeviceLinkApiBaseUrl(), token, assertCurrent: guard, timeoutMs: 3_000,
      });
      guard();
      return list.devices.map(device => device.deviceId);
    };
    if (!membership.hasDeviceList()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([membership.prime(), new Promise<void>(resolve => { timer = setTimeout(resolve, 3_000); })]);
      } finally { clearTimeout(timer); }
      guard();
    }
  }
  let openingDirectory = cachedDirectory.map(view => ({ deviceId: view.certificate.deviceId, online: false }));
  const engine = await identity.newTransportEngine(guard, preferences.enabled);
  try {
    const socket = await AgentNetSocket.openWithBindings({
      client: identity.api, assertCurrent: guard, userId: owner.accountId,
      cachedDirectory, directoryExpiresAt: cached?.expiresAt,
      ...(official ? { peerRule: membership.rule() } : {}),
      onDirectory: devices => {
        void writeMobileAgentNetDirectory(identity, devices).catch(() => undefined);
        updateMobileAgentNetNotificationTrust(identity, devices, guard);
        if (official) {
          openingDirectory = devices.map(view => ({ deviceId: view.certificate.deviceId, online: view.online }));
          if (current?.guard === guard) membership.noteDirectory(openingDirectory);
        }
      },
      onPathChanged: (deviceId, path) => {
        if (current?.guard !== guard) return;
        if (path) peerConnectedAt.set(deviceId, performance.now()); else peerConnectedAt.delete(deviceId);
      },
      bindings: {
        verifyCertificate: verifyMobileAgentNetCertificate,
        verifyDelegation: verifyMobileAgentNetDelegation,
        notify: (recipient, payload, signal) => sendMobileAgentNetNotification(identity, recipient, payload, signal, guard),
        createTransport: async options => {
          const transport = await NativeTransport.create(engine, options, addresses, preferences.enabled);
          const base = identity.api.base;
          const udp = preferences.enabled && (transport.supports('stun') || transport.supports('relay-udp-v2'));
          const privateNetwork = preferences.enabled && identity.api.certificate.networkId.startsWith('private:');
          if (base && (udp || privateNetwork)) {
            // The existing WebSocket/direct connection can start while the optional lookup runs.
            void readRelayInfo(base).then(info => {
              guard();
              if (privateNetwork) setMobileAgentNetPrivateSharingSupport(base, identity.api.rootPublicKey, info.privateSharing);
              if (udp && info.server) return transport.configureUdpServer(info.server);
            }).catch(() => undefined);
          }
          return transport;
        },
        createDiscovery: discovery => mobileAgentNetDiscovery(discovery, identity.signer, guard,
          () => currentMobileAgentNetIdentity()?.signer ?? identity.signer),
      },
    });
    try { guard(); } catch (error) { socket.close(); throw error; }
    const previous = current; current = { socket, guard };
    previous?.socket.close();
    peerConnectedAt.clear();
    if (official) {
      socket.restrictPeers(membership.rule());
      membership.noteDirectory(openingDirectory);
    }
    if (preferences.enabled && sessionConfig) socket.useSessions(sessionConfig);
    let renewal: ReturnType<typeof setTimeout> | undefined, renewing = false;
    const schedule = (retry = false) => {
      if (renewal) clearTimeout(renewal);
      if (getActiveSelfHostedRelay()) return;
      renewal = setTimeout(() => { void renew(); }, retry ? 60_000
        : Math.min(6 * 60 * 60_000, Math.max(60_000, identity.api.certificate.expiresAt - Date.now() - 24 * 60 * 60_000)));
    };
    const renew = async () => {
      if (renewing || current?.socket !== socket || getActiveSelfHostedRelay()) return;
      renewing = true;
      try {
        guard();
        const next = await ensureMobileAgentNetIdentity(options); guard();
        if (current?.socket !== socket) return;
        if (next !== identity) { await socket.replaceClient(next.api); identity = next; }
        schedule();
      } catch { if (current?.socket === socket) schedule(true); }
      finally { renewing = false; }
    };
    const foreground = AppState.addEventListener('change', state => { if (state === 'active') {
      void renew(); void socket.refreshDirectory().catch(() => undefined);
    } });
    schedule();
    socket.once('close', () => {
      if (renewal) clearTimeout(renewal); foreground.remove();
      if (current?.socket === socket) { current = null; peerConnectedAt.clear(); }
    });
    return socket;
  } catch (error) { await engine.destroy(); throw error; }
}
