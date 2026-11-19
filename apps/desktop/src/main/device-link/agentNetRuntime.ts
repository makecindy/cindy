import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, randomUUID } from 'node:crypto';
import { app } from 'electron';
import WebSocket from 'ws';
import { AgentNetWorkerSocket, type AgentNetAppSocket, type RelayRoute, type SessionConfig, type SessionHandle } from '@cindy/agent-net';
import { isScopedPeer } from '@cindy/device-link';
import { approveJoin, identityFromSeed, issueCertificate, publicBytes, signTenantJoinRequest, verifyCertificate, type Bootstrap, type Identity, type JoinRequest, type DeviceCertificate, type TenantJoinRequest } from '@cindy/agent-net-relay';
import { AgentNetClient, createDelegationApprover, createTransportModeProof } from '@cindy/agent-net-relay/client';
import { CERT_LIFETIME_MS, agentNetStunServer, type DeviceView } from '@cindy/agent-net-protocol';
import { createOutboundHttpAgent, outboundFetch } from '../maker-host/outbound-fetch.desktop.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { readDeviceLinkSettings } from './settings-store.desktop.js';
import { activeSelfHostedRelay, isAgentNetOnlyRelay } from './selfHostedRelayRouting.js';
import { readRelaySecrets, writeRelaySecrets, relayDataPath, readRelayConfig } from './selfHostedRelayConfig.js';
import * as authManager from '../authManager.js';
import { currentOfficialAgentNetClient, ensureOfficialAgentNetClient, officialAgentNetBase, officialAgentNetSlot, officialAgentNetStatementIdentity, outgoingOfficialAgentNetClient } from './agentNetOfficial.js';
import { acceptTransportStatement } from './agentNetTransportStatement.js';
import { deviceName } from './deviceName.js';
import { authorizeAgentNetSharingRequest, prepareAgentNetSharingPrimary } from './agentNetSharingPolicy.js';
import { createLogger } from '../logger';
import { AgentNetMembership } from '@cindy/agent-net';
import { isMobilePlatform } from './controllerPlatform.js';
import { readAgentNetDirectoryCache, writeAgentNetDirectoryCache } from './agentNetDirectoryCache.js';

/** Relay connection lifecycle, keepalive and per-peer route changes (local log only). */
const agentNetLog = createLogger('agent-net');
let current: AgentNetWorkerSocket | null = null;
/**
 * 上一条主连接（关掉以后、新的连上之前）。只用来回答「这台设备是不是本账号的 Agent-Net 设备」：重连期间 current 为空，
 * 原来一律答「不是旧版设备」，只走 Device Link 的设备（没开 Agent-Net 的手机、旧版电脑）在中转连接好好的时候也连不上。
 */
let previousSocket: AgentNetAppSocket | null = null;
let sessionConfig: SessionConfig | null = null;
const privateSharingRoots = new Map<string, string>();
export function supportsPrivateAgentNetSharing(base: string, root: string): boolean { return privateSharingRoots.get(base) === root; }
/**
 * 每个 Agent-Net 服务上次取到的 UDP 地址（STUN 与经 UDP 的中转）。刚唤醒、刚换网时取中转信息常常失败，原来这条连接就一直没有
 * STUN 和 UDP 中转、只走 443 上的中转，直到下次重建（2026-11-17 审查）；失败时沿用上次的。服务明确说没有 UDP 时清掉。
 */
const lastUdpServer = new Map<string, string>();
/** 官方 Device Link 设备列表里的一台设备：设备号与它自报的平台。 */
export interface DeviceLinkListedDevice { deviceId: string; platform?: string | null }
/** 本账号 Device Link 设备列表的读取（deviceLinkApi.desktop.ts 装上）。 */
let deviceLinkDeviceList: (() => Promise<readonly DeviceLinkListedDevice[] | null>) | null = null;
/**
 * 最近一次读到的官方 Device Link 设备列表里的手机（含此刻离线、在后台的），按 membershipScope。Agent-Net 送不到的手机要经
 * Device Link 补发推送（notifyFallback.ts）；只看 presence 时，重连后还没上线过的手机（多数时候在后台）一份也收不到。
 */
