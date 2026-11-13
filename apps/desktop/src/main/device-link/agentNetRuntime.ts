import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, randomUUID } from 'node:crypto';
import { app } from 'electron';
import WebSocket from 'ws';
import { AgentNetWorkerSocket, type AgentNetAppSocket } from '@cindy/agent-net';
import { approveJoin, identityFromSeed, issueCertificate, publicBytes, signTenantJoinRequest, verifyCertificate, type Bootstrap, type Identity, type JoinRequest, type DeviceCertificate, type TenantJoinRequest } from '@cindy/agent-net-relay';
import { AgentNetClient, createDelegationApprover, createTransportModeProof, verifyTransportModeProof } from '@cindy/agent-net-relay/client';
import { CERT_LIFETIME_MS, agentNetStunServer, type DeviceView } from '@cindy/agent-net-protocol';
import { createOutboundHttpAgent, outboundFetch } from '../maker-host/outbound-fetch.desktop.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { readDeviceLinkSettings } from './settings-store.desktop.js';
import { activeSelfHostedRelay, isAgentNetOnlyRelay } from './selfHostedRelayRouting.js';
import { readRelaySecrets, writeRelaySecrets, relayDataPath, readRelayConfig } from './selfHostedRelayConfig.js';
import * as authManager from '../authManager.js';
import { currentOfficialAgentNetClient, ensureOfficialAgentNetClient, officialAgentNetBase, officialAgentNetSlot, outgoingOfficialAgentNetClient } from './agentNetOfficial.js';
import { deviceName } from './deviceName.js';
import { authorizeAgentNetSharingRequest, prepareAgentNetSharingPrimary } from './agentNetSharingPolicy.js';

