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
import { DeviceLinkRegistrationRemovedError, isScopedPeer } from '@cindy/device-link';

let current: { socket: AgentNetSocket; guard(): void } | null = null;
let openAttempt = 0;
let refusedSelection: string | null = null;
function live(): AgentNetSocket | null {
  try { current?.guard(); return current?.socket ?? null; } catch { return null; }
}
function refusalScope(): string | null {
  const owner = getMobileAuthOwner();
  if (!owner.accountKey) return null;
  return JSON.stringify([owner.accountKey, getSelfHostedRelayRouteGeneration(), getMobileAgentNetPreferences().generation]);
}
/** True once the Agent-Net service refused this phone's identity (e.g. permanently revoked on removal); resets on account/route/preference change. */
export function mobileAgentNetIdentityRefused(): boolean {
  const scope = refusalScope();
  return scope !== null && refusedSelection === scope;
}
/** After this removed phone rejoined (deviceRejoin.ts): its next connection tries Agent-Net again instead of running as with it off. */
export function clearMobileAgentNetIdentityRefusal(): void {
  refusedSelection = null;
}
function isMobileIdentityRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  const status = (error as { status?: unknown } | null)?.status;
  const code = (error as { code?: unknown } | null)?.code;
  return /^AGENT_NET_UPGRADE_(401|403)$/.test(message)
    || status === 401 || status === 403
    || code === 'DEVICE_REENROLLMENT_REQUIRES_APPROVAL'
    || code === 'DEVICE_REVOKED';
}
function noteMobileIdentityRefused(): boolean {
  if (mobileAgentNetRequiresEncryption()) return false;
  const scope = refusalScope();
  if (!scope) return false;
  refusedSelection = scope;
  return true;
}

// ─── Sessions (docs/agent-net-session-plan.md §10, stage 4), as the Desktop's agentNetRuntime.ts ───────────────────
let sessionConfig: SessionConfig | null = null;
/** When this phone's connection to each peer came up (or changed), `performance.now()`; the session layer waits briefly after it. */
const peerConnectedAt = new Map<string, number>();
/**
 * Verified direct UDP addresses from the previous socket on the same local IP (process memory only, never persisted;
 * cleared on account/route/preference change and on physical route switches). Lets a foreground resume dial LAN computers
 * straight away without waiting for the relay WebSocket and relay UDP registration first.
 */
const MAX_REMEMBERED_DIRECT = 64;
const rememberedDirect = new Map<string, { address: string; port: number; localIp: string | null }>();
let lastKnownLocalIp: string | null = null;
function isPrivateAddress(address: string): boolean {
  if (address.includes(':')) return /^(fe80:|fc|fd)/i.test(address);
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254);
}
function rememberDirectAddress(deviceId: string, address: { address: string; port: number }, localIp: string | null): void {
  if (rememberedDirect.has(deviceId)) rememberedDirect.delete(deviceId);
  else if (rememberedDirect.size >= MAX_REMEMBERED_DIRECT) rememberedDirect.delete(rememberedDirect.keys().next().value!);
  rememberedDirect.set(deviceId, { address: address.address, port: address.port, localIp });
}
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
  return socket.canConnectSession(peer) ? 'online' : 'offline';
}
export function mobileAgentNetPeerRoute(peer: string): { path: 'direct' | 'relay' | null; rttMs: number | null } {
  const socket = live();
  return { path: socket?.pathTo(peer) ?? null, rttMs: socket?.peerSnapshot(peer)?.rttMs ?? null };
}
export function mobileAgentNetPeerConnectedAt(peer: string): number | null { return peerConnectedAt.get(peer) ?? null; }
/**
 * The phone changed networks: connections send from the new address now and candidates are gathered again. `routeChanged`
 * (Wi-Fi ↔ cellular, lost and back) also replaces the relay connection, which may sit half-open on the old route.
 */