let listedPhones: { scope: string; ids: readonly string[] } | null = null;
function noteListedPhones(scope: string, devices: readonly DeviceLinkListedDevice[]): void {
  listedPhones = { scope, ids: devices.filter((device) => isMobilePlatform(device.platform)).map((device) => device.deviceId) };
}
/** 官方 Agent-Net 上不认 Device Link 已删除的设备（packages/agent-net/src/membership.ts）；按账号与网络（membershipScope）各算各的。 */
const membership = new AgentNetMembership({
  readDeviceLinkDeviceIds: async () => {
    const scope = membershipScope;
    if (scope === null || scope !== officialMembershipScope()) return null;
    const devices = await (deviceLinkDeviceList?.() ?? Promise.resolve(null));
    if (!devices || scope !== membershipScope || scope !== officialMembershipScope()) return null;
    noteListedPhones(scope, devices);
    return devices.map((device) => device.deviceId);
  },
  apply: (rule) => { if (current && membershipScope !== null && membershipScope === officialMembershipScope()) current.restrictPeers?.(rule); },
  // Background reads only while this account's official Agent-Net connection is up (never with Agent-Net off).
  active: () => current !== null && membershipScope !== null && membershipScope === officialMembershipScope() && isAgentNetActive(),
  log: agentNetLog,
});
let membershipScope: string | null = null;
/** 官方 Agent-Net 才按 Device Link 设备列表拦设备；自建中转上删设备直接在 Agent-Net 上撤销。 */
function officialMembershipScope(): string | null {
  if (activeSelfHostedRelay() || isAppSessionBoundaryPending()) return null;
  const owner = activeOwnerScopeKey();
  return owner ? JSON.stringify([owner, agentNetSelectionKey()]) : null;
}
function currentMembership(): AgentNetMembership | null {
  const scope = officialMembershipScope();
  if (scope !== membershipScope) { membership.reset(); membershipScope = scope; }
  return scope ? membership : null;
}
/** 装上本账号 Device Link 设备列表的读取（官方服务，设备号与平台）。 */
export function useDeviceLinkDeviceList(read: () => Promise<readonly DeviceLinkListedDevice[] | null>): void { deviceLinkDeviceList = read; }
/** 刚读到的官方 Device Link 设备列表（设备列表界面、上线补名字），顺带用来判断哪些设备删掉了、有哪些手机。 */
export function agentNetNoteDeviceLinkDevices(devices: readonly DeviceLinkListedDevice[], startedAt: number): void {
  const members = currentMembership();
  if (!members || membershipScope === null) return;
  noteListedPhones(membershipScope, devices);
  members.noteDeviceList(devices.map((device) => device.deviceId), startedAt);
}
/** 本账号官方 Device Link 设备列表里的手机（最近一次读到的）；没读到过、自建中转上为空。 */
export function agentNetListedPhones(): readonly string[] {
  const scope = officialMembershipScope();
  return scope !== null && listedPhones?.scope === scope ? listedPhones.ids : [];
}
const relayListeners = new Set<() => void>();
const pathListeners = new Set<() => void>();
/** Agent-Net 握手和路径状态变化，供远程连接拓扑刷新。 */
export function onAgentNetPathChange(listener: () => void): () => void {
  pathListeners.add(listener);
  return () => { pathListeners.delete(listener); };
}
function pathChanged(): void {
  for (const listener of [...pathListeners]) {
    try { listener(); } catch (error) { agentNetLog.error('agent-net path listener threw', error); }
  }
}
/**
 * Agent-Net 主连接经中转的数据报现在怎么走：中转的 UDP 端口还是 WebSocket，以及这条路最近一次的往返毫秒数
 * （UDP 是登记到确认，WebSocket 是心跳）。没连着中转、不是 Agent-Net 主连接时为 null。远程连接页写在中转点上。
 */