let current: AgentNetAppSocket | null = null;
let socketAttempt = 0;
let coreModule: Promise<WebAssembly.Module> | null = null;
function rootKey(seed: string) {
  const bytes = Buffer.from(seed, 'base64url');
  if (bytes.length !== 32) throw new Error('INVALID_AGENT_NET_ROOT_KEY');
  return createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), bytes]), format: 'der', type: 'pkcs8' });
}
function initialIdentity(relayId: string, seed: string, deviceId: string): Identity {
  return identityFromSeed(relayId, seed, deviceId);
}
function decodeIdentity(value: NonNullable<ReturnType<typeof readRelaySecrets>>): Identity {
  const stored = value.agentNet;
  if (!stored || stored.version !== 2) throw new Error('INVALID_AGENT_NET_IDENTITY');
  const signingPrivateKey = createPrivateKey(stored.signingPrivateKey), transportPrivateKey = createPrivateKey(stored.transportPrivateKey);
  if (signingPrivateKey.asymmetricKeyType !== 'ed25519' || transportPrivateKey.asymmetricKeyType !== 'x25519') throw new Error('INVALID_AGENT_NET_IDENTITY');
  return { deviceId: stored.certificate.deviceId, signingPrivateKey, transportPrivateKey,
    signingKey: publicBytes(signingPrivateKey), transportKey: publicBytes(transportPrivateKey) };
}
export function memberAgentNetIdentity(relayId: string, seed: string, deviceId: string): Identity {
  const identity = initialIdentity(relayId, seed, deviceId);
  // Keep the already paired V1 signing key as the binding between the two independently verified requests.
  identity.signingPrivateKey = rootKey(seed); identity.signingKey = publicBytes(identity.signingPrivateKey);
  return identity;
}
export function memberAgentNetSecrets(identity: Identity, certificate: DeviceCertificate, rootPublicKey: string) {
  if (!verifyCertificate(rootPublicKey, certificate) || certificate.deviceId !== identity.deviceId
    || certificate.signingKey !== identity.signingKey || certificate.transportKey !== identity.transportKey) throw new Error('AGENT_NET_IDENTITY_MISMATCH');
  return { version: 2 as const, signingPrivateKey: String(identity.signingPrivateKey.export({ type: 'pkcs8', format: 'pem' })),
    transportPrivateKey: String(identity.transportPrivateKey.export({ type: 'pkcs8', format: 'pem' })), certificate, rootPublicKey };
}
export function approveAgentNetMember(relayId: string, request: JoinRequest, secret: string): DeviceCertificate {
  const stored = readRelaySecrets(relayId), subject = authManager.getCurrentUserId();
  if (!stored || !subject || request.networkId !== 'private:' + relayId || isAppSessionBoundaryPending()) throw new Error('AGENT_NET_OWNER_NOT_READY');
  return approveJoin(rootKey(stored.seed), request, secret, subject);
}
/** Root stays in the existing safeStorage vault; a relay receives only this public bootstrap. */
export function ensureOwnerAgentNetBootstrap(relayId: string, name: string): Bootstrap {
  const secrets = readRelaySecrets(relayId);
  const subject = authManager.getCurrentUserId();
  if (!secrets || !subject || isAppSessionBoundaryPending()) throw new Error('AGENT_NET_OWNER_NOT_READY');
  const root = rootKey(secrets.seed), rootPublicKey = publicBytes(root);
  const identity = secrets.agentNet ? decodeIdentity(secrets) : initialIdentity(relayId, secrets.seed, authManager.getDeviceId());
  const networkId = 'private:' + relayId;
  const old = secrets.agentNet?.certificate;
  if (old && (old.role !== 'owner' || old.networkId !== networkId || old.subject !== subject || old.deviceId !== authManager.getDeviceId()
    || old.signingKey !== identity.signingKey || old.transportKey !== identity.transportKey
    || secrets.agentNet!.rootPublicKey !== rootPublicKey || !verifyCertificate(rootPublicKey, old, old.issuedAt))) throw new Error('AGENT_NET_IDENTITY_MISMATCH');
  const certificate = old && old.expiresAt - Date.now() > 24 * 60 * 60 * 1000 ? old
    : issueCertificate(root, { networkId, subject, identity, role: 'owner' });
  if (!old || certificate !== old) writeRelaySecrets(relayId, { ...secrets, agentNet: {
    version: 2, signingPrivateKey: String(identity.signingPrivateKey.export({ type: 'pkcs8', format: 'pem' })),
    transportPrivateKey: String(identity.transportPrivateKey.export({ type: 'pkcs8', format: 'pem' })), certificate, rootPublicKey,
  } });
  return { networkId, name, rootPublicKey, ownerCertificate: certificate };
}
/**
 * 别人分享的中转(self-hosted-relay-plan.md §5.5):本账号在上面建自己的网络。根密钥与主人证书只在本机安全存储,
 * 中转只拿到公开的 bootstrap;配对证明用分享链接里的秘密,分享者电脑据此确认申请没被中转换掉。
 */
