import * as Network from 'expo-network';
import { AppState } from 'react-native';
import { AgentNetSocket, NativeTransport } from '@cindy/agent-net/portable';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { getOfficialAgentNetApiBaseUrl } from '@/config/env';
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
import { mobileAgentNetSharingMediaTarget } from './agentNetSharing';
import { isScopedPeer } from '@cindy/device-link';

let current: { socket: AgentNetSocket; guard(): void } | null = null;
let openAttempt = 0;
function live(): AgentNetSocket | null {
  try { current?.guard(); return current?.socket ?? null; } catch { return null; }
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
  let addresses: string[] = [];
  try { const address = await Network.getIpAddressAsync(); if (address && address !== '0.0.0.0') addresses = [address]; }
  catch { /* Relay remains available without a local candidate. */ }
  guard();
  const engine = await identity.newTransportEngine(guard);
  try {
    const socket = await AgentNetSocket.openWithBindings({
      client: identity.api, assertCurrent: guard, userId: owner.accountId,
      cachedDirectory, directoryExpiresAt: cached?.expiresAt,
      onDirectory: devices => {
        void writeMobileAgentNetDirectory(identity, devices).catch(() => undefined);
        updateMobileAgentNetNotificationTrust(identity, devices, guard);
      },
      bindings: {
        verifyCertificate: verifyMobileAgentNetCertificate,
        verifyDelegation: verifyMobileAgentNetDelegation,
        notify: (recipient, payload, signal) => sendMobileAgentNetNotification(identity, recipient, payload, signal, guard),
        createTransport: transport => NativeTransport.create(engine, transport, addresses),
        createDiscovery: discovery => mobileAgentNetDiscovery(discovery, identity.signer, guard,
          () => currentMobileAgentNetIdentity()?.signer ?? identity.signer),
      },
    });
    try { guard(); } catch (error) { socket.close(); throw error; }
    const previous = current; current = { socket, guard };
    previous?.socket.close();
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
    socket.once('close', () => { if (renewal) clearTimeout(renewal); foreground.remove(); if (current?.socket === socket) current = null; });
    return socket;
  } catch (error) { await engine.destroy(); throw error; }
}