export function agentNetRelayRoute(): RelayRoute | null { return current?.relayRoute() ?? null; }
/**
 * Agent-Net 主连接现在有没有连着中转；不是 Agent-Net 主连接（关着、还没连上）时为 null。连接本身还在、直连的对端照常，
 * 只是不直连的设备和手机推送暂时不通（Desktop 在连接状态里说明，index.ts）。
 */
export function agentNetRelayConnected(): boolean | null {
  return current?.relayConnected ? current.relayConnected() : null;
}
/** 上面的结论可能变了（中转连上、断开，经中转的数据报改走 UDP 或 WebSocket，主连接换了或关了）。 */
export function onAgentNetRelayChange(listener: () => void): () => void {
  relayListeners.add(listener);
  return () => { relayListeners.delete(listener); };
}
function relayChanged(): void {
  for (const listener of [...relayListeners]) {
    try { listener(); } catch (error) { agentNetLog.error('agent-net relay listener threw', error); }
  }
}
/** 这台电脑换了网络：Agent-Net 主连接马上探测中转、从新地址发包（AgentNetWorkerSocket.networkChanged）。Agent-Net 关着时什么也不做。 */
export function agentNetNetworkChanged(): void { current?.networkChanged?.(); }
/** 本机在官方 Device Link 里删掉了这台设备：Agent-Net 上马上不认它。 */
export function agentNetNoteDeviceRemoved(deviceId: string): void { currentMembership()?.noteRemoved(deviceId); }
/** 官方 Agent-Net 上认不认这台设备：Device Link 里删掉了、还没重新登录的不认（packages/agent-net/src/membership.ts）；自建中转上都认。 */
export function agentNetDeviceAccepted(deviceId: string): boolean {
  const rule = currentMembership()?.rule();
  return !rule || (!rule.refused.includes(deviceId) && (rule.allowed === null || rule.allowed.includes(deviceId)));
}
/** 资源专用连接（openScopedAgentNetAppSocket）：受邀者凭证上的连接，或本机在另一个网络上的分享资源。 */
const scopedSockets = new Set<AgentNetAppSocket>();
/**
 * 跨账号对端的会话该用哪条连接：它在 Device Link 那边登记的那条（agentNetSharing.ts 的 installRoute），
 * 会话只出现在原来分享帧会走的地方。'primary' 是主连接；null 是不用会话（停用、已退出、没登记）。
 */
let scopedSessionRoute: (peer: string) => AgentNetAppSocket | 'primary' | null = () => null;
export function setAgentNetScopedSessionRoute(route: (peer: string) => AgentNetAppSocket | 'primary' | null): void { scopedSessionRoute = route; }
function sessionSocket(peer: string): AgentNetAppSocket | null {
  if (!isScopedPeer(peer)) return current;
  let route: AgentNetAppSocket | 'primary' | null;
  try { route = scopedSessionRoute(peer); } catch { return null; }
  return route === 'primary' ? current : route && scopedSockets.has(route) ? route : null;
}
/**
 * 跨账号的会话交给业务之前先看归属：只认它登记的那条连接（sessionSocket），和 Device Link 只收登记连接上的分享帧一样；
 * 换了或撤了以后，别的连接上同名的会话收到什么都不交给业务。它断开时，只要它当过这个对端的会话，业务照样知道。
 * 同账号的会话只在主连接上（资源专用连接只开委托里的会话），原样交给业务。
 */
function sessionConfigFor(socket: AgentNetAppSocket, config: SessionConfig, delegatedOnly: boolean): SessionConfig {
  return { laneFor: config.laneFor, delegatedOnly, handlers: (key) => {
    const handlers = config.handlers(key);
    if (!isScopedPeer(key)) return handlers;
    const owns = () => sessionSocket(key) === socket;
    let owned = owns();
    const gate = <A extends unknown[], R>(handler: ((...args: A) => R) | undefined) => handler && ((...args: A) => {
      if (!owns()) return undefined;
      owned = true;
      return handler(...args);
    });
    return { onOpen: gate(handlers.onOpen), onClose: gate(handlers.onClose), onRequest: gate(handlers.onRequest),
      onPush: gate(handlers.onPush), onPresence: gate(handlers.onPresence),
      onBroken: handlers.onBroken && ((code: string) => { if (owned || owns()) handlers.onBroken!(code); }) };
  } };
}
/**
 * Agent-Net 会话层（docs/agent-net-session-plan.md 第 10.1 节；index.ts 初始化时调用，跟着「Agent-Net (Beta)」开关生效）：
 * 当前和之后的主连接都启用会话；开关开着时，之后打开的资源专用连接也启用，只开委托里的会话（跨账号）。
 */