export function createAgentNetTenantRequest(networkUuid: string, seed: string, input: { name: string; accountName: string; inviteCode: string; pairingSecret: string }): TenantJoinRequest {
  const subject = authManager.getCurrentUserId();
  if (!subject || isAppSessionBoundaryPending()) throw new Error('AGENT_NET_OWNER_NOT_READY');
  const root = rootKey(seed), identity = initialIdentity(networkUuid, seed, authManager.getDeviceId());
  const certificate = issueCertificate(root, { networkId: 'private:' + networkUuid, subject, identity, role: 'owner' });
  // 没有旧版凭证:这个网络只走 V2。
  writeRelaySecrets(networkUuid, { credential: '', seed, agentNet: {
    version: 2, signingPrivateKey: String(identity.signingPrivateKey.export({ type: 'pkcs8', format: 'pem' })),
    transportPrivateKey: String(identity.transportPrivateKey.export({ type: 'pkcs8', format: 'pem' })), certificate, rootPublicKey: publicBytes(root),
  } });
  const bootstrap = ensureOwnerAgentNetBootstrap(networkUuid, input.name);
  return signTenantJoinRequest({ requestId: randomUUID(), inviteCode: input.inviteCode, bootstrap,
    accountName: input.accountName, deviceName: deviceName().trim().slice(0, 64) || 'Cindy' }, input.pairingSecret);
}
export function isAgentNetActive(): boolean {
  if (isAppSessionBoundaryPending()) return false;
  const relay = activeSelfHostedRelay();
  // 只走 V2 的网络(别人分享的中转)不看「新版连接」开关:没有旧版可退。
  if (isAgentNetOnlyRelay(relay)) return !!readRelaySecrets(relay!.relayId)?.agentNet;
  return readDeviceLinkSettings().agentNetEnabled === true
    && (relay ? !!readRelaySecrets(relay.relayId)?.agentNet : !!officialAgentNetBase());
}
export function agentNetSupportsPeer(id: string): boolean { return current?.supports(id) ?? false; }
export function agentNetRequiresEncryption(): boolean {
  if (isAgentNetOnlyRelay(activeSelfHostedRelay())) return true;
  const settings = readDeviceLinkSettings();
  return settings.agentNetEnabled === true && settings.agentNetOnlyEncrypted === true;
}
export function agentNetSelectionKey(): string {
  const relay = activeSelfHostedRelay(), settings = readDeviceLinkSettings();
  return JSON.stringify([relay?.relayId ?? null, relay?.baseUrl ?? officialAgentNetBase(), relay?.ownerPublicKey ?? null,
    settings.agentNetEnabled === true, settings.agentNetOnlyEncrypted === true]);
}
export function agentNetAllowsLegacy(): boolean { return !agentNetRequiresEncryption(); }
/** The user's own 「仅使用 Agent-Net」switch (not a V2-only relay someone shared with this account). */
export function agentNetOnlyEncryptedByUser(): boolean {
  const settings = readDeviceLinkSettings();
  return settings.agentNetEnabled === true && settings.agentNetOnlyEncrypted === true;
}
export async function createAgentNetOrLegacySocket<T>(
  legacy: () => T | Promise<T>,
  onTransport?: (encrypted: boolean) => void,
): Promise<AgentNetAppSocket | T> {
  const encrypted = await createAgentNetAppSocket();
  if (encrypted) { onTransport?.(true); return encrypted; }
  if (agentNetRequiresEncryption()) throw new Error('AGENT_NET_ENCRYPTED_IDENTITY_REQUIRED');
  const socket = await legacy();
  onTransport?.(false);
  return socket;
}
export function agentNetShouldUseLegacyPeer(id: string): boolean { return current?.knowsPeer(id) === false; }
export function agentNetShouldProbeLegacyPeer(id: string): boolean { return !!current?.knowsPeer(id) && !current.supports(id); }
export function agentNetPeerSnapshot(id: string) { return current?.peerSnapshot(id) ?? null; }
export function currentAgentNetScopedTarget(peer: string) { return current?.scopedPeerTarget(peer) ?? null; }
export function agentNetMediaTarget(peer: string) {
  if (!current?.knowsPeer(peer)) return null;
  const api = currentAgentNetClient(), certificate = current.certificateFor(peer);
  if (!api || !certificate || !verifyCertificate(api.rootPublicKey, certificate)) throw new Error('AGENT_NET_MEDIA_PEER_UNAVAILABLE');
  return { api, recipient: peer, transportKey: certificate.transportKey, slot: activeSelfHostedRelay()?.relayId ?? officialAgentNetSlot() };
}
/** Only locally registered origins may be selected by a media reference; the key never supplies a URL. */
export function agentNetClientForMediaSlot(slot: string, networkId: string): AgentNetClient | null {
  if (isAppSessionBoundaryPending()) return null;
  let api: AgentNetClient | null = null;
  if (officialAgentNetBase() && slot === officialAgentNetSlot()) api = currentOfficialAgentNetClient();
  else {
    const config = readRelayConfig();
    const route = [config.active, ...config.deployments].find((entry) => entry?.relayId === slot);
    if (route) {
      api = agentNetClientForRelay(slot, route.baseUrl);
      if (api.rootPublicKey !== route.ownerPublicKey) throw new Error('AGENT_NET_IDENTITY_MISMATCH');
    } else if (config.host.relayId === slot && readRelaySecrets(slot)?.agentNet) {
      api = agentNetClientForRelay(slot, `http://127.0.0.1:${config.host.port}`);
    }
  }
  return api?.certificate.networkId === networkId ? api : null;
}
/** A V1 relay cannot forge whether a certified V2 device opted out of encryption. */
export function agentNetTransportAttestation(peer: string, requestId: string): unknown {
  try {
    const relay = activeSelfHostedRelay();
    const api = relay && readRelaySecrets(relay.relayId)?.agentNet ? agentNetClientForRelay(relay.relayId, relay.baseUrl) : currentOfficialAgentNetClient();
    return api ? createTransportModeProof(api.identity, peer, requestId, isAgentNetActive()) : undefined;
  } catch { return undefined; }
}
export function verifyAgentNetTransportAttestation(peer: string, requestId: string, proof: unknown): boolean {
  if (!current?.knowsPeer(peer)) return true;
  try {
    const certificate = current.certificateFor(peer), api = currentAgentNetClient();
    return !!certificate && !!api && verifyCertificate(api.rootPublicKey, certificate)
      && verifyTransportModeProof(certificate, current.deviceId, requestId, proof);
  } catch { return false; }
}
export function agentNetPrefersPrimary(payload: unknown): boolean {
  const value = payload as { capabilities?: string[]; transportAttestation?: { enabled?: unknown } } | null;
  const mode = value?.transportAttestation?.enabled;
  return typeof mode === 'boolean' ? mode : value?.capabilities?.includes('agent-net-node-v2') === true;
}
export function agentNetClientForRelay(relayId: string, baseUrl: string): AgentNetClient {
  if (isAppSessionBoundaryPending()) throw new Error('AGENT_NET_IDENTITY_MISMATCH');
  return outgoingAgentNetClientForRelay(relayId, baseUrl);
}
/** Account-handover close only: the boundary is pending but the outgoing owner
 * has not been replaced yet. The caller must verify the outgoing scope is still
 * current and capture the client synchronously, before the owner commit. */