export function notifyMobileAgentNetNetworkChanged(options?: { routeChanged?: boolean }): void {
  if (options?.routeChanged) {
    rememberedDirect.clear();
    lastKnownLocalIp = null;
  }
  const socket = live();
  if (options?.routeChanged) socket?.replaceRelayConnection(); else socket?.networkChanged();
}

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
    && !mobileAgentNetIdentityRefused()
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
  refusedSelection = null;
  const previous = current; current = null;
  previous?.socket.close();
  peerConnectedAt.clear();
  rememberedDirect.clear();
  lastKnownLocalIp = null;
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
  const scopeCurrent = () => attempt === openAttempt && isMobileAuthOwnerCurrent(owner)
    && getSelfHostedRelayRouteGeneration() === route
    && getMobileAgentNetPreferences().generation === preferences.generation;
  const guard = () => {
    if (!scopeCurrent() || !isMobileAgentNetActive()) {
      throw new Error('AGENT_NET_OWNER_CHANGED');
    }
  };
  guard();
  // Read again on every network change, for this phone's candidates (NativeTransport.networkChanged).
  const addresses = async (): Promise<string[]> => {
    try {
      const address = await Network.getIpAddressAsync();
      const valid = address && address !== '0.0.0.0' ? address : null;
      if (attempt === openAttempt) lastKnownLocalIp = valid;
      return valid ? [valid] : [];
    } catch { return []; /* Relay remains available without a local candidate. */ }
  };
  const official = preferences.enabled && !getActiveSelfHostedRelay();
  let membershipReady: Promise<void> = Promise.resolve();
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
      membershipReady = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([membership.prime(), new Promise<void>(resolve => { timer = setTimeout(resolve, 3_000); })]);
        } finally { clearTimeout(timer); }
      })();
    }
  }
  const initialIpsPromise = preferences.enabled ? addresses() : Promise.resolve<string[]>([]);
  let identity: Awaited<ReturnType<typeof ensureMobileAgentNetIdentity>>;
  try {
    identity = await ensureMobileAgentNetIdentity(options); guard();
  } catch (error) {
    guard();
    if (official && mobileAgentNetRequiresEncryption()
      && (error as { code?: unknown } | null)?.code === 'DEVICE_REVOKED') {
      throw new DeviceLinkRegistrationRemovedError();
    }
    if (isMobileIdentityRefusal(error) && noteMobileIdentityRefused()) throw new Error('AGENT_NET_IDENTITY_REFUSED');
    throw error;
  }
  const enginePromise = identity.newTransportEngine(guard, preferences.enabled);
  enginePromise.catch(() => undefined);
  let cached: Awaited<ReturnType<typeof readMobileAgentNetDirectory>>;
  let engine: MobileAgentNetEngine;
  let initialIps: string[];
  try {
    [cached, engine, initialIps] = await Promise.all([
      readMobileAgentNetDirectory(identity),
      enginePromise,
      initialIpsPromise,
      membershipReady,
    ]);
    guard();
  } catch (error) {
    void enginePromise.then(created => created.destroy()).catch(() => undefined);
    throw error;
  }
  const cachedDirectory = [...(cached?.devices ?? [])];
  // Match Desktop's offline startup: our validated local certificate keeps the
  // node alive for V1 compatibility, without authorizing any unknown remote peer
  // or extending the cached directory's original validity window.
  if (!cachedDirectory.some(view => view.certificate.deviceId === identity.api.identity.deviceId)) {
    cachedDirectory.push({ certificate: identity.api.certificate, name: '', online: false, remoteControlEnabled: false, capabilities: [] });
  }
  const localIp = initialIps[0] ?? null;
  const initialCandidates = new Map<string, { address: string; port: number }>();
  if (preferences.enabled && cached?.devices.length) {
    const cachedIds = new Set(cached.devices.map(view => view.certificate.deviceId));
    for (const [deviceId, item] of rememberedDirect) {
      if (deviceId === identity.api.identity.deviceId || !cachedIds.has(deviceId)) continue;
      if (isPrivateAddress(item.address) && (!localIp || item.localIp !== localIp)) continue;
      initialCandidates.set(deviceId, { address: item.address, port: item.port });
    }
  }
  let firstAddressRead = true;
  const readAddresses = async (): Promise<string[]> => {
    if (firstAddressRead) { firstAddressRead = false; return initialIps; }
    return addresses();
  };
  const connectedDuringOpen = new Map<string, number>();
  let openingDirectory = cachedDirectory.map(view => ({ deviceId: view.certificate.deviceId, online: false }));
  try {
    const socket = await AgentNetSocket.openWithBindings({
      client: identity.api, assertCurrent: guard, userId: owner.accountId,
      cachedDirectory, directoryExpiresAt: cached?.expiresAt,
      ...(initialCandidates.size > 0 ? { initialCandidates, deferRelay: true } : {}),
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
        if (attempt !== openAttempt) return;
        const target = current?.guard === guard ? peerConnectedAt : connectedDuringOpen;
        if (path) target.set(deviceId, performance.now()); else target.delete(deviceId);
      },
      onDirectAddress: (deviceId, address) => {
        if (attempt !== openAttempt) return;
        rememberDirectAddress(deviceId, address, lastKnownLocalIp);
      },
      onIdentityRefused: () => scopeCurrent() && noteMobileIdentityRefused(),
      bindings: {
        verifyCertificate: verifyMobileAgentNetCertificate,
        verifyDelegation: verifyMobileAgentNetDelegation,
        notify: (recipient, payload, signal) => sendMobileAgentNetNotification(identity, recipient, payload, signal, guard),
        createTransport: async transportOptions => {
          const base = identity.api.base;
          const cachedRelay = base && preferences.enabled ? relayInfo.get(base) : undefined;
          const knownServer = cachedRelay && Date.now() < cachedRelay.nextReadAt && cachedRelay.server ? cachedRelay.server : undefined;
          const transport = await NativeTransport.create(
            engine,
            knownServer ? { ...transportOptions, relayUdpServer: knownServer } : transportOptions,
            readAddresses,
            preferences.enabled,
          );
          const udp = preferences.enabled && (transport.supports('stun') || transport.supports('relay-udp-v2'));
          const privateNetwork = preferences.enabled && identity.api.certificate.networkId.startsWith('private:');
          if (base && (udp || privateNetwork)) {
            // The existing WebSocket/direct connection can start while the optional lookup runs.
            void readRelayInfo(base).then(info => {
              guard();
              if (privateNetwork) setMobileAgentNetPrivateSharingSupport(base, identity.api.rootPublicKey, info.privateSharing);
              if (udp && info.server && info.server !== knownServer) return transport.configureUdpServer(info.server);
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
    for (const [id, at] of connectedDuringOpen) peerConnectedAt.set(id, at);
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
    if ((!mobileAgentNetRequiresEncryption() || official) && typeof identity.api.directory === 'function') {
      // On React Native / server.ts `!active(principal)` (`socket.destroy()`), a revoked identity fails the WS upgrade as a
      // generic socket error and `cachedDirectory` keeps `openWithBindings` alive, hiding Device Link's 4410 removal state or
      // stranding a re-signed-in phone. Confirm once via `/directory` only when the initial WS relay attempt failed without an
      // explicit 401/403 status (explicit 401/403/4410 refusals are already converted to 1006 by `onIdentityRefused` above).
      void (socket.whenInitialRelaySettled?.() ?? Promise.resolve()).then(async () => {
        if (!scopeCurrent() || current?.socket !== socket || mobileAgentNetIdentityRefused() || socket.relayConnected?.() !== false) return;
        try { await identity.api.directory!(); }
        catch (error) {
          if (!scopeCurrent() || current?.socket !== socket || !isMobileIdentityRefusal(error)) return;
          if (noteMobileIdentityRefused()) socket.close(1006);
          else if (official && (error as { code?: unknown } | null)?.code === 'DEVICE_REVOKED') socket.close(4410);
        }
      });
    }
    return socket;
  } catch (error) {
    await engine.destroy();
    if (isMobileIdentityRefusal(error)) noteMobileIdentityRefused();
    throw error;
  }
}