export function useAgentNetSessions(config: SessionConfig): void {
  sessionConfig = config;
  if (current) current.useSessions?.(sessionConfigFor(current, config, false));
}
/** 和这个对端的会话：同账号设备在主连接上，跨账号对端在它登记的连接上；没启用、连接不在、对端没启用会话时为 null。 */
export function agentNetSession(peer: string): SessionHandle | null { return sessionSocket(peer)?.session?.(peer) ?? null; }
/** 每条连接上和每个对端的那条连接建好（或换上）的时刻；会话层选路据此判断「刚连上、会话还在路上」。 */
const peerConnectedAt = new WeakMap<AgentNetAppSocket, Map<string, number>>();
/** 每条主连接上，本账号在 Agent-Net 上登记了推送（目录里有 notificationKey）的设备，随目录更新。 */
const notifyCoverage = new WeakMap<AgentNetAppSocket, Set<string>>();
/**
 * 能经 Agent-Net 收到推送的本账号设备；Agent-Net 不是主连接时为 null。没登记的手机（没开 Agent-Net、登记失败）收不到 Agent-Net 推送，
 * 要经 Device Link 补发（notifyFallback.ts）。
 */
export function agentNetNotifyCoverage(): ReadonlySet<string> | null {
  const covered = current ? notifyCoverage.get(current) ?? null : null;
  if (!covered) return null;
  // The socket sends pushes only to members it accepts: a phone the device-list rule refuses (removed, or new and not
  // listed yet) is not reached here, so it keeps its Device Link copy (notifyFallback.ts).
  const accepted = [...covered].filter((id) => agentNetDeviceAccepted(id));
  return accepted.length === covered.size ? covered : new Set(accepted);
}
/** 会话键对应的那条连接：同账号就是设备本身；跨账号是委托里的连接（会话在时问会话，还没有时按委托解析）。 */
function sessionDevice(socket: AgentNetAppSocket, peer: string): string | null {
  if (!isScopedPeer(peer)) return peer;
  try { return socket.sessionDevice?.(peer) ?? socket.scopedPeerTarget(peer)?.relayId ?? null; } catch { return null; }
}
export function agentNetPeerConnectedAt(peer: string): number | null {
  const socket = sessionSocket(peer), device = socket ? sessionDevice(socket, peer) : null;
  return socket && device ? peerConnectedAt.get(socket)?.get(device) ?? null : null;
}
export function agentNetPeerRoute(peer: string): { path: 'direct' | 'relay' | null; rttMs: number | null } {
  const socket = sessionSocket(peer);
  return { path: socket?.pathTo(peer) ?? null, rttMs: socket?.peerSnapshot(peer)?.rttMs ?? null };
}
/**
 * 第一次建链之前先连上对方电脑，让会话赶在第一条消息之前建好（PortableSocket.connectSession）：受邀者第一次用分享，
 * 或同账号的电脑此刻在线、连接还没建。
 */
export function connectAgentNetSessionPeer(peer: string): Promise<boolean> {
  return sessionSocket(peer)?.connectSession?.(peer) ?? Promise.resolve(false);
}
/**
 * 这个对端在本机 Agent-Net 上的状态（AgentNetSessionLinksOptions.agentNetPeer）。同步，用 worker 最近一次报的状态；
 * 本机关着 Agent-Net、同账号的它不在本账号的 Agent-Net 目录里、跨账号的它没有能开会话的连接时为 null。
 */