export function outgoingAgentNetClientForRelay(relayId: string, baseUrl: string): AgentNetClient {
  const secrets = readRelaySecrets(relayId), stored = secrets?.agentNet;
  if (!secrets || !stored || stored.certificate.subject !== authManager.getCurrentUserId()
    || stored.certificate.networkId !== 'private:' + relayId) throw new Error('AGENT_NET_IDENTITY_MISMATCH');
  return new AgentNetClient(baseUrl, decodeIdentity(secrets), stored.certificate, stored.rootPublicKey, undefined, {
    ownerPinnedHttp: true, fetch: outboundFetch,
    createWebSocket: async (url, options) => new WebSocket(url, { ...options, agent: await createOutboundHttpAgent(url) }),
  });
}
export function currentAgentNetClient(): AgentNetClient | null {
  const relay = activeSelfHostedRelay();
  if (!isAgentNetActive()) return null;
  if (!relay) return currentOfficialAgentNetClient();
  let secrets = readRelaySecrets(relay.relayId)!;
  if (relay.role === 'owner') {
    ensureOwnerAgentNetBootstrap(relay.relayId, relay.name); secrets = readRelaySecrets(relay.relayId)!;
  }
  const stored = secrets.agentNet!;
  if (stored.rootPublicKey !== relay.ownerPublicKey || stored.certificate.networkId !== 'private:' + relay.relayId
    || stored.certificate.deviceId !== relay.deviceId) throw new Error('AGENT_NET_IDENTITY_MISMATCH');
  return outgoingAgentNetClientForRelay(relay.relayId, relay.baseUrl);
}
/** The selected network's client for the outgoing owner while the account
 * boundary is pending. Read-only: never bootstraps or writes identity. */