export function agentNetPeerState(peer: string): 'online' | 'offline' | null {
  // 跨账号：这个资源有能开会话的连接（它登记的分享连接，或还没登记时的主连接）且开着 Agent-Net。
  if (isScopedPeer(peer)) { try { return isAgentNetActive() && sessionSocket(peer) ? 'online' : null; } catch { return null; } }
  if (!current) return null;
  try {
    if (!isAgentNetActive() || !current.knowsPeer(peer)) return null;
    return current.supports(peer) ? 'online' : 'offline';
  } catch { return null; }
}
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
    && (relay ? !!readRelaySecrets(relay.relayId)?.agentNet : !!officialAgentNetBase())
    && !agentNetIdentityRefused();
}
/**
 * The account and selection whose Agent-Net service refused this device's identity: revoked there, e.g. after a Device Link
 * deletion (deviceLinkApi.ts revokes the member; an official revocation is permanent). That is Agent-Net's answer, not Device
 * Link's: until the account or the selection changes, this device runs as with Agent-Net off. Its main connection is Device Link,
 * which decides by itself (a device still removed there gets Device Link's own "removed"; one that signed in again connects),
 * and its signed statement says "off". Not with 「仅使用 Agent-Net」, where there is no Device Link to fall back to (2026-11-17:
 * a deleted device that signed in again could otherwise never connect while its Agent-Net switch was on).
 */
let refusedSelection: string | null = null;
const refusalScope = () => JSON.stringify([activeOwnerScopeKey(), agentNetSelectionKey()]);
export function agentNetIdentityRefused(): boolean { return refusedSelection !== null && refusedSelection === refusalScope(); }
/** The Agent-Net service refused this identity (relay 401/403, or a re-enrollment that needs approval). */
export function isAgentNetIdentityRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /^AGENT_NET_UPGRADE_(401|403)$/.test(message) || (error as { code?: unknown } | null)?.code === 'DEVICE_REENROLLMENT_REQUIRES_APPROVAL';
}
/** Record a refusal (see `refusedSelection`); false when 「仅使用 Agent-Net」 leaves no Device Link to run on. */
export function noteAgentNetIdentityRefused(reason: string): boolean {
  if (agentNetRequiresEncryption()) return false;
  if (!agentNetIdentityRefused()) agentNetLog.warn(`agent-net refused this device (${reason}); running on Device Link until the account or selection changes`);
  refusedSelection = refusalScope();
  return true;
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
  let encrypted: AgentNetAppSocket | null;
  try { encrypted = await createAgentNetAppSocket(); }
  catch (error) {
    if (!isAgentNetIdentityRefusal(error) || !noteAgentNetIdentityRefused(error instanceof Error ? error.message : 'refused')) throw error;
    // This attempt's credentials were taken for Agent-Net; the next one (Device Link's usual retry) runs on Device Link.
    throw new Error('AGENT_NET_IDENTITY_REFUSED');
  }
  if (encrypted) { onTransport?.(true); return encrypted; }
  if (agentNetRequiresEncryption()) throw new Error('AGENT_NET_ENCRYPTED_IDENTITY_REQUIRED');
  const socket = await legacy();
  onTransport?.(false);
  return socket;
}
export function agentNetShouldUseLegacyPeer(id: string): boolean { return (current ?? previousSocket)?.knowsPeer(id) === false; }
export function agentNetShouldProbeLegacyPeer(id: string): boolean { return !!current?.knowsPeer(id) && !current.supports(id); }
export function agentNetPeerSnapshot(id: string) { return current?.peerSnapshot(id) ?? null; }
export function agentNetPeerRoutes() {
  return current?.peerRoutes().filter(({ deviceId }) => !isScopedPeer(deviceId) && agentNetDeviceAccepted(deviceId)) ?? [];
}
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
    if (api) return createTransportModeProof(api.identity, peer, requestId, isAgentNetActive());
    // The official certificate expired while Agent-Net was off (it renews only while on): still say "off" with this device's own
    // key; peers accept that, and only that, from an expired certificate (agentNetTransportStatement.ts).
    const keys = !relay && !isAgentNetActive() ? officialAgentNetStatementIdentity() : null;
    return keys ? createTransportModeProof(keys, peer, requestId, false) : undefined;
  } catch { return undefined; }
}
export function verifyAgentNetTransportAttestation(peer: string, requestId: string, proof: unknown): boolean {
  if (!current?.knowsPeer(peer)) return true;
  try {
    const certificate = current.certificateFor(peer), api = currentAgentNetClient();
    if (!api) return false;
    if (certificate) return acceptTransportStatement(api.rootPublicKey, certificate, current.deviceId, requestId, proof, agentNetDeviceAccepted(peer));
    // Known here but gone from the signed directory (revoked there): only its own "off", checked with the certificate it last had.
    return acceptTransportStatement(api.rootPublicKey, current.lastKnownCertificateFor?.(peer), current.deviceId, requestId, proof,
      agentNetDeviceAccepted(peer), { offOnly: true });
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
  const connectedAt = new Map<string, number>();
  try {
    const socket = await AgentNetWorkerSocket.open({ workerFile, client: api, assertCurrent, module, log: agentNetLog,
      userId: authManager.getCurrentUserId() ?? '', scoped: true,
      onDelegationRequests: requests => approver?.update(requests),
      onPathChanged(deviceId, route) { if (route) connectedAt.set(deviceId, performance.now()); else connectedAt.delete(deviceId); } });
    try { assertCurrent(); } catch (error) { socket.close(); throw error; }
    socket.once('close', () => { approver?.close(); scopedSockets.delete(socket); });
    peerConnectedAt.set(socket, connectedAt);
    scopedSockets.add(socket);
    // 跨账号也跟着「Agent-Net (Beta)」开关：开关一变，分享连接整批重建（agentNetSelectionKey），这里按打开时的开关决定。
    if (sessionConfig && readDeviceLinkSettings().agentNetEnabled === true) socket.useSessions?.(sessionConfigFor(socket, sessionConfig, true));
    return socket;
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
  const cache = await readAgentNetDirectoryCache(directoryFile, assertOwner);
  const cachedDirectory: DeviceView[] = cache.devices;
  const directoryExpiresAt = cache.expiresAt;
  // A temporary relay outage must still let the local node start and retain its V1 compatibility path.
  // This adds only our own already validated certificate, never an unverified remote identity.
  if (!cachedDirectory.some((entry) => entry?.certificate?.deviceId === api.identity.deviceId)) {
    cachedDirectory.push({ certificate: api.certificate, name: '', online: false, remoteControlEnabled: false, capabilities: [] });
  }
  // 官方网络：Device Link 里删掉的设备从一开始就不认。这个账号还没读过设备列表（刚启动）就先读一次，和下面取中转信息一起，
  // 最多等 3 秒；读不到照常连接，之后读到再拦。
  const members = relay ? null : currentMembership();
  const membersScope = membershipScope;
  /** 还是打开这条连接时的账号与网络才交给判断（换了就不是这条连接的事了）。 */
  const liveMembers = () => (members && membershipScope === membersScope && officialMembershipScope() === membersScope ? members : null);
  members?.noteDirectory(cachedDirectory.filter((view) => view?.certificate?.deviceId)
    .map((view) => ({ deviceId: view.certificate.deviceId, online: false })));
  const listing = members && !members.hasDeviceList()
    ? Promise.race([members.prime(), new Promise<void>((resolve) => { setTimeout(resolve, 3000).unref(); })]) : null;
  const module = await loadCore(); assertOwner();
  const stunServers: string[] = [];
  let relayUdpServer: string | undefined;
  let answered = false;
  try {
    const response = await outboundFetch(api.base + '/api/agent-net/info', { signal: AbortSignal.timeout(5000) });
    const info: unknown = await response.json(); assertOwner();
    // UDP may be published on its own host (e.g. NLB beside an HTTPS ALB); relays without one keep the API host.
    const server = response.ok ? agentNetStunServer(api.base, info) : null;
    answered = response.ok;
    if (relay && answered) {
      if (Array.isArray((info as { features?: unknown })?.features) && (info as { features: unknown[] }).features.includes('private-sharing-v1'))
        privateSharingRoots.set(api.base, api.rootPublicKey);
      else privateSharingRoots.delete(api.base);
    }
    // The relay forwards datagrams on the same UDP port as its STUN when it hands out UDP credentials;
    // an older relay never does, and the session stays on its WebSocket.
    if (server) { stunServers.push(server); relayUdpServer = server; lastUdpServer.set(api.base, server); }
    else if (answered) lastUdpServer.delete(api.base);
  } catch { assertOwner(); }
  const remembered = answered ? undefined : lastUdpServer.get(api.base);
  if (remembered) { stunServers.push(remembered); relayUdpServer = remembered; }
  if (listing) { await listing; assertOwner(); }
  const workerFile = [path.join(process.resourcesPath ?? '', 'agent-net', 'node-worker.mjs'),
    path.join(app.getAppPath(), 'resources', 'agent-net', 'node-worker.mjs'),
    path.join(app.getAppPath(), '..', '..', 'packages', 'agent-net', 'dist', 'node-worker.mjs')].find((file) => fs.existsSync(file));
  if (!workerFile) throw new Error('AGENT_NET_WORKER_BUNDLE_MISSING');
  let approver = createDelegationApprover(api, assertOwner, authorizeAgentNetSharingRequest);
  // 每次和对端换上一条连接都会报一次路径（之前的连接带着它的会话一起关了），断开时报 null。
  const connectedAt = new Map<string, number>();
  const notifyCovered = new Set<string>();
  let socket: AgentNetWorkerSocket;
  try { socket = await AgentNetWorkerSocket.open({ workerFile, assertCurrent: assertOwner, client: api, module, log: agentNetLog, userId: api.certificate.subject, cachedDirectory, directoryExpiresAt, stunServers, relayUdpServer,
    ...(members ? { peerRule: members.rule() } : {}),
    scoped: true, onDelegationRequests: requests => approver.update(requests),
    onPathChanged(deviceId, route) { if (route) connectedAt.set(deviceId, performance.now()); else connectedAt.delete(deviceId); },
    onDirectory(directory) {
      assertOwner();
      liveMembers()?.noteDirectory(directory.map((view) => ({ deviceId: view.certificate.deviceId, online: view.online })));
      notifyCovered.clear();
      for (const view of directory) if (view.notificationKey) notifyCovered.add(view.certificate.deviceId);
      // A read-only/full cache volume must not tear down an already authenticated live connection.
      // The owner-scope check above still fails closed; only this optional public cache is best effort.
      writeAgentNetDirectoryCache(directoryFile, directory);
    },
  }); } catch (error) { approver.close(); throw error; }
  socket.once('close', () => approver.close());
  try {
    assertOwner();
    if (attempt !== socketAttempt) throw new Error('AGENT_NET_CONNECTION_SUPERSEDED');
  } catch (error) { socket.close(); throw error; }
  peerConnectedAt.set(socket, connectedAt);
  notifyCoverage.set(socket, notifyCovered);
  const previous = current; current = socket; previous?.close();
  socket.on('relay', () => { if (current === socket) relayChanged(); });
  // 经中转的数据报在 UDP 与 WebSocket 之间切换：远程连接页马上刷新中转点上写的走法（不等 5 秒轮询）。
  socket.on('relay-route', () => { if (current === socket) relayChanged(); });
  socket.on('peer-routes-changed', () => { if (current === socket) pathChanged(); });
  relayChanged();
  // 打开期间结论可能又变了（列表读完、本机刚删了设备）：以现在的为准。
  const live = liveMembers();
  if (live) socket.restrictPeers?.(live.rule());
  if (sessionConfig) socket.useSessions?.(sessionConfigFor(socket, sessionConfig, false));
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
  socket.once('close', () => { if (renewal) clearTimeout(renewal); if (current === socket) { previousSocket = socket; current = null; relayChanged(); } });
  return socket;
}