export function outgoingAgentNetClient(): AgentNetClient | null {
  const relay = activeSelfHostedRelay();
  if (!relay) return outgoingOfficialAgentNetClient();
  const stored = readRelaySecrets(relay.relayId)?.agentNet;
  if (!stored || stored.rootPublicKey !== relay.ownerPublicKey || stored.certificate.networkId !== 'private:' + relay.relayId
    || stored.certificate.deviceId !== relay.deviceId) return null;
  return outgoingAgentNetClientForRelay(relay.relayId, relay.baseUrl);
}
async function loadCore(): Promise<WebAssembly.Module> {
  if (coreModule) return coreModule;
  coreModule = (async () => {
    const base = app.getAppPath();
    const candidates = [path.join(process.resourcesPath ?? '', 'agent-net', 'core.wasm'),
      path.join(base, 'resources', 'agent-net', 'core.wasm'), path.join(base, '..', '..', 'packages', 'agent-net-core', 'dist', 'core.wasm')];
    for (const file of candidates) {
      try { return await WebAssembly.compile(await fs.promises.readFile(file)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    throw new Error('AGENT_NET_CORE_BUNDLE_MISSING');
  })().catch((error) => { coreModule = null; throw error; });
  return coreModule;
}
/** Resource-only sockets do not replace the main topology/presence connection.
 * DeviceLink's routing owner closes them on resource/account disposal. */
export async function openScopedAgentNetAppSocket(api: AgentNetClient, assertCurrent: () => void): Promise<AgentNetAppSocket> {
  assertCurrent();
  const module = await loadCore(); assertCurrent();
  const workerFile = [path.join(process.resourcesPath ?? '', 'agent-net', 'node-worker.mjs'),
    path.join(app.getAppPath(), 'resources', 'agent-net', 'node-worker.mjs'),
    path.join(app.getAppPath(), '..', '..', 'packages', 'agent-net', 'dist', 'node-worker.mjs')].find(file => fs.existsSync(file));
  if (!workerFile) throw new Error('AGENT_NET_WORKER_BUNDLE_MISSING');
  const approver = api.delegation ? null : createDelegationApprover(api, assertCurrent, authorizeAgentNetSharingRequest);
  try {
    const socket = await AgentNetWorkerSocket.open({ workerFile, client: api, assertCurrent, module,
      userId: authManager.getCurrentUserId() ?? '', scoped: true,
      onDelegationRequests: requests => approver?.update(requests) });
    try { assertCurrent(); } catch (error) { socket.close(); throw error; }
    socket.once('close', () => approver?.close()); return socket;
  } catch (error) { approver?.close(); throw error; }
}
export async function createAgentNetAppSocket(): Promise<AgentNetAppSocket | null> {
  if (!isAgentNetActive()) return null;
  const attempt = ++socketAttempt;
  const scope = activeOwnerScopeKey();
  const selection = agentNetSelectionKey();
  const assertOwner = () => { if (scope !== activeOwnerScopeKey() || isAppSessionBoundaryPending() || selection !== agentNetSelectionKey()) throw new Error('AGENT_NET_OWNER_CHANGED'); };
  const relay = activeSelfHostedRelay();
  const api = relay ? currentAgentNetClient() : await ensureOfficialAgentNetClient(deviceName());
  assertOwner(); if (!api) return null;
  prepareAgentNetSharingPrimary(api); assertOwner();
  const directoryFile = relayDataPath('agent-net', relay?.relayId ?? officialAgentNetSlot(), 'directory.json');
  let cachedDirectory: DeviceView[] = [];
  let directoryExpiresAt = 0;
  try {
    const stat = await fs.promises.stat(directoryFile); assertOwner();
    if (stat.size > 2 * 1024 * 1024) throw new SyntaxError('INVALID_AGENT_NET_CACHE');
    const value: unknown = JSON.parse(await fs.promises.readFile(directoryFile, 'utf8')); assertOwner();
    const cached = value as { version?: unknown; receivedAt?: unknown; devices?: unknown };
    // Accept the original public-array cache once, without extending its old receipt time.
    const receivedAt = Array.isArray(value) ? stat.mtimeMs : cached?.version === 1 ? cached.receivedAt : null;
    const devices = Array.isArray(value) ? value : cached?.devices;
    if (typeof receivedAt === 'number' && Number.isFinite(receivedAt) && receivedAt <= Date.now() + 30_000 && Array.isArray(devices)) {
      cachedDirectory = devices.slice(0, 256); directoryExpiresAt = receivedAt + CERT_LIFETIME_MS;
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  // A temporary relay outage must still let the local node start and retain its V1 compatibility path.
  // This adds only our own already validated certificate, never an unverified remote identity.
  if (!cachedDirectory.some((entry) => entry?.certificate?.deviceId === api.identity.deviceId)) {
    cachedDirectory.push({ certificate: api.certificate, name: '', online: false, remoteControlEnabled: false, capabilities: [] });
  }
  const module = await loadCore(); assertOwner();
  const stunServers: string[] = [];
  try {
    const response = await outboundFetch(api.base + '/api/agent-net/info', { signal: AbortSignal.timeout(5000) });
    const info: unknown = await response.json(); assertOwner();
    // UDP may be published on its own host (e.g. NLB beside an HTTPS ALB); relays without one keep the API host.
    const server = response.ok ? agentNetStunServer(api.base, info) : null;
    if (server) stunServers.push(server);
  } catch { assertOwner(); }
  const workerFile = [path.join(process.resourcesPath ?? '', 'agent-net', 'node-worker.mjs'),
    path.join(app.getAppPath(), 'resources', 'agent-net', 'node-worker.mjs'),
    path.join(app.getAppPath(), '..', '..', 'packages', 'agent-net', 'dist', 'node-worker.mjs')].find((file) => fs.existsSync(file));
  if (!workerFile) throw new Error('AGENT_NET_WORKER_BUNDLE_MISSING');
  let approver = createDelegationApprover(api, assertOwner, authorizeAgentNetSharingRequest);
  let socket: AgentNetAppSocket;
  try { socket = await AgentNetWorkerSocket.open({ workerFile, assertCurrent: assertOwner, client: api, module, userId: api.certificate.subject, cachedDirectory, directoryExpiresAt, stunServers,
    scoped: true, onDelegationRequests: requests => approver.update(requests),
    onDirectory(directory) {
      assertOwner();
      const temporary = directoryFile + '.' + randomUUID() + '.tmp';
      try {
        fs.mkdirSync(path.dirname(directoryFile), { recursive: true, mode: 0o700 });
        fs.writeFileSync(temporary, JSON.stringify({ version: 1, receivedAt: Date.now(), devices: directory }), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, directoryFile);
      } catch {
        // A read-only/full cache volume must not tear down an already authenticated live connection.
        // The owner-scope check above still fails closed; only this optional public cache is best effort.
        try { fs.rmSync(temporary, { force: true }); } catch { /* A leftover contains public certificates only. */ }
      }
    },
  }); } catch (error) { approver.close(); throw error; }
  socket.once('close', () => approver.close());
  try {
    assertOwner();
    if (attempt !== socketAttempt) throw new Error('AGENT_NET_CONNECTION_SUPERSEDED');
  } catch (error) { socket.close(); throw error; }
  const previous = current; current = socket; previous?.close();
  let renewal: ReturnType<typeof setTimeout> | undefined;
  let activeCertificate = api.certificate.signature;
  const scheduleRenewal = (expiresAt: number, retry = false) => {
    renewal = setTimeout(() => {
      if (current !== socket) return;
      try { assertOwner(); if (activeSelfHostedRelay() || !isAgentNetActive()) return; }
      catch { return; }
      void ensureOfficialAgentNetClient(deviceName()).then(async (next) => {
        assertOwner(); if (current !== socket) return;
        if (next.certificate.signature !== activeCertificate) {
          await socket.replaceClient(next);
          approver.close(); approver = createDelegationApprover(next, assertOwner, authorizeAgentNetSharingRequest);
          activeCertificate = next.certificate.signature;
        }
        scheduleRenewal(next.certificate.expiresAt);
      }).catch(() => { if (current === socket) scheduleRenewal(expiresAt, true); });
    }, retry ? 60_000 : Math.max(60_000, expiresAt - Date.now() - 24 * 60 * 60_000));
    renewal.unref();
  };
  if (!relay) scheduleRenewal(api.certificate.expiresAt);
  socket.once('close', () => { if (renewal) clearTimeout(renewal); if (current === socket) current = null; });
  return socket;
}
