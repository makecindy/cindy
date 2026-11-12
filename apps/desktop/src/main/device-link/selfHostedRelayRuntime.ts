/**
 * 自建中转服务的桌面端运行时(docs/self-hosted-relay-plan.md)。
 *
 * - 在这台电脑上开启中转(方式 B):Cindy 主进程内运行 `@cindy/device-link-relay`,本机作为主人设备
 *   连 `http://127.0.0.1:<端口>`;别的设备怎么访问到这台电脑由用户保证,Cindy 只列出本机地址。
 * - 部署到自己的服务器(方式 C):经已配置的 SSH 主机安装同一个中转内核,自动申请证书;本机是主人,
 *   远程生成加入链接、审批设备、升级与卸载(selfHostedRelayDeploy.ts)。可以部署到多台服务器(一台一个);
 *   部署完成只保存记录,改用哪条线路由用户自己切换。
 * - 加入别的中转:粘贴主人电脑给出的加入链接 → 申请 → 主人同意 → 保存中转凭证与签名密钥并切换。
 * - 设备签名(§16):主人密钥只在主人电脑;同意加入时主人核对配对证明后签发设备证书。
 *
 * 只接受本机应用窗口的命令,不经设备互联代理。凭证、私钥、加入码、加入链接不写日志。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { app, ipcMain } from 'electron';
import {
  acceptRelayDeviceCert,
  buildRelayJoinLink,
  createRelayJoinIdentity,
  createRelayPairSecret,
  createRelaySigningKey,
  fetchRelayInfo,
  isRelayLinkForOtherAccount,
  issueRelayDeviceCert,
  parseRelayAccountJoinBoard,
  parseRelayAccountOffers,
  parseRelayJoinLink,
  RELAY_ACCOUNT_ACK_WAIT_MS,
  RELAY_ACCOUNT_INVITE_WAIT_MS,
  RELAY_ACCOUNT_JOIN_TTL_MS,
  RELAY_JOIN_PREFERENCE,
  RELAY_OFFERS_PREFERENCE,
  relayAccountTag,
  relayPairingVerifyCode,
  relayPublicKeyOf,
  RelayJoinError,
  serializeRelayAccountJoinBoard,
  submitRelayPairRequest,
  verifyRelayPairProof,
  waitForRelayApproval,
  withRelayAccountOffer,
  type RelayAccountJoinBoard,
  type RelayAccountJoinInvite,
  type RelayAccountOffer,
  type RelayFetch,
  type RelayJoinLink,
  type RelaySigningKey,
} from '@cindy/device-link';
import { nodeRelayAuthCrypto as crypto } from '@cindy/device-link/node-relay-crypto';
import {
  createDeviceCredential,
  hashSecret,
  initializeRelay,
  startRelayServer,
  type RelayServerHandle,
} from '@cindy/device-link-relay';
import * as authManager from '../authManager.js';
import { outboundFetch } from '../maker-host/outbound-fetch.desktop.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  parseSelfHostedRelayCommand,
  RELAY_DEPLOY_STEPS,
  RELAY_UNINSTALL_STEPS,
  relayBaseUrlForAddress,
  SELF_HOSTED_RELAY_IPC,
  type SelfHostedRelayAccountRelayView,
  type SelfHostedRelayCommand,
  type SelfHostedRelayDeployJobView,
  type SelfHostedRelayErrorCode,
  type SelfHostedRelayJoinView,
  type SelfHostedRelayPairRequestView,
  type SelfHostedRelayDeploymentStatus,
  type SelfHostedRelayServerCheck,
  type SelfHostedRelayState,
  type SelfHostedRelayTenantView,
  type RelayDeployProgressMessage,
  type PeerAgentNetReply,
  type PeerAgentNetRequest,
  type RelayDeployStep,
} from '../../shared/selfHostedRelay.js';
import { deviceName } from './deviceName.js';
import { readAccountPreference, updateAccountPreference } from './relayAccountPreferences.js';
import {
  broadcast,
  getDeviceLinkConnectionIssue,
  getDeviceLinkPeerLinks,
  remoteBackgroundInvoke,
  restartDeviceLinkForRelayChange,
  setKeepAwakeEnabled,
} from './index.js';
import { AGENT_NET_SWITCH_CHANNEL } from '@cindy/device-link';
import { createAgentNetRemoteSwitch, type AgentNetRemoteSwitch } from './agentNetRemoteSwitch.js';
import { isAgentNetOnlyRelay } from './selfHostedRelayRouting.js';
import type { AgentNetSwitchDisableBlock } from '@cindy/device-link';
import { getDeviceLinkInvokeContext } from './invoke-context.js';
import { providerShareLinkApp } from './providerShareApi.js';
import {
  activeRelayOrigin,
  activeSelfHostedRelay,
  deleteRelaySecrets,
  installSelfHostedRelayRouting,
  readRelayConfig,
  readHostNotificationBridgeConfig,
  readRelaySecrets,
  relayDataPath,
  secureStorageAvailable,
  writeRelayConfig,
  writeRelaySecrets,
  type RelayConfig,
  type RelayDeployment,
  type RelaySecrets,
} from './selfHostedRelayConfig.js';
import {
  bundledRelayVersion,
  checkRelayServer,
  deployRelayToServer,
  RelayDeployError,
  uninstallRelayFromServer,
} from './selfHostedRelayDeploy.js';
import { refreshRelayCertificatesSoon } from './selfHostedRelayFrameAuth.js';
import { createJoinRequest, startAgentNetRelay, tenantVerifyCode, verifyJoinPairingProof, verifyTenantPairingProof, type JoinRequest, type TenantJoinRequest } from '@cindy/agent-net-relay';
import { createNotificationBridge } from '@cindy/agent-net-relay/notification-bridge';
import { createAgentNetSharingAuth, type SharingAuthConfig } from '@cindy/agent-net-relay/sharing-auth';
import { getClientEndpoint, getClientEndpointForRealm, loadClientEndpointsForRealm } from '../clientEndpointsService.js';
import { hostJoinBaseUrl, suggestedRelayUrls as suggestedUrls } from './selfHostedRelayAddress.js';
import { AgentNetClientError, submitJoin, pollJoin, submitTenantJoin, pollTenantJoin, type AgentNetClient } from '@cindy/agent-net-relay/client';
import { startRelayGateway } from '@cindy/agent-net';
import { agentNetClientForRelay, approveAgentNetMember, createAgentNetTenantRequest, isAgentNetActive, ensureOwnerAgentNetBootstrap, memberAgentNetIdentity, memberAgentNetSecrets } from './agentNetRuntime.js';
import { readDeviceLinkSettings, updateDeviceLinkSetting, type DeviceLinkSettings } from './settings-store.desktop.js';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending, onAppSessionInvalidated } from '../appSessionState.js';

async function sharingAuthConfig(): Promise<SharingAuthConfig> {
  const key = activeOwnerScopeKey(), region = authManager.getActiveAuthRealm(), issuer = getClientEndpoint('authApiBaseUrl');
  const other = region === 'cn' ? 'global' : 'cn';
  const result: SharingAuthConfig = { issuer, region, fetch: outboundFetch };
  try {
    await loadClientEndpointsForRealm(other);
    const peer = getClientEndpointForRealm(other, 'authApiBaseUrl');
    if (peer && peer !== issuer) result.peers = [{ issuer: peer, region: other }];
  } catch { log.warn('peer-region sharing issuer discovery unavailable'); }
  if (key !== activeOwnerScopeKey() || isAppSessionBoundaryPending() || authManager.getActiveAuthRealm() !== region) throw new Error('AGENT_NET_OWNER_CHANGED');
  return result;
}

const log = createLogger('self-hosted-relay');

const PENDING_POLL_MS = 2_000;
/** 分享链接 5 分钟有效、只能用一次(与供应商分享一致)。 */
const JOIN_LINK_TTL_MS = 5 * 60 * 1000;
/** 再次打开分享窗口时,剩余时间不少于这么久的链接直接沿用,不另占一个加入码。 */
const JOIN_LINK_REUSE_MIN_MS = 60 * 1000;

const relayFetch: RelayFetch = (url, init) => fetch(url, init);

let host: RelayServerHandle | null = null;
let hostKey: string | null = null;
let hostError: SelfHostedRelayErrorCode | null = null;
let hostStarting: Promise<void> | null = null;
let joinLink: { link: string; expiresAt: number; otherAccounts: boolean } | null = null;
/** 这台电脑生成的加入链接里的配对秘密(只在内存,随链接一起过期)。`tenantCode`:同一条链接给其他账号用的邀请码。 */
let pairSecrets: Array<{ relayId: string; secret: string; expiresAt: number; agentNetCode?: string; tenantCode?: string }> = [];
/** 界面上要主人处理的申请;同账号自动放行的那些不在这里。 */
let pendingRequests: SelfHostedRelayPairRequestView[] = [];
/** 中转上全部待处理申请(含自动放行的),同意时按它核对。 */
let pendingViews = new Map<string, SelfHostedRelayPairRequestView>();
let pendingRaw = new Map<string, { deviceId: string; publicKey: string }>();
let pendingAgentNet = new Map<string, JoinRequest>();
/** 其他账号的加入申请(§5.5),键是界面上的 `tenant:` 申请 ID。 */
let pendingTenants = new Map<string, TenantJoinRequest>();
let pendingRefreshing = false;
/** 主人:这条中转分享给了哪些账号;null = 还没读过,或这条中转不能分享给其他账号。 */
let tenants: SelfHostedRelayTenantView[] | null = null;
let tenantsReading = false;
/** 中转能不能分享给其他账号(按地址记一分钟,不随每次分享都问)。 */
let tenantSupport: { base: string; supported: boolean; at: number } | null = null;
let pendingTimer: ReturnType<typeof setInterval> | null = null;
let join: SelfHostedRelayJoinView = { status: 'idle' };
let joinAbort: AbortController | null = null;
let deployJob: SelfHostedRelayDeployJobView | null = null;
let ownerEpoch = 0;

// ─── 同账号中转目录(relayAccountDirectory.ts) ───────────────────────────────
/** 同账号其他电脑正在用的中转(打开中转页或收到变更通知时读)。 */
let accountOffers: RelayAccountOffer[] = [];
let accountOffersReadAt = 0;
let accountOffersReading: Promise<void> | null = null;
/** 已写进账号的这台电脑那一条;null = 本次运行还没核对过。 */
let publishedOffer: string | null = null;
let offerSyncing = false;
let offerSyncAgain = false;
let offerSyncFailedAt = 0;
/** 同账号设备的申请:回写链接后,中转上公钥与申请一致的那条直接放行。 */
let autoApprovals: Array<{ relayId: string; deviceId: string; publicKey: string; expiresAt: number }> = [];
/** 本次运行已回写过的同账号申请,不重复要加入码。 */
let answeredAccountRequests = new Set<string>();
let accountRequestsReading = false;
let accountRequestsAgain = false;
const autoDeciding = new Set<string>();

/** 异步工作只属于发起时的账号代次;切走再切回同一账号也不能接收旧结果。 */
class RelayOperationExpired extends Error {}

function captureOwner(): () => void {
  const scope = activeOwnerScopeKey();
  const epoch = ownerEpoch;
  return () => {
    if (epoch !== ownerEpoch || scope !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) {
      throw new RelayOperationExpired();
    }
  };
}

function emitChanged(): void {
  broadcast(SELF_HOSTED_RELAY_IPC.CHANGED, getState());
  scheduleOfferSync();
}

function localBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function getState(): SelfHostedRelayState {
  const config = readRelayConfig();
  const relay = activeSelfHostedRelay();
  const origin = activeRelayOrigin();
  const issue = relay ? getDeviceLinkConnectionIssue() : null;
  if (joinLink && joinLink.expiresAt < Date.now()) joinLink = null;
  const bundled = bundledRelayVersion();
  const shared = relay ? config.active?.shared : undefined;
  return {
    agentNetEnabled: readDeviceLinkSettings().agentNetEnabled === true,
    agentNetOnlyEncrypted: readDeviceLinkSettings().agentNetOnlyEncrypted === true,
    agentNetChangedBy: readDeviceLinkSettings().agentNetChangedBy ?? null,
    available: authManager.getAuthState().isAuthenticated && secureStorageAvailable(),
    mode: relay ? 'self-hosted' : 'official',
    relay: relay && origin
      ? { name: relay.name, baseUrl: relay.baseUrl, role: relay.role, origin, relayId: relay.relayId, ...(shared ? { shared } : {}) }
      : null,
    accountRelays: accountRelayViews(),
    ...(relay ? { connection: isAgentNetActive() ? 'agent-net' as const : 'device-link' as const } : {}),
    ...(tenants ? { tenants } : {}),
    issue: issue?.kind === 'device-removed' ? 'removed' : issue?.kind === 'auth-failed' ? 'unauthorized' : null,
    host: {
      enabled: config.host.enabled,
      running: host !== null,
      error: hostError,
      port: config.host.port,
      listenAll: config.host.listenAll,
      externalUrl: config.host.externalUrl,
      suggestedUrls: suggestedUrls(config),
    },
    deployments: config.deployments.map((deployment) => ({
      relayId: deployment.relayId,
      sshHostId: deployment.sshHostId,
      address: deployment.address,
      baseUrl: deployment.baseUrl,
      name: deployment.name,
      relayVersion: deployment.complete ? deployment.relayVersion : '',
      deployedAt: deployment.deployedAt,
      active: relay?.relayId === deployment.relayId,
      upgradeAvailable: Boolean(bundled && deployment.complete && bundled !== deployment.relayVersion),
    })),
    deployJob,
    bundledRelayVersion: bundled,
    joinLink: joinLink
      ? { link: joinLink.link, expiresAt: new Date(joinLink.expiresAt).toISOString(), otherAccounts: joinLink.otherAccounts }
      : null,
    pendingRequests,
    join,
  };
}

// ─── 主人身份 ────────────────────────────────────────────────────────────────

function generateOwnerSecrets(): RelaySecrets {
  return { credential: createDeviceCredential().credential, seed: createRelaySigningKey(crypto).seed };
}

/** 新建一份主人身份:凭证与签名私钥只存本机安全存储。 */
function createOwnerSecrets(relayId: string): RelaySecrets {
  const secrets = generateOwnerSecrets();
  writeRelaySecrets(relayId, secrets);
  return secrets;
}

/** 交给中转初始化的主人信息(哈希、公钥、自签证书),不含秘密。 */
function ownerInitArgs(relayId: string, secrets: RelaySecrets, name: string) {
  const ownerPublicKey = relayPublicKeyOf(crypto, secrets.seed)!;
  const ownerDeviceId = authManager.getDeviceId();
  return {
    name,
    relayId,
    ownerUserId: authManager.getCurrentUserId() ?? '',
    ownerDeviceId,
    ownerDeviceName: deviceName().slice(0, 64) || 'Cindy',
    ownerCredentialHash: hashSecret(secrets.credential),
    ownerPublicKey,
    ownerCert: issueRelayDeviceCert(crypto, secrets.seed, {
      relayId,
      deviceId: ownerDeviceId,
      publicKey: ownerPublicKey,
      role: 'owner',
      issuedAt: Date.now(),
    }),
  };
}

// ─── 本机中转(主人) ─────────────────────────────────────────────────────────

function stopPairing(): void {
  stopPendingPolling();
  joinLink = null;
  pairSecrets = [];
  pendingRequests = [];
  pendingViews = new Map();
  pendingRaw = new Map();
  pendingAgentNet = new Map();
  pendingTenants = new Map();
  autoApprovals = [];
  tenants = null;
}

async function stopHost(retire: boolean): Promise<void> {
  if (activeRelayOrigin() === 'host') stopPairing();
  const current = host;
  host = null;
  hostKey = null;
  if (current) await current.close({ retire }).catch((error) => log.warn('relay host close failed', String(error)));
}

/**
 * 准备本机中转的数据目录与主人身份。主人秘密丢失(钥匙串被清)或数据来自旧版本时重建中转,
 * 已加入的设备需要重新加入。返回中转 ID。
 */
async function prepareHostData(dataDir: string, config: RelayConfig): Promise<string> {
  const assertOwner = captureOwner();
  const stateFile = `${dataDir}/relay-state.json`;
  const existingId = config.host.relayId;
  if (existingId && readRelaySecrets(existingId) && fs.existsSync(stateFile)) return existingId;
  if (!authManager.getCurrentUserId()) throw new Error('NOT_SIGNED_IN');
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (existingId) {
    const wasActive = readRelayConfig().active?.relayId === existingId;
    deleteRelaySecrets(existingId);
    // Missing secrets switch the routing source to official immediately.
    if (wasActive) restartDeviceLinkForRelayChange();
  }
  const relayId = randomUUID();
  const secrets = createOwnerSecrets(relayId);
  await initializeRelay({ dataDir, ...ownerInitArgs(relayId, secrets, deviceName().slice(0, 64) || 'Cindy') });
  assertOwner();
  writeRelayConfig({ ...readRelayConfig(), host: { ...config.host, relayId } });
  return relayId;
}

async function startHost(config: RelayConfig): Promise<void> {
  const assertOwner = captureOwner();
  const useAgentNet = readDeviceLinkSettings().agentNetEnabled === true || !!(config.host.relayId && readRelaySecrets(config.host.relayId)?.agentNet);
  const key = `${config.host.port}:${config.host.listenAll}:${config.host.externalUrl ?? ''}:${useAgentNet}`;
  if (host && hostKey === key) return;
  await stopHost(false);
  assertOwner();
  hostError = null;
  const dataDir = relayDataPath('host');
  try {
    await prepareHostData(dataDir, config);
    assertOwner();
    const legacy = await startRelayServer({
      dataDir,
      host: useAgentNet ? '127.0.0.1' : config.host.listenAll ? '0.0.0.0' : '127.0.0.1',
      port: useAgentNet ? 0 : config.host.port,
      publicUrl: config.host.externalUrl ?? undefined,
      // 只监听本机时,请求来自同机的前置代理,可以信任它给的外部地址。
      trustProxyHeaders: !config.host.listenAll,
      logger: {
        info: (message, fields) => log.info(message, fields ?? {}),
        warn: (message, fields) => log.warn(message, fields ?? {}),
        error: (message, fields) => log.error(message, fields ?? {}),
      },
    });
    let started = legacy;
    if (useAgentNet) {
      let agentNet: Awaited<ReturnType<typeof startAgentNetRelay>> | null = null;
      try {
        const bootstrap = ensureOwnerAgentNetBootstrap(readRelayConfig().host.relayId!, deviceName().slice(0, 64) || 'Cindy');
        agentNet = await startAgentNetRelay({ bootstrap, dataDir: relayDataPath('agent-net', 'host'),
          notify: await createNotificationBridge(readHostNotificationBridgeConfig(), { fetch: outboundFetch }),
          host: '127.0.0.1', port: 0, udpHost: config.host.listenAll ? '0.0.0.0' : '127.0.0.1', udpPort: config.host.port,
          sharing: createAgentNetSharingAuth(await sharingAuthConfig()) });
        const gateway = await startRelayGateway({ host: config.host.listenAll ? '0.0.0.0' : '127.0.0.1',
          port: config.host.port, legacyUrl: legacy.localUrl, agentNetUrl: agentNet.url });
        const ownedAgentNet = agentNet;
        started = { relayId: legacy.relayId, localUrl: localBaseUrl(gateway.port), port: gateway.port,
          updateTls: (tls) => legacy.updateTls(tls),
          async close(options) { await gateway.close(); await Promise.all([legacy.close(options), ownedAgentNet.close()]); },
        };
      } catch (error) { await agentNet?.close(); await legacy.close(); throw error; }
    }
    try {
      assertOwner();
    } catch (error) {
      await started.close({ retire: false });
      throw error;
    }
    host = started;
    hostKey = key;
    log.info('relay host started', { port: host.port, listenAll: config.host.listenAll });
  } catch (error) {
    assertOwner();
    if (error instanceof RelayOperationExpired) throw error;
    host = null;
    hostKey = null;
    hostError = (error as NodeJS.ErrnoException)?.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'START_FAILED';
    log.warn('relay host failed to start', { reason: hostError });
  }
}

function ensureHost(): Promise<void> {
  if (requireReady()) return Promise.resolve();
  const config = readRelayConfig();
  if (!config.host.enabled) return Promise.resolve();
  if (!hostStarting) {
    const assertOwner = captureOwner();
    const starting = startHost(config).finally(() => {
      if (hostStarting === starting) hostStarting = null;
      assertOwner();
      emitChanged();
    });
    hostStarting = starting;
  }
  return hostStarting;
}

// ─── 主人管理(本机中转与服务器中转共用) ─────────────────────────────────────

/** 当前作为主人使用的中转的管理入口地址。 */
function ownerBase(): { baseUrl: string; credential: string; relayId: string; seed: string; ownerPublicKey: string } | null {
  const relay = activeSelfHostedRelay();
  const origin = activeRelayOrigin();
  if (!relay || relay.role !== 'owner') return null;
  if (origin === 'host') {
    if (!host) return null;
    return { baseUrl: localBaseUrl(host.port), credential: relay.credential, relayId: relay.relayId, seed: relay.signingSeed, ownerPublicKey: relay.ownerPublicKey };
  }
  return { baseUrl: relay.baseUrl, credential: relay.credential, relayId: relay.relayId, seed: relay.signingSeed, ownerPublicKey: relay.ownerPublicKey };
}
function ownerAgentNetApi() {
  const owner = ownerBase();
  return owner && readRelaySecrets(owner.relayId)?.agentNet ? agentNetClientForRelay(owner.relayId, owner.baseUrl) : null;
}

async function ownerFetch(path: string, init: { method: string; body?: unknown } = { method: 'GET' }): Promise<unknown> {
  const owner = ownerBase();
  if (!owner) throw new Error('NOT_OWNER');
  const res = await fetch(`${owner.baseUrl}/api/device-link${path}`, {
    method: init.method,
    headers: {
      authorization: `CindyRelay ${owner.credential}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new Error(`relay admin request failed (${res.status})`);
  return body;
}

/** 配对证明与这台电脑当前有效的某个加入链接对得上。 */
function proofMatches(relayId: string, request: { deviceId: string; publicKey: string; proof: unknown }): boolean {
  const now = Date.now();
  pairSecrets = pairSecrets.filter((entry) => entry.expiresAt + JOIN_LINK_TTL_MS > now);
  return pairSecrets.some(
    (entry) => entry.relayId === relayId && verifyRelayPairProof(crypto, entry.secret, { relayId, ...request }),
  );
}

/** 这条申请来自同账号设备,公钥正是它登记在账号里的那把(见 answerAccountJoinRequests)。 */
function isAutoApproved(relayId: string, request: { deviceId: string; publicKey: string } | undefined): boolean {
  return !!request && autoApprovals.some(
    (entry) => entry.relayId === relayId && entry.deviceId === request.deviceId && entry.publicKey === request.publicKey,
  );
}

async function refreshPendingRequests(): Promise<void> {
  if (pendingRefreshing) return;
  const assertOwner = captureOwner();
  const owner = ownerBase();
  if (!owner) return;
  pendingRefreshing = true;
  try {
    // 只走 V2 的网络没有旧版申请。
    const v2Only = !owner.credential;
    const body = v2Only ? { requests: [] } : (await ownerFetch('/relay/admin/pair-requests')) as { requests?: unknown[] };
    assertOwner();
    if (ownerBase()?.relayId !== owner.relayId) return;
    const raw = new Map<string, { deviceId: string; publicKey: string }>();
    const v2 = ownerAgentNetApi();
    const v2Requests = v2 && pairSecrets.some((s) => s.agentNetCode)
      ? (await v2.request<{ requests: JoinRequest[] }>('GET', '/join-requests')).requests : [];
    assertOwner();
    const tenantRequests = v2 && pairSecrets.some((s) => s.tenantCode)
      ? (await v2.request<{ requests: Array<{ request: TenantJoinRequest; requestedAt: number }> }>('GET', '/tenant-requests')).requests : [];
    assertOwner();
    const v2Matches = new Map<string, JoinRequest>();
    const tenantMatches = new Map<string, TenantJoinRequest>();
    const v2Verified = (v: JoinRequest) => pairSecrets.some((s) => s.relayId === owner.relayId && s.agentNetCode === v.joinCode && verifyJoinPairingProof(v, s.secret));
    const views = (body.requests ?? []).flatMap((item): SelfHostedRelayPairRequestView[] => {
      const r = item as Record<string, unknown>;
      if (
        typeof r.requestId !== 'string' ||
        typeof r.deviceId !== 'string' ||
        typeof r.deviceName !== 'string' ||
        typeof r.verifyCode !== 'string' ||
        typeof r.publicKey !== 'string'
      ) {
        return [];
      }
      raw.set(r.requestId, { deviceId: r.deviceId, publicKey: r.publicKey });
      const candidate = v2Requests.find((v) => v.deviceId === r.deviceId && v.signingKey === r.publicKey && v2Verified(v));
      if (candidate) v2Matches.set(r.requestId, candidate);
      return [{
        requestId: r.requestId,
        deviceName: r.deviceName,
        platform: typeof r.platform === 'string' ? r.platform : null,
        verifyCode: r.verifyCode,
        replacesExisting: r.replacesExisting === true,
        verified: proofMatches(owner.relayId, { deviceId: r.deviceId, publicKey: r.publicKey, proof: r.proof }),
        ...(typeof r.createdAt === 'string' && Number.isFinite(Date.parse(r.createdAt)) ? { requestedAt: r.createdAt } : {}),
      }];
    });
    if (v2Only) {
      for (const v of v2Requests) {
        const requestId = 'v2:' + v.requestId;
        raw.set(requestId, { deviceId: v.deviceId, publicKey: v.signingKey });
        v2Matches.set(requestId, v);
        views.push({ requestId, deviceName: v.name, platform: null, verifyCode: relayPairingVerifyCode(crypto, v.pairingProof),
          replacesExisting: false, verified: v2Verified(v) });
      }
    }
    // 其他账号的申请:配对证明对得上这台电脑给出的那条链接,才说明申请没被中转换掉。
    for (const { request: t, requestedAt } of tenantRequests) {
      const requestId = 'tenant:' + t.requestId;
      tenantMatches.set(requestId, t);
      views.push({
        requestId, deviceName: t.deviceName, platform: null, verifyCode: tenantVerifyCode(t), replacesExisting: false,
        verified: pairSecrets.some((s) => s.relayId === owner.relayId && s.tenantCode === t.inviteCode && verifyTenantPairingProof(t, s.secret)),
        accountName: t.accountName,
        ...(Number.isFinite(requestedAt) ? { requestedAt: new Date(requestedAt).toISOString() } : {}),
      });
    }
    pendingRaw = raw;
    pendingAgentNet = v2Matches;
    pendingTenants = tenantMatches;
    pendingViews = new Map(views.map((view) => [view.requestId, view]));
    const now = Date.now();
    autoApprovals = autoApprovals.filter((entry) => entry.expiresAt > now);
    // 同账号设备拿着这台电脑回写的链接来申请,公钥与它登记的一致:直接放行,不弹审批。
    const auto = views.filter((view) => view.verified && isAutoApproved(owner.relayId, raw.get(view.requestId)));
    const next = views.filter((view) => !auto.includes(view));
    if (JSON.stringify(next) !== JSON.stringify(pendingRequests)) {
      pendingRequests = next;
      emitChanged();
    }
    for (const view of auto) {
      if (autoDeciding.has(view.requestId)) continue;
      autoDeciding.add(view.requestId);
      const request = raw.get(view.requestId)!;
      void decide(view.requestId, true)
        .then(({ error }) => {
          if (error) return;
          autoApprovals = autoApprovals.filter((entry) => entry.deviceId !== request.deviceId || entry.publicKey !== request.publicKey);
          log.info('approved a device of this account');
        })
        .catch(() => undefined)
        .finally(() => autoDeciding.delete(view.requestId));
    }
  } catch (error) {
    if (error instanceof RelayOperationExpired) return;
    // 中转刚重启或暂时连不上:下一轮再试;停用时轮询会被一并停掉。
  } finally { pendingRefreshing = false; }
}

function startPendingPolling(): void {
  stopPendingPolling();
  pendingTimer = setInterval(() => {
    // 分享链接过期、也没有等着同账号设备来申请时,最后再看一次,让已经提交的申请仍能被处理完。
    if ((!joinLink || joinLink.expiresAt < Date.now()) && autoApprovals.every((entry) => entry.expiresAt < Date.now())) {
      if (pendingRequests.length === 0) stopPendingPolling();
    }
    void refreshPendingRequests();
  }, PENDING_POLL_MS);
  pendingTimer.unref?.();
}

function stopPendingPolling(): void {
  if (pendingTimer) clearInterval(pendingTimer);
  pendingTimer = null;
}

/** 中转能不能分享给其他账号:看它的 V2 能力声明(本机中转总能;服务器上的旧版本不能)。 */
async function relaySupportsTenants(api: AgentNetClient): Promise<boolean> {
  if (tenantSupport?.base === api.base && Date.now() - tenantSupport.at < 60_000) return tenantSupport.supported;
  let supported = false;
  try {
    const response = await outboundFetch(api.base + '/api/agent-net/info', { signal: AbortSignal.timeout(5_000) });
    const info = (await response.json()) as { features?: unknown };
    supported = response.ok && Array.isArray(info.features) && info.features.includes('tenants-v1');
  } catch {
    // 读不到能力:这次的链接只给本账号的设备用。
  }
  tenantSupport = { base: api.base, supported, at: Date.now() };
  return supported;
}

/**
 * 向正在用的中转要一个加入码,生成一次性分享链接,并开始轮询申请。
 * `forOtherAccounts`:分享窗口里的链接,自己的中转且支持时,其他账号也能用它在中转上建自己的网络(§5.5)。
 */
async function issueJoinLink(
  forOtherAccounts: boolean,
): Promise<{ link: string; expiresAt: number; otherAccounts: boolean } | SelfHostedRelayErrorCode> {
  const assertOwner = captureOwner();
  const owner = ownerBase();
  if (!owner) return activeRelayOrigin() === 'host' ? 'START_FAILED' : 'NOT_OWNER';
  const base = activeRelayOrigin() === 'host' ? hostJoinBaseUrl(readRelayConfig()) : activeSelfHostedRelay()!.baseUrl;
  if (!base) return 'EXTERNAL_URL_REQUIRED';
  try {
    // 别人分享来的网络只走 V2:没有旧版加入码,也不能再分享给其他账号。
    const v2Only = !owner.credential;
    const body = v2Only ? null : ((await ownerFetch('/relay/admin/join-codes', { method: 'POST' })) as { code: string });
    assertOwner();
    if (ownerBase()?.relayId !== owner.relayId) return 'NOT_OWNER';
    const pairSecret = createRelayPairSecret(crypto);
    const v2 = ownerAgentNetApi();
    if (v2Only && !v2) return 'FAILED';
    const v2Code = v2 ? await v2.request<{ joinCode: string; expiresAt: number }>('POST', '/join-codes') : null;
    assertOwner();
    const userId = authManager.getCurrentUserId();
    const tenant = forOtherAccounts && v2 && !v2Only && userId && (await relaySupportsTenants(v2))
      ? await v2.request<{ inviteCode: string; expiresAt: number }>('POST', '/tenant-invites') : null;
    assertOwner();
    const expiresAt = Math.min(Date.now() + JOIN_LINK_TTL_MS, v2Code?.expiresAt ?? Infinity, tenant?.expiresAt ?? Infinity);
    pairSecrets.push({ relayId: owner.relayId, secret: pairSecret, expiresAt, agentNetCode: v2Code?.joinCode, tenantCode: tenant?.inviteCode });
    const link = buildRelayJoinLink({
      baseUrl: base,
      ...(body ? { code: body.code } : { relayId: owner.relayId }),
      ownerPublicKey: owner.ownerPublicKey,
      pairSecret,
      app: providerShareLinkApp(),
      agentNetCode: v2Code?.joinCode,
      ...(tenant && userId
        ? { tenantCode: tenant.inviteCode, ownerAccountTag: relayAccountTag(crypto, userId), ownerName: authManager.getCurrentMembershipDisplayName() }
        : {}),
    });
    // 旧链接收到的申请还在中转上等着处理,不随新链接清空;下一轮轮询照实更新。
    startPendingPolling();
    return { link, expiresAt, otherAccounts: Boolean(tenant) };
  } catch (error) {
    if (error instanceof RelayOperationExpired) throw error;
    return 'FAILED';
  }
}

async function createJoinLink(fresh: boolean): Promise<CommandResult> {
  // 中转同时只留 5 个有效加入码:重新打开分享窗口时沿用还够用的那条,只有「重新生成」才另要一条。
  if (!fresh && ownerBase() && joinLink && joinLink.expiresAt - Date.now() >= JOIN_LINK_REUSE_MIN_MS) return { state: getState() };
  const issued = await issueJoinLink(true);
  if (typeof issued === 'string') return { state: getState(), error: issued };
  joinLink = issued;
  return { state: getState() };
}

async function decide(requestId: string, approve: boolean): Promise<CommandResult> {
  const assertOwner = captureOwner();
  const owner = ownerBase();
  if (!owner) return { state: getState(), error: 'NOT_OWNER' };
  const view = pendingViews.get(requestId);
  const raw = pendingRaw.get(requestId);
  const tenantRequest = pendingTenants.get(requestId);
  let error: SelfHostedRelayErrorCode | undefined;
  try {
    if (tenantRequest) {
      // 其他账号:同意就是让它在中转上建自己的网络,看不到这台电脑和本账号的设备。
      const v2 = ownerAgentNetApi();
      if (!v2) throw new Error('NOT_OWNER');
      if (approve && !view?.verified) error = 'PAIR_PROOF_INVALID';
      else {
        await v2.request('POST', `/tenant-requests/${tenantRequest.requestId}/${approve ? 'approve' : 'reject'}`);
        assertOwner();
        if (approve) void refreshTenants();
      }
    } else if (!owner.credential) {
      // 只走 V2 的网络(别人分享来的):本账号其他设备的申请只有 V2 这一份。
      const v2Request = pendingAgentNet.get(requestId), v2 = ownerAgentNetApi();
      if (!v2Request || !v2) throw new Error('NOT_FOUND');
      if (!approve) await v2.request('POST', '/join-requests/' + v2Request.requestId + '/reject');
      else if (!view?.verified) error = 'PAIR_PROOF_INVALID';
      else {
        const secret = pairSecrets.find((s) => s.relayId === owner.relayId && s.agentNetCode === v2Request.joinCode)?.secret;
        if (!secret) throw new Error('PAIRING_PROOF_INVALID');
        const certificate = approveAgentNetMember(owner.relayId, v2Request, secret);
        await v2.request('POST', '/join-requests/' + v2Request.requestId + '/approve', { certificate });
      }
      assertOwner();
    } else if (approve) {
      // 配对证明对不上:公钥不是拿着这台电脑给出的链接的那台设备生成的(可能被中转替换),不能签发证书。
      if (!view?.verified || !raw) {
        error = 'PAIR_PROOF_INVALID';
      } else {
        const v2Request = pendingAgentNet.get(requestId), v2 = ownerAgentNetApi();
        if (v2Request && v2) {
          const secret = pairSecrets.find((s) => s.relayId === owner.relayId && s.agentNetCode === v2Request.joinCode)?.secret;
          if (!secret) throw new Error('PAIRING_PROOF_INVALID');
          const certificate = approveAgentNetMember(owner.relayId, v2Request, secret);
          await v2.request('POST', '/join-requests/' + v2Request.requestId + '/approve', { certificate }); assertOwner();
        }
        const cert = issueRelayDeviceCert(crypto, owner.seed, {
          relayId: owner.relayId,
          deviceId: raw.deviceId,
          publicKey: raw.publicKey,
          role: 'member',
          issuedAt: Date.now(),
        });
        await ownerFetch(`/relay/admin/pair-requests/${requestId}/approve`, { method: 'POST', body: { cert } });
        // 新设备拿到凭证后很快就会发消息:提前刷新证书,不让它的第一条消息被拒。
        setTimeout(refreshRelayCertificatesSoon, 3_000).unref?.();
      }
    } else {
      const v2Request = pendingAgentNet.get(requestId), v2 = ownerAgentNetApi();
      if (v2Request && v2) { await v2.request('POST', '/join-requests/' + v2Request.requestId + '/reject'); assertOwner(); }
      await ownerFetch(`/relay/admin/pair-requests/${requestId}/reject`, { method: 'POST' });
    }
  } catch (caught) {
    if (caught instanceof RelayOperationExpired) throw caught;
    // 申请可能已过期:刷新列表让界面反映真实状态。
    error = 'FAILED';
  }
  await refreshPendingRequests();
  return { state: getState(), error };
}

// ─── 分享给其他账号(§5.5) ───────────────────────────────────────────────────

/** 自己的中转(不是别人分享来的)的 V2 管理入口;别人分享来的网络不能再分享给其他账号。 */
function relayOwnerAgentNetApi(): AgentNetClient | null {
  return ownerBase()?.credential ? ownerAgentNetApi() : null;
}

/** 主人:重读这条中转分享给了哪些账号(打开中转页、同意或撤销之后)。 */
async function refreshTenants(): Promise<void> {
  if (tenantsReading) return;
  const assertOwner = captureOwner();
  tenantsReading = true;
  try {
    const v2 = relayOwnerAgentNetApi();
    if (!v2 || !(await relaySupportsTenants(v2))) {
      assertOwner();
      if (tenants !== null) {
        tenants = null;
        emitChanged();
      }
      return;
    }
    const body = await v2.request<{ tenants?: unknown[] }>('GET', '/tenants');
    assertOwner();
    const next = (body.tenants ?? []).flatMap((item): SelfHostedRelayTenantView[] => {
      const t = item as Record<string, unknown>;
      const tenantId = typeof t.networkId === 'string' && t.networkId.startsWith('private:') ? t.networkId.slice(8) : '';
      if (!/^[0-9a-f-]{36}$/.test(tenantId) || typeof t.accountName !== 'string' || typeof t.createdAt !== 'number') return [];
      return [{
        tenantId, accountName: t.accountName, devices: typeof t.devices === 'number' ? t.devices : 0,
        online: t.online === true, createdAt: new Date(t.createdAt).toISOString(),
      }];
    });
    if (JSON.stringify(next) !== JSON.stringify(tenants)) {
      tenants = next;
      emitChanged();
    }
  } catch (error) {
    // 中转暂时连不上:保留上次读到的列表。
    if (!(error instanceof RelayOperationExpired)) log.info('shared account list unavailable');
  } finally {
    tenantsReading = false;
  }
}

/** 主人:不再分享给这个账号。它在中转上的网络连同设备一起删掉,已连着的设备立刻断开。 */
async function revokeTenant(tenantId: string): Promise<CommandResult> {
  const assertOwner = captureOwner();
  const v2 = relayOwnerAgentNetApi();
  if (!v2) return { state: getState(), error: 'NOT_OWNER' };
  let error: SelfHostedRelayErrorCode | undefined;
  try {
    await v2.request('DELETE', '/tenants/' + encodeURIComponent('private:' + tenantId));
    assertOwner();
    tenants = tenants?.filter((tenant) => tenant.tenantId !== tenantId) ?? null;
    log.info('stopped sharing the relay with an account');
  } catch (caught) {
    if (caught instanceof RelayOperationExpired) throw caught;
    error = 'FAILED';
  }
  await refreshTenants();
  return { state: getState(), error };
}

// ─── 命令 ────────────────────────────────────────────────────────────────────

type CommandResult = {
  state: SelfHostedRelayState;
  error?: SelfHostedRelayErrorCode;
  peer?: PeerAgentNetReply;
  check?: SelfHostedRelayServerCheck;
  deploymentStatus?: SelfHostedRelayDeploymentStatus;
};

function requireReady(): SelfHostedRelayErrorCode | null {
  // 账号数据作用域提交之前不能读写中转配置(否则会落进临时命名空间)。
  if (isAppSessionBoundaryPending() || !authManager.getAuthState().isAuthenticated || !getActiveAppSession().dataOwnerId) return 'NOT_SIGNED_IN';
  if (!secureStorageAvailable()) return 'SECURE_STORAGE_UNAVAILABLE';
  return null;
}

/**
 * 退出加入的中转(尽力而为,中转不可达也照样在本机切回),并删掉本机在它上面的秘密。
 * 成员只退自己;别人分享来的中转上,这台电脑是本账号网络的主人,退出就把这个网络从中转上删掉,
 * 本账号经它加入的其他设备一起断开(界面上确认时说明)。
 */
async function leaveMemberRelay(): Promise<void> {
  const assertOwner = captureOwner();
  const relay = activeSelfHostedRelay();
  const sharedOwner = relay?.role === 'owner' && activeRelayOrigin() === 'join';
  if (!relay || (relay.role !== 'member' && !sharedOwner)) return;
  try {
    const legacy = relay.credential ? fetch(`${relay.baseUrl}/api/device-link/devices/${encodeURIComponent(relay.deviceId)}`, {
      method: 'DELETE',
      headers: { authorization: `CindyRelay ${relay.credential}` },
      signal: AbortSignal.timeout(5_000),
    }) : Promise.resolve();
    const resource = sharedOwner ? '/tenants/' + encodeURIComponent('private:' + relay.relayId) : '/devices/' + encodeURIComponent(relay.deviceId);
    const agentNet = readRelaySecrets(relay.relayId)?.agentNet
      ? Promise.resolve().then(() => agentNetClientForRelay(relay.relayId, relay.baseUrl).request('DELETE', resource, undefined, { signal: AbortSignal.timeout(5_000) })) : Promise.resolve();
    await Promise.allSettled([legacy, agentNet]);
  } catch {
    log.info('could not notify the relay before leaving; switching locally');
  }
  assertOwner();
  deleteRelaySecrets(relay.relayId);
  // Retire the old connection before the caller resumes on the official route.
  restartDeviceLinkForRelayChange();
}

/** 切换到另一个中转前收尾:成员退出;本机中转停掉(不通知成员停用,切回时还能接着用)。 */
async function leaveCurrent(): Promise<void> {
  const assertOwner = captureOwner();
  cancelJoin();
  await leaveMemberRelay();
  assertOwner();
  stopPairing();
}

async function enableHost(command: Extract<SelfHostedRelayCommand, { type: 'enable-host' }>): Promise<CommandResult> {
  const assertOwner = captureOwner();
  const notReady = requireReady();
  if (notReady) return { state: getState(), error: notReady };
  if (command.externalUrl && !/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(command.externalUrl)) {
    return { state: getState(), error: 'INVALID_LINK' };
  }
  await leaveCurrent();
  assertOwner();
  const previous = readRelayConfig();
  const config: RelayConfig = {
    ...previous,
    active: null,
    host: { ...previous.host, enabled: true, port: command.port, listenAll: command.listenAll, externalUrl: command.externalUrl },
  };
  writeRelayConfig(config);
  // Clearing an active route must retire its connection before host startup yields.
  if (previous.active) restartDeviceLinkForRelayChange();
  await startHost(config);
  assertOwner();
  const relayId = readRelayConfig().host.relayId;
  const secrets = relayId ? readRelaySecrets(relayId) : null;
  if (!host || !relayId || !secrets) {
    writeRelayConfig({ ...readRelayConfig(), host: { ...readRelayConfig().host, enabled: false }, active: null });
    restartDeviceLinkForRelayChange();
    return { state: getState(), error: hostError ?? 'START_FAILED' };
  }
  const relayInfo = (await fetch(`${localBaseUrl(host.port)}/api/device-link/relay/info`).then((r) => r.json())) as { name: string };
  assertOwner();
  writeRelayConfig({
    ...readRelayConfig(),
    active: {
      relayId,
      name: relayInfo.name,
      baseUrl: localBaseUrl(host.port),
      role: 'owner',
      origin: 'host',
      deviceId: authManager.getDeviceId(),
      ownerPublicKey: relayPublicKeyOf(crypto, secrets.seed)!,
    },
  });
  // Publish the route and synchronously retire the old token/connection in one turn.
  restartDeviceLinkForRelayChange();
  // 中转所在电脑一休眠,所有设备都会断开:开启时顺带打开「保持唤醒」。
  if (!readDeviceLinkSettings().keepAwake) await setKeepAwakeEnabled(true).catch(() => undefined);
  assertOwner();
  return { state: getState() };
}

async function useOfficial(): Promise<CommandResult> {
  const assertOwner = captureOwner();
  cancelJoin();
  const config = readRelayConfig();
  const origin = activeRelayOrigin();
  if (origin === 'host' || config.host.enabled) await stopHost(true);
  else await leaveMemberRelay();
  assertOwner();
  stopPairing();
  if (requireReady() !== 'NOT_SIGNED_IN') {
    writeRelayConfig({ ...readRelayConfig(), active: null, host: { ...readRelayConfig().host, enabled: false } });
  }
  restartDeviceLinkForRelayChange();
  return { state: getState() };
}

function cancelJoin(): void {
  joinAbort?.abort();
  joinAbort = null;
  if (join.status === 'connecting' || join.status === 'waiting') join = { status: 'idle' };
}

/** 同账号加入在拿到链接之前出的错(主人电脑没回应、已不在用那个中转、账号服务连不上)。 */
class AccountJoinError extends Error {
  constructor(readonly code: SelfHostedRelayErrorCode) {
    super(code);
  }
}

type JoinSource = { kind: 'link'; link: RelayJoinLink } | { kind: 'account'; offer: RelayAccountOffer };

/**
 * 加入别的中转:粘贴的分享链接,或同账号另一台电脑回写的链接 → 申请 → 等放行 → 保存凭证并切换。
 * 同账号加入用事先登记在账号里的签名公钥申请,主人电脑核对后自动放行,不显示配对码。
 */
function startJoin(source: JoinSource): CommandResult {
  const assertOwner = captureOwner();
  const notReady = requireReady();
  if (notReady) return { state: getState(), error: notReady };
  // 粘贴链接时本机不能正开着中转;同账号加入已在界面上确认会停用本机中转。
  if (source.kind === 'link' && readRelayConfig().host.enabled) return { state: getState(), error: 'HOSTING' };
  cancelJoin();
  const abort = new AbortController();
  joinAbort = abort;
  const accountRelayId = source.kind === 'account' ? source.offer.relayId : undefined;
  const marker = accountRelayId ? { accountRelayId } : {};
  join = { status: 'connecting', ...marker };
  const accountUserId = authManager.getCurrentUserId();
  const deviceId = authManager.getDeviceId();
  void (async () => {
    try {
      let link: RelayJoinLink;
      let presetKey: RelaySigningKey | undefined;
      if (source.kind === 'account') {
        // 先看中转连不连得上:连不上就不用去等那台电脑回话(本机中转连不上就是那台电脑不在线)。
        await fetchRelayInfo(relayFetch, source.offer.baseUrl, AbortSignal.any([abort.signal, AbortSignal.timeout(8_000)])).catch((error) => {
          if (abort.signal.aborted) throw error;
          const code = error instanceof RelayJoinError ? error.code : 'UNREACHABLE';
          throw code === 'UNREACHABLE' && source.offer.kind === 'host' ? new AccountJoinError('OWNER_UNAVAILABLE') : new RelayJoinError(code, 'relay probe failed');
        });
        assertOwner();
        if (abort.signal.aborted) return;
        if (readRelayConfig().host.enabled) {
          await retireHost();
          assertOwner();
          if (abort.signal.aborted) return;
        }
        presetKey = createRelaySigningKey(crypto);
        link = await requestAccountInvite(source.offer, presetKey, abort.signal, assertOwner);
      } else {
        link = source.link;
      }
      const info = await fetchRelayInfo(relayFetch, link.baseUrl, abort.signal);
      assertOwner();
      if (abort.signal.aborted) return;
      // 别人分享给本账号的中转:目录里的 ID 是本账号在上面的网络,不是中转本身的 ID。
      const sharedOffer = source.kind === 'account' && source.offer.kind === 'shared' ? source.offer : null;
      if (source.kind === 'account' && !sharedOffer && info.relayId !== source.offer.relayId) throw new AccountJoinError('RELAY_UNAVAILABLE');
      if (source.kind === 'link' && accountUserId && isRelayLinkForOtherAccount(crypto, link, accountUserId)) {
        await joinAsTenant(link, info.name, abort, assertOwner, accountUserId);
        return;
      }
      if (!link.code) {
        if (!accountUserId) throw new RelayJoinError('FAILED', 'not signed in');
        await joinAgentNetOnly({
          link, name: sharedOffer?.name ?? info.name, sharedBy: sharedOffer?.sharedBy ?? null, presetKey, abort, assertOwner, accountUserId, marker,
        });
        return;
      }
      const identity = createRelayJoinIdentity(crypto, link, info.relayId, deviceId, presetKey);
      const agentIdentity = link.agentNetCode ? memberAgentNetIdentity(info.relayId, identity.seed, deviceId) : null;
      const v2Request = agentIdentity ? createJoinRequest(agentIdentity, 'private:' + info.relayId, link.agentNetCode!, deviceName().slice(0, 64), link.pairSecret) : null;
      const v2Poll = v2Request ? await submitJoin(link.baseUrl, v2Request, { ownerPinnedHttp: true, fetch: outboundFetch }) : null;
      assertOwner(); if (abort.signal.aborted) return;
      const request = await submitRelayPairRequest(
        relayFetch,
        link,
        {
          deviceId,
          deviceName: deviceName(),
          platform: process.platform,
          appVersion: app.getVersion(),
          accountUserId: accountUserId ?? '',
          publicKey: identity.publicKey,
          proof: identity.proof,
        },
        abort.signal,
      );
      assertOwner();
      if (abort.signal.aborted) return;
      join = { status: 'waiting', relayName: info.name, verifyCode: request.verifyCode, ...marker };
      emitChanged();
      const result = await waitForRelayApproval(relayFetch, link, request, { signal: abort.signal });
      assertOwner();
      // 等待期间换了账号:凭证属于旧账号,不能写进新账号的配置。
      if (abort.signal.aborted || authManager.getCurrentUserId() !== accountUserId) return;
      // 证书必须出自链接里的主人、发给本机这把公钥;否则中转可能被人替换,不加入。
      acceptRelayDeviceCert(crypto, link, { relayId: info.relayId, deviceId, publicKey: identity.publicKey, cert: result.cert });
      const v2Result = v2Request && v2Poll ? await pollJoin(link.baseUrl, link.ownerPublicKey, v2Request.networkId, v2Request.requestId, v2Poll.pollToken, { ownerPinnedHttp: true, fetch: outboundFetch }) : null;
      assertOwner(); if (abort.signal.aborted) return;
      if (v2Request && (!v2Result?.certificate || v2Result.status !== 'approved' || v2Result.certificate.subject !== accountUserId)) throw new RelayJoinError('FAILED', 'Agent-Net pairing did not complete');
      const agentNet = agentIdentity && v2Result?.certificate ? memberAgentNetSecrets(agentIdentity, v2Result.certificate, link.ownerPublicKey) : undefined;
      // 之前加入的中转先退出(不能用 leaveCurrent:它会取消正在进行的这次加入)。
      await leaveMemberRelay();
      assertOwner();
      if (abort.signal.aborted) return;
      stopPairing();
      writeRelaySecrets(info.relayId, { credential: result.credential, seed: identity.seed, ...(agentNet ? { agentNet } : {}) });
      writeRelayConfig({
        ...readRelayConfig(),
        active: {
          relayId: info.relayId,
          name: source.kind === 'account' ? source.offer.name : info.name,
          baseUrl: link.baseUrl,
          role: 'member',
          origin: 'join',
          deviceId,
          ownerPublicKey: link.ownerPublicKey,
        },
      });
      join = { status: 'joined', relayName: info.name };
      restartDeviceLinkForRelayChange();
    } catch (error) {
      if (abort.signal.aborted || error instanceof RelayOperationExpired) return;
      const code = error instanceof RelayJoinError || error instanceof AccountJoinError ? error.code : 'FAILED';
      // 别的账号的中转、链接里又没有给其他账号用的邀请:这条中转还不能分享给其他账号。
      const unsupported = code === 'ACCOUNT_MISMATCH' && source.kind === 'link' && !source.link.tenantCode;
      join = { status: 'failed', error: unsupported ? 'SHARE_UNSUPPORTED' : code, ...marker };
    } finally {
      if (joinAbort === abort) joinAbort = null;
      emitChanged();
    }
  })();
  return { state: getState() };
}

/** 等对方同意的最长时间(与中转上申请的有效期一致)。 */
const JOIN_WAIT_MS = 10 * 60 * 1000;
const agentNetTransport = { ownerPinnedHttp: true, fetch: outboundFetch };

function agentNetSubmitError(error: unknown): never {
  if (error instanceof AgentNetClientError) {
    if (error.code === 'JOIN_CODE_INVALID' || error.code === 'TENANT_INVITE_INVALID') throw new RelayJoinError('CODE_INVALID', error.code);
    if (error.status === 429) throw new RelayJoinError('RATE_LIMITED', error.code);
    if (error.status === 404) throw new AccountJoinError('SHARE_UNSUPPORTED');
  }
  throw new RelayJoinError('UNREACHABLE', 'agent-net request failed');
}

/** 轮询中的一次失败:申请已失效就停,暂时连不上就接着等。 */
function agentNetPollError(error: unknown): null {
  if (error instanceof AgentNetClientError && error.code === 'POLL_TOKEN_INVALID') throw new RelayJoinError('EXPIRED', 'request expired');
  if (error instanceof Error && error.message === 'UNTRUSTED_NETWORK_CERTIFICATE') throw new RelayJoinError('OWNER_MISMATCH', error.message);
  return null;
}

/**
 * 别的账号分享来的链接(§5.5):在那台中转上建本账号自己的网络,本机是这个网络的主人。
 * 根密钥只在本机;两边显示同一个配对码,分享者同意后切换过去。本账号的其他设备之后经账号目录一键加入。
 */
async function joinAsTenant(link: RelayJoinLink, relayName: string, abort: AbortController, assertOwner: () => void, accountUserId: string): Promise<void> {
  if (!link.tenantCode) throw new AccountJoinError('SHARE_UNSUPPORTED');
  const networkId = randomUUID();
  const seed = createRelaySigningKey(crypto).seed;
  const name = relayName.trim().slice(0, 64) || 'Cindy';
  let adopted = false;
  try {
    const request = createAgentNetTenantRequest(networkId, seed, {
      name,
      accountName: (authManager.getCurrentMembershipDisplayName() ?? deviceName()).trim().slice(0, 64) || 'Cindy',
      inviteCode: link.tenantCode,
      pairingSecret: link.pairSecret,
    });
    const submitted = await submitTenantJoin(link.baseUrl, request, agentNetTransport).catch(agentNetSubmitError);
    assertOwner();
    if (abort.signal.aborted) return;
    join = { status: 'waiting', relayName: name, verifyCode: tenantVerifyCode(request) };
    emitChanged();
    const deadline = Date.now() + JOIN_WAIT_MS;
    for (;;) {
      await delay(INVITE_POLL_MS, abort.signal);
      assertOwner();
      const result = await pollTenantJoin(link.baseUrl, request.requestId, submitted.pollToken, agentNetTransport).catch(agentNetPollError);
      if (result?.status === 'approved') break;
      if (result?.status === 'rejected') throw new RelayJoinError('REJECTED', 'owner rejected');
      if (Date.now() > deadline) throw new RelayJoinError('EXPIRED', 'owner did not respond');
    }
    // 中转上真有这个网络、认的是本机的根公钥,才切换过去。
    await agentNetClientForRelay(networkId, link.baseUrl).directory();
    assertOwner();
    if (abort.signal.aborted || authManager.getCurrentUserId() !== accountUserId) return;
    await leaveMemberRelay();
    assertOwner();
    if (abort.signal.aborted) return;
    stopPairing();
    writeRelayConfig({
      ...readRelayConfig(),
      active: {
        relayId: networkId, name, baseUrl: link.baseUrl, role: 'owner', origin: 'join',
        deviceId: authManager.getDeviceId(), ownerPublicKey: relayPublicKeyOf(crypto, seed)!, shared: { ownerName: link.ownerName ?? null },
      },
    });
    adopted = true;
    join = { status: 'joined', relayName: name };
    log.info('joined a relay shared by another account');
    restartDeviceLinkForRelayChange();
  } finally {
    if (!adopted) deleteRelaySecrets(networkId);
  }
}

/**
 * 加入只走 V2 的网络:别人分享给本账号、由本账号另一台电脑建的那个。只提交 V2 申请,没有旧版凭证;
 * 同账号加入由那台电脑核对登记的公钥后自动放行。
 */
async function joinAgentNetOnly(input: {
  link: RelayJoinLink; name: string; sharedBy: string | null; presetKey?: RelaySigningKey; abort: AbortController;
  assertOwner: () => void; accountUserId: string; marker: { accountRelayId?: string };
}): Promise<void> {
  const { link, abort, assertOwner, accountUserId, marker } = input;
  if (!link.relayId || !link.agentNetCode) throw new RelayJoinError('INCOMPATIBLE', 'not an agent-net link');
  const relayId = link.relayId;
  const deviceId = authManager.getDeviceId();
  const name = input.name.trim().slice(0, 64) || 'Cindy';
  const seed = input.presetKey?.seed ?? createRelaySigningKey(crypto).seed;
  const identity = memberAgentNetIdentity(relayId, seed, deviceId);
  const request = createJoinRequest(identity, 'private:' + relayId, link.agentNetCode, deviceName().slice(0, 64) || 'Cindy', link.pairSecret);
  const submitted = await submitJoin(link.baseUrl, request, agentNetTransport).catch(agentNetSubmitError);
  assertOwner();
  if (abort.signal.aborted) return;
  join = { status: 'waiting', relayName: name, verifyCode: relayPairingVerifyCode(crypto, request.pairingProof), ...marker };
  emitChanged();
  const deadline = Date.now() + JOIN_WAIT_MS;
  let certificate: NonNullable<Awaited<ReturnType<typeof pollJoin>>['certificate']> | undefined;
  while (!certificate) {
    await delay(INVITE_POLL_MS, abort.signal);
    assertOwner();
    const result = await pollJoin(link.baseUrl, link.ownerPublicKey, request.networkId, request.requestId, submitted.pollToken, agentNetTransport)
      .catch(agentNetPollError);
    if (result?.status === 'approved' && result.certificate) certificate = result.certificate;
    else if (result?.status === 'rejected') throw new RelayJoinError('REJECTED', 'owner rejected');
    else if (Date.now() > deadline) throw new RelayJoinError('EXPIRED', 'owner did not respond');
  }
  // 只走 V2 的网络各属于一个账号:证书必须签给本账号。
  if (certificate.subject !== accountUserId) throw new RelayJoinError('ACCOUNT_MISMATCH', 'certificate for another account');
  const agentNet = memberAgentNetSecrets(identity, certificate, link.ownerPublicKey);
  if (abort.signal.aborted || authManager.getCurrentUserId() !== accountUserId) return;
  await leaveMemberRelay();
  assertOwner();
  if (abort.signal.aborted) return;
  stopPairing();
  writeRelaySecrets(relayId, { credential: '', seed, agentNet });
  writeRelayConfig({
    ...readRelayConfig(),
    active: {
      relayId, name, baseUrl: link.baseUrl, role: 'member', origin: 'join', deviceId,
      ownerPublicKey: link.ownerPublicKey, shared: { ownerName: input.sharedBy },
    },
  });
  join = { status: 'joined', relayName: name };
  restartDeviceLinkForRelayChange();
}

/** 停用本机中转、回到官方线路(同账号加入前用;不取消正在进行的加入)。 */
async function retireHost(): Promise<void> {
  const assertOwner = captureOwner();
  await stopHost(true);
  assertOwner();
  stopPairing();
  writeRelayConfig({ ...readRelayConfig(), active: null, host: { ...readRelayConfig().host, enabled: false } });
  restartDeviceLinkForRelayChange();
}

// ─── 同账号中转目录 ──────────────────────────────────────────────────────────

const ACCOUNT_REFRESH_MIN_MS = 30_000;
const OFFER_RETRY_MS = 60_000;
const INVITE_POLL_MS = 2_000;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

/** 这台电脑用过自建中转(部署过、开过或加入过);从没用过的不碰账号里的中转目录。 */
function hasRelayHistory(): boolean {
  const config = readRelayConfig();
  return config.deployments.length > 0 || Boolean(config.host.relayId) || config.active !== null;
}

/**
 * 这台电脑作为主人正在用的中转;只提供这一个,别的设备据此列出「我的中转」。
 * 别人分享来的中转上,这台电脑是本账号网络的主人,也提供出来(`shared`),本账号其他设备一键加入。
 */
function currentOffer(): Omit<RelayAccountOffer, 'ownerDeviceId' | 'updatedAt'> | null {
  const relay = activeSelfHostedRelay();
  const origin = activeRelayOrigin();
  if (!relay || relay.role !== 'owner') return null;
  if (origin === 'join') {
    const shared = readRelayConfig().active?.shared;
    return shared ? {
      ownerDeviceName: deviceName().slice(0, 64) || 'Cindy', relayId: relay.relayId, name: relay.name, baseUrl: relay.baseUrl,
      ownerPublicKey: relay.ownerPublicKey, kind: 'shared', sharedBy: shared.ownerName,
    } : null;
  }
  if (origin !== 'server' && origin !== 'host') return null;
  const baseUrl = origin === 'host' ? (host ? hostJoinBaseUrl(readRelayConfig()) : null) : relay.baseUrl;
  if (!baseUrl) return null;
  return {
    ownerDeviceName: deviceName().slice(0, 64) || 'Cindy',
    relayId: relay.relayId,
    name: relay.name,
    baseUrl,
    ownerPublicKey: relay.ownerPublicKey,
    kind: origin,
  };
}

/** 正在用的中转变了就同步到账号(随状态推送调用;没变化时不请求)。 */
function scheduleOfferSync(): void {
  if (requireReady() || !hasRelayHistory()) return;
  const offer = currentOffer();
  const key = JSON.stringify(offer);
  if (key === publishedOffer) return;
  if (offerSyncing) {
    offerSyncAgain = true;
    return;
  }
  // 账号服务暂时连不上:隔一会儿再试,不随每次状态推送反复请求。
  if (Date.now() - offerSyncFailedAt < OFFER_RETRY_MS) return;
  offerSyncing = true;
  const assertOwner = captureOwner();
  const myId = authManager.getDeviceId();
  void updateAccountPreference(RELAY_OFFERS_PREFERENCE, (value) => {
    const mine = parseRelayAccountOffers(value).find((item) => item.ownerDeviceId === myId);
    const same = !!mine && !!offer && mine.relayId === offer.relayId && mine.name === offer.name && mine.baseUrl === offer.baseUrl
      && mine.ownerPublicKey === offer.ownerPublicKey && mine.kind === offer.kind && mine.ownerDeviceName === offer.ownerDeviceName
      && (mine.sharedBy ?? null) === (offer.sharedBy ?? null);
    if ((!mine && !offer) || same) return undefined;
    return withRelayAccountOffer(value, myId, offer, Date.now());
  })
    .then(() => {
      assertOwner();
      publishedOffer = key;
      // 离线期间同账号设备可能已经来申请过:上线后看一次。
      if (offer) void answerAccountJoinRequests();
    })
    .catch((error) => {
      if (error instanceof RelayOperationExpired) return;
      offerSyncFailedAt = Date.now();
      log.warn('could not publish this computer\'s relay to the account');
    })
    .finally(() => {
      offerSyncing = false;
      if (offerSyncAgain) {
        offerSyncAgain = false;
        scheduleOfferSync();
      }
    });
}

/**
 * 主人电脑:回写同账号设备的加入申请——向正在用的中转要一个加入码,把一次性链接写回账号,
 * 并记下申请里的公钥,中转上出现这把公钥的申请时直接放行。已不在用那个中转时回写 RELAY_UNAVAILABLE。
 */
async function answerAccountJoinRequests(): Promise<void> {
  if (accountRequestsReading) {
    accountRequestsAgain = true;
    return;
  }
  if (requireReady() || !hasRelayHistory()) return;
  accountRequestsReading = true;
  const assertOwner = captureOwner();
  try {
    const myId = authManager.getDeviceId();
    const board = parseRelayAccountJoinBoard((await readAccountPreference(RELAY_JOIN_PREFERENCE)).value, Date.now());
    assertOwner();
    // 只回了「收到」、还没给链接的(例如回写前这台电脑重启了)照样要处理。
    const mine = Object.values(board.requests).filter((request) => {
      const invite = board.invites[request.deviceId];
      return request.ownerDeviceId === myId && !answeredAccountRequests.has(request.requestId)
        && (invite?.requestId !== request.requestId || invite.pending === true);
    });
    if (mine.length === 0) return;
    for (const request of mine) answeredAccountRequests.add(request.requestId);
    // 先回一声「收到」:加入方据此知道这台电脑在线,向中转要加入码可能还要几秒。
    await updateAccountPreference(RELAY_JOIN_PREFERENCE, (value) => {
      const current = parseRelayAccountJoinBoard(value, Date.now());
      let changed = false;
      for (const request of mine) {
        if (current.requests[request.deviceId]?.requestId !== request.requestId || current.invites[request.deviceId]?.requestId === request.requestId) continue;
        current.invites[request.deviceId] = {
          requestId: request.requestId, relayId: request.relayId, pending: true, expiresAt: Date.now() + RELAY_ACCOUNT_JOIN_TTL_MS,
        };
        changed = true;
      }
      return changed ? serializeRelayAccountJoinBoard(current) : undefined;
    }).catch(() => log.info('could not acknowledge a join request; answering directly'));
    assertOwner();
    const answers: Array<[string, RelayAccountJoinInvite]> = [];
    for (const request of mine) {
      const offer = currentOffer();
      const unavailable: RelayAccountJoinInvite = {
        requestId: request.requestId, relayId: request.relayId, error: 'RELAY_UNAVAILABLE', expiresAt: Date.now() + RELAY_ACCOUNT_JOIN_TTL_MS,
      };
      if (!offer || offer.relayId !== request.relayId) {
        answers.push([request.deviceId, unavailable]);
        continue;
      }
      const issued = await issueJoinLink(false);
      assertOwner();
      if (typeof issued === 'string') {
        answers.push([request.deviceId, unavailable]);
        continue;
      }
      autoApprovals.push({ relayId: offer.relayId, deviceId: request.deviceId, publicKey: request.publicKey, expiresAt: issued.expiresAt + JOIN_LINK_TTL_MS });
      answers.push([request.deviceId, { requestId: request.requestId, relayId: request.relayId, link: issued.link, expiresAt: issued.expiresAt }]);
      log.info('answered a join request from a device of this account');
    }
    await updateAccountPreference(RELAY_JOIN_PREFERENCE, (value) => {
      const current = parseRelayAccountJoinBoard(value, Date.now());
      let changed = false;
      for (const [deviceId, invite] of answers) {
        if (current.requests[deviceId]?.requestId !== invite.requestId) continue;
        current.invites[deviceId] = invite;
        changed = true;
      }
      return changed ? serializeRelayAccountJoinBoard(current) : undefined;
    });
  } catch (error) {
    if (!(error instanceof RelayOperationExpired)) log.warn('could not answer join requests from this account');
  } finally {
    accountRequestsReading = false;
    if (accountRequestsAgain) {
      accountRequestsAgain = false;
      void answerAccountJoinRequests();
    }
  }
}

/** 加入方:登记签名公钥,等主人电脑回写一次性链接;用完就从账号里撤下。 */
async function requestAccountInvite(
  offer: RelayAccountOffer,
  key: RelaySigningKey,
  signal: AbortSignal,
  assertOwner: () => void,
): Promise<RelayJoinLink> {
  const deviceId = authManager.getDeviceId();
  const requestId = randomUUID();
  const edit = (change: (board: RelayAccountJoinBoard) => boolean) =>
    updateAccountPreference(RELAY_JOIN_PREFERENCE, (value) => {
      const board = parseRelayAccountJoinBoard(value, Date.now());
      return change(board) ? serializeRelayAccountJoinBoard(board) : undefined;
    });
  try {
    await edit((board) => {
      board.requests[deviceId] = {
        requestId, deviceId, deviceName: deviceName().slice(0, 128) || 'Cindy', platform: process.platform,
        relayId: offer.relayId, ownerDeviceId: offer.ownerDeviceId, publicKey: key.publicKey, createdAt: Date.now(),
      };
      delete board.invites[deviceId];
      return true;
    });
  } catch (error) {
    if (error instanceof RelayOperationExpired) throw error;
    throw new AccountJoinError('ACCOUNT_DIRECTORY_UNAVAILABLE');
  }
  assertOwner();
  let invite: RelayAccountJoinInvite | null = null;
  try {
    const started = Date.now();
    // 那台电脑在线时很快会先回一声「收到」;等不到就直接提示,不必等满。
    let acknowledged = false;
    while (!invite) {
      const waited = Date.now() - started;
      if (waited > RELAY_ACCOUNT_INVITE_WAIT_MS || (!acknowledged && waited > RELAY_ACCOUNT_ACK_WAIT_MS)) {
        throw new AccountJoinError('OWNER_UNAVAILABLE');
      }
      await delay(INVITE_POLL_MS, signal);
      assertOwner();
      try {
        const found = parseRelayAccountJoinBoard((await readAccountPreference(RELAY_JOIN_PREFERENCE)).value, Date.now()).invites[deviceId];
        if (found?.requestId === requestId) {
          if (found.pending) acknowledged = true;
          else invite = found;
        }
      } catch {
        // 暂时读不到:接着等,到时间再报主人电脑没回应。
      }
    }
  } finally {
    // 申请和回写的链接用完就撤下,账号里不留一次性链接。
    void edit((board) => {
      let changed = false;
      if (board.requests[deviceId]?.requestId === requestId) { delete board.requests[deviceId]; changed = true; }
      if (board.invites[deviceId]?.requestId === requestId) { delete board.invites[deviceId]; changed = true; }
      return changed;
    }).catch(() => undefined);
  }
  if (!invite) throw new AccountJoinError('OWNER_UNAVAILABLE');
  const link = invite.link ? parseRelayJoinLink(invite.link) : null;
  // 链接里的主人公钥必须与目录里这台电脑的一致,不认别的主人签的证书。
  if (invite.error || !link || link.ownerPublicKey !== offer.ownerPublicKey) throw new AccountJoinError('RELAY_UNAVAILABLE');
  return link;
}

/** 加入方:重读同账号其他电脑正在用的中转(打开中转页时;收到变更通知时强制)。 */
async function refreshAccountRelays(force: boolean): Promise<void> {
  if (requireReady()) return;
  if (!force && Date.now() - accountOffersReadAt < ACCOUNT_REFRESH_MIN_MS) return;
  if (accountOffersReading) return accountOffersReading;
  const assertOwner = captureOwner();
  // 同时只读一次:读的期间再来的请求等这一次的结果。
  accountOffersReading = (async () => {
    try {
      const offers = parseRelayAccountOffers((await readAccountPreference(RELAY_OFFERS_PREFERENCE)).value);
      assertOwner();
      accountOffersReadAt = Date.now();
      if (JSON.stringify(offers) !== JSON.stringify(accountOffers)) {
        accountOffers = offers;
        emitChanged();
      }
    } catch (error) {
      if (!(error instanceof RelayOperationExpired)) log.info('account relay list unavailable');
    } finally {
      accountOffersReading = null;
    }
  })();
  return accountOffersReading;
}

function accountRelayViews(): SelfHostedRelayAccountRelayView[] {
  const myId = authManager.getDeviceId();
  return accountOffers
    .filter((offer) => offer.ownerDeviceId !== myId)
    .map(({ ownerDeviceId, ownerDeviceName, relayId, name, baseUrl, kind, sharedBy }) => ({
      ownerDeviceId, ownerDeviceName, relayId, name, baseUrl, kind, ...(kind === 'shared' ? { sharedBy: sharedBy ?? null } : {}),
    }));
}

function resetAccountDirectory(): void {
  tenants = null;
  tenantSupport = null;
  accountOffers = [];
  accountOffersReadAt = 0;
  accountOffersReading = null;
  publishedOffer = null;
  offerSyncFailedAt = 0;
  autoApprovals = [];
  answeredAccountRequests = new Set();
}

/**
 * Chat Server 推送这个账号的记录有变(同账号其他设备写了中转目录或加入申请)。
 * 这台电脑自己的写入也会推送回来,读一次即可,不会循环。
 */
export function notifyRelayAccountPreferenceChanged(key: string): void {
  if (key === RELAY_OFFERS_PREFERENCE) void refreshAccountRelays(true);
  else if (key === RELAY_JOIN_PREFERENCE) void answerAccountJoinRequests();
}

// ─── 部署到服务器 ────────────────────────────────────────────────────────────

function deploymentActive(deployment: RelayDeployment): RelayConfig['active'] {
  return {
    relayId: deployment.relayId,
    name: deployment.name,
    baseUrl: deployment.baseUrl,
    role: 'owner',
    origin: 'server',
    deviceId: authManager.getDeviceId(),
    ownerPublicKey: deployment.ownerPublicKey,
  };
}

type DeployJobPlan = Pick<SelfHostedRelayDeployJobView, 'action' | 'target' | 'serverChanged' | 'relayId'> & { steps: RelayDeployStep[] };

function findDeployment(config: RelayConfig, relayId: string): RelayDeployment | null {
  return config.deployments.find((deployment) => deployment.relayId === relayId) ?? null;
}

/** 写入一条部署记录:同一个中转或同一台服务器的旧记录原位替换(一台服务器一个中转),否则加在最后。 */
function withDeployment(deployments: RelayDeployment[], record: RelayDeployment): RelayDeployment[] {
  const same = (deployment: RelayDeployment) => deployment.relayId === record.relayId || deployment.sshHostId === record.sshHostId;
  const index = deployments.findIndex(same);
  if (index < 0) return [...deployments, record];
  return deployments.flatMap((deployment, i) => (i === index ? [record] : same(deployment) ? [] : [deployment]));
}

function runDeployJob(plan: DeployJobPlan, work: (onStep: (step: SelfHostedRelayDeployJobView['step']) => void, assertOwner: () => void, onProgress: (message: RelayDeployProgressMessage) => void) => Promise<void>): void {
  const { action } = plan;
  const assertOwner = captureOwner();
  const isCurrent = () => {
    try { assertOwner(); return true; } catch { return false; }
  };
  const startedAt = Date.now();
  const first = plan.steps[0];
  deployJob = { ...plan, step: first, status: 'running', startedAt, logs: [{ at: startedAt, step: first }] };
  log.info('relay deployment started', { action });
  const appendProgress = (step: SelfHostedRelayDeployJobView['step'], message?: RelayDeployProgressMessage) => {
    if (!isCurrent() || deployJob?.status !== 'running') return;
    const logs = deployJob.logs ?? [];
    const last = logs.at(-1);
    if (last?.step === step && last.message === message) return;
    deployJob = { ...deployJob, step, logs: [...logs.slice(-99), { at: Date.now(), step, ...(message ? { message } : {}) }] };
    emitChanged();
  };
  const onStep = (step: SelfHostedRelayDeployJobView['step']) => {
    assertOwner();
    appendProgress(step);
    log.info('relay deployment step', { action, step });
  };
  const onProgress = (message: RelayDeployProgressMessage) => {
    if (deployJob) appendProgress(deployJob.step, message);
  };
  void work(onStep, assertOwner, onProgress)
    .then(() => {
      if (!isCurrent()) return;
      deployJob = { ...deployJob!, action, step: 'finish', status: 'done', finishedAt: Date.now() };
      log.info('relay deployment completed', { action });
    })
    .catch((error: unknown) => {
      if (!isCurrent()) return;
      const step = deployJob?.step ?? 'connect';
      if (error instanceof RelayDeployError) {
        log.warn('relay deployment failed', { action, step, code: error.code });
        deployJob = { ...deployJob!, action, step, status: 'failed', error: error.code, detail: error.detail, finishedAt: Date.now() };
      } else {
        log.warn('relay deployment failed', { action, step, code: 'DEPLOY_FAILED', reason: error instanceof Error ? error.name : 'unknown' });
        deployJob = { ...deployJob!, action, step, status: 'failed', error: 'DEPLOY_FAILED', detail: error instanceof Error ? error.message.slice(0, 300) : undefined, finishedAt: Date.now() };
      }
    })
    .finally(() => { if (isCurrent()) emitChanged(); });
}

/**
 * 部署或升级。身份(中转 ID、主人秘密)跟着这台服务器的部署记录走:重试与升级都保留它。
 * 检查通过、第一次改动服务器前才保存记录和新身份:在检查阶段停下的部署不留下任何东西。
 * 部署完成只保存记录,不切换线路;正在用的就是这个中转时(升级、重新部署)按新记录重连。
 */
function deploy(input: { sshHostId: string; address: string; name: string; replaceExisting: boolean }, action: 'deploy' | 'upgrade'): CommandResult {
  const notReady = requireReady();
  if (notReady) return { state: getState(), error: notReady };
  if (deployJob?.status === 'running') return { state: getState(), error: 'BUSY' };
  if (!bundledRelayVersion()) return { state: getState(), error: 'BUNDLE_MISSING' };
  const previous = readRelayConfig().deployments.find((deployment) => deployment.sshHostId === input.sshHostId) ?? null;
  const reuse = previous && !input.replaceExisting ? readRelaySecrets(previous.relayId) : null;
  const relayId = reuse && previous ? previous.relayId : randomUUID();
  const secrets = reuse ?? generateOwnerSecrets();
  const init = ownerInitArgs(relayId, secrets, input.name);
  const baseUrl = relayBaseUrlForAddress(input.address);
  const record: RelayDeployment = {
    sshHostId: input.sshHostId,
    address: input.address,
    baseUrl,
    relayId,
    name: input.name,
    ownerPublicKey: init.ownerPublicKey,
    relayVersion: previous?.relayId === relayId ? previous.relayVersion : '',
    deployedAt: new Date().toISOString(),
    complete: false,
  };
  const persist = () => {
    const config = readRelayConfig();
    const old = config.deployments.find((deployment) => deployment.sshHostId === input.sshHostId) ?? null;
    let replacedActive = false;
    if (old && old.relayId !== relayId) {
      // 清掉这台服务器上原来的中转重来:旧身份作废。正在用它时先切回官方,不留下指向已删秘密的配置。
      replacedActive = config.active?.relayId === old.relayId;
      if (replacedActive) {
        stopPairing();
        config.active = null;
      }
      deleteRelaySecrets(old.relayId);
    }
    if (!reuse) writeRelaySecrets(relayId, secrets);
    // 升级沿用原记录:失败时服务器上仍是这一份中转,那一行照常显示,可以重试。
    if (!(action === 'upgrade' && old?.relayId === relayId)) writeRelayConfig({ ...config, deployments: withDeployment(config.deployments, record) });
    if (deployJob) deployJob = { ...deployJob, serverChanged: true };
    if (replacedActive) restartDeviceLinkForRelayChange();
  };
  const plan: DeployJobPlan = {
    action,
    steps: [...RELAY_DEPLOY_STEPS],
    target: { sshHostId: input.sshHostId, address: input.address, name: input.name, baseUrl },
    relayId,
    serverChanged: false,
  };
  runDeployJob(plan, async (onStep, assertOwner, onProgress) => {
    const sharingAuth = await sharingAuthConfig(); assertOwner();
    const { relayVersion } = await deployRelayToServer({
      sshHostId: input.sshHostId,
      address: input.address,
      baseUrl,
      replaceExisting: input.replaceExisting,
      init,
      agentNetBootstrap: () => {
        assertOwner(); return ensureOwnerAgentNetBootstrap(relayId, input.name);
      },
      agentNetAuthIssuer: sharingAuth.issuer, agentNetAuthRegion: sharingAuth.region, agentNetAuthPeer: sharingAuth.peers?.[0],
      verifyAgentNet: async (baseUrl) => { assertOwner(); await agentNetClientForRelay(relayId, baseUrl).directory(); assertOwner(); },
      preferMirror: providerShareLinkApp() === 'cindycn',
      onStep,
      onProgress,
      assertCurrent: assertOwner,
      onServerChange: () => {
        assertOwner();
        persist();
      },
    });
    onStep('finish');
    const config = readRelayConfig();
    // 部署期间改过名字时保留新名字。
    const name = findDeployment(config, relayId)?.name ?? record.name;
    const done: RelayDeployment = { ...record, name, relayVersion, deployedAt: new Date().toISOString(), complete: true };
    const inUse = config.active?.relayId === relayId;
    writeRelayConfig({
      ...config,
      deployments: withDeployment(config.deployments, done),
      ...(inUse ? { active: deploymentActive(done) } : {}),
    });
    if (inUse) restartDeviceLinkForRelayChange();
  });
  return { state: getState() };
}

function upgradeDeployment(relayId: string): CommandResult {
  const deployment = findDeployment(readRelayConfig(), relayId);
  if (!deployment) return { state: getState(), error: 'NO_DEPLOYMENT' };
  return deploy({ sshHostId: deployment.sshHostId, address: deployment.address, name: deployment.name, replaceExisting: false }, 'upgrade');
}

function uninstallDeployment(relayId: string, removeData: boolean): CommandResult {
  const notReady = requireReady();
  if (notReady) return { state: getState(), error: notReady };
  if (deployJob?.status === 'running') return { state: getState(), error: 'BUSY' };
  const deployment = findDeployment(readRelayConfig(), relayId);
  if (!deployment) return { state: getState(), error: 'NO_DEPLOYMENT' };
  const target = { sshHostId: deployment.sshHostId, address: deployment.address, name: deployment.name, baseUrl: deployment.baseUrl };
  runDeployJob({ action: 'uninstall', steps: [...RELAY_UNINSTALL_STEPS], target, relayId, serverChanged: true }, async (onStep, assertOwner) => {
    await uninstallRelayFromServer(deployment.sshHostId, deployment, removeData, onStep, assertOwner);
    onStep('finish');
    forgetDeploymentLocally(deployment, removeData);
  });
  return { state: getState() };
}

/** 本机删掉部署记录;保留数据时也保留身份,之后在同一台服务器重新部署可接着用已加入的设备。 */
function forgetDeploymentLocally(deployment: RelayDeployment, removeIdentity: boolean): void {
  const config = readRelayConfig();
  const wasActive = config.active?.relayId === deployment.relayId;
  if (wasActive) stopPairing();
  if (removeIdentity) deleteRelaySecrets(deployment.relayId);
  writeRelayConfig({
    ...config,
    active: wasActive ? null : config.active,
    deployments: removeIdentity
      ? config.deployments.filter((item) => item.relayId !== deployment.relayId)
      : config.deployments.map((item) => (item.relayId === deployment.relayId ? { ...item, complete: false } : item)),
  });
  if (wasActive) restartDeviceLinkForRelayChange();
}

function forgetDeployment(relayId: string): CommandResult {
  const deployment = findDeployment(readRelayConfig(), relayId);
  if (!deployment) return { state: getState(), error: 'NO_DEPLOYMENT' };
  if (deployJob?.status === 'running') return { state: getState(), error: 'BUSY' };
  forgetDeploymentLocally(deployment, true);
  if (deployJob?.relayId === relayId) deployJob = null;
  return { state: getState() };
}

async function useDeployment(relayId: string): Promise<CommandResult> {
  const assertOwner = captureOwner();
  const notReady = requireReady();
  if (notReady) return { state: getState(), error: notReady };
  const config = readRelayConfig();
  const deployment = findDeployment(config, relayId);
  if (!deployment?.complete || !readRelaySecrets(deployment.relayId)) return { state: getState(), error: 'NO_DEPLOYMENT' };
  if (config.active?.relayId === relayId) return { state: getState() };
  if (config.host.enabled) await stopHost(false);
  assertOwner();
  await leaveCurrent();
  assertOwner();
  writeRelayConfig({ ...readRelayConfig(), active: deploymentActive(deployment), host: { ...readRelayConfig().host, enabled: false } });
  restartDeviceLinkForRelayChange();
  return { state: getState() };
}

/** 只改本机显示的名字:线路列表、切换确认与正在用的线路都用新名字;服务器上的名字不变。 */
function renameDeployment(relayId: string, name: string): CommandResult {
  const notReady = requireReady();
  if (notReady) return { state: getState(), error: notReady };
  const config = readRelayConfig();
  if (!findDeployment(config, relayId)) return { state: getState(), error: 'NO_DEPLOYMENT' };
  writeRelayConfig({
    ...config,
    active: config.active?.relayId === relayId ? { ...config.active, name } : config.active,
    deployments: config.deployments.map((deployment) => (deployment.relayId === relayId ? { ...deployment, name } : deployment)),
  });
  if (deployJob?.relayId === relayId && deployJob.target) deployJob = { ...deployJob, target: { ...deployJob.target, name } };
  return { state: getState() };
}

/** 部署表单里选服务器时的只读检查;服务器上已有的中转按这台电脑的部署记录核对是不是自己的。 */
async function checkServer(sshHostId: string): Promise<CommandResult> {
  const notReady = requireReady();
  if (notReady) return { state: getState(), error: notReady };
  const assertOwner = captureOwner();
  const identity = readRelayConfig().deployments.find((deployment) => deployment.sshHostId === sshHostId) ?? null;
  let check: SelfHostedRelayServerCheck;
  try {
    check = { sshHostId, ok: true, ...(await checkRelayServer(sshHostId, identity, assertOwner)) };
  } catch (error) {
    if (error instanceof RelayOperationExpired) throw error;
    check = error instanceof RelayDeployError
      ? { sshHostId, ok: false, error: error.code, ...(error.detail ? { detail: error.detail } : {}) }
      : { sshHostId, ok: false, error: 'DEPLOY_FAILED', ...(error instanceof Error ? { detail: error.message.slice(0, 300) } : {}) };
  }
  assertOwner();
  log.info('relay server checked', check.ok ? { ok: true, plan: check.plan, existing: check.existing } : { ok: false, code: check.error });
  return { state: getState(), check };
}

const countOf = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);

/**
 * 用部署记录里的主人凭证读服务器中转的管理状态;没在用它时也能看到在线、设备数与证书到期。
 * 返回的中转 ID 不是这份部署时按连不上处理,不把别的中转的数字当成自己的。
 */
async function deploymentStatus(relayId: string): Promise<CommandResult> {
  const notReady = requireReady();
  if (notReady) return { state: getState(), error: notReady };
  const assertOwner = captureOwner();
  const deployment = findDeployment(readRelayConfig(), relayId);
  if (!deployment?.complete) return { state: getState(), error: 'NO_DEPLOYMENT' };
  const secrets = readRelaySecrets(deployment.relayId);
  if (!secrets) return { state: getState(), deploymentStatus: { online: false } };
  let status: SelfHostedRelayDeploymentStatus = { online: false };
  try {
    const res = await fetch(`${deployment.baseUrl}/api/device-link/relay/admin/status`, {
      headers: { authorization: `CindyRelay ${secrets.credential}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && body?.relayId === deployment.relayId) {
      status = {
        online: true,
        devices: countOf(body.devices),
        onlineDevices: countOf(body.online),
        certificateExpiresAt: typeof body.certificateExpiresAt === 'string' ? body.certificateExpiresAt : null,
      };
      // 中转带不带 Agent-Net、能不能分享给其他账号:读它公开的能力声明(读不到就不显示)。
      try {
        const info = await fetch(`${deployment.baseUrl}/api/agent-net/info`, { signal: AbortSignal.timeout(5_000) });
        const features = info.ok ? ((await info.json()) as { features?: unknown }).features : null;
        status = { ...status, agentNet: info.ok && Array.isArray(features), tenants: Array.isArray(features) && features.includes('tenants-v1') };
        if (info.status === 404) status = { ...status, agentNet: false, tenants: false };
      } catch {
        // 只少显示一行,状态照常。
      }
    }
  } catch {
    status = { online: false };
  }
  assertOwner();
  return { state: getState(), deploymentStatus: status };
}

/** Agent-Net 写入在实际拿到设置文件锁后核验账号代次，不让过期操作先提交再报错。 */
async function writeAgentNetSetting<K extends 'agentNetEnabled' | 'agentNetOnlyEncrypted' | 'agentNetChangedBy' | 'agentNetPendingSwitch'>(
  key: K, value: DeviceLinkSettings[K], assertOwner = captureOwner(),
): Promise<void> {
  // updater 在设置文件实际写锁内执行；等待队列/锁期间失效的账号不能先落盘再被拒绝。
  await updateDeviceLinkSetting(key, () => { assertOwner(); return value; });
  // 提交后由调用方核验：初次 pending 必须先挂恢复期限，再拒绝失效请求的后续处理。
}

/** 本机与远程共用保存、重启本机中转和重连路径；起不来时恢复原值并返回原因。 */
async function applyAgentNet(enabled: boolean): Promise<CommandResult> {
  const notReady = enabled ? requireReady() : null;
  if (notReady) return { state: getState(), error: notReady };
  const assertOwner = captureOwner();
  const previous = readDeviceLinkSettings().agentNetEnabled === true;
  if (previous === enabled) return { state: getState() };
  await writeAgentNetSetting('agentNetEnabled', enabled, assertOwner); assertOwner();
  try {
    if (readRelayConfig().host.enabled) {
      await startHost(readRelayConfig()); assertOwner();
      if (!host) throw new Error('AGENT_NET_HOST_START_FAILED');
    }
  } catch (error) {
    if (error instanceof RelayOperationExpired) throw error;
    const reason = hostError ?? 'START_FAILED';
    await writeAgentNetSetting('agentNetEnabled', previous, assertOwner); assertOwner();
    if (readRelayConfig().host.enabled) { await startHost(readRelayConfig()); assertOwner(); }
    restartDeviceLinkForRelayChange();
    return { state: getState(), error: reason };
  }
  restartDeviceLinkForRelayChange();
  return { state: getState() };
}

/**
 * 远程切换连接方式(docs/product-rules/agent-net.md「远程切换其他电脑的连接方式」)的两头：
 * - 被切的这台电脑：remoteSwitch 处理同账号电脑发来的请求(准入在 dispatch)，开关仍走 applyAgentNet；
 * - 发起的这台电脑：askPeerAgentNet 只把请求转给那台电脑并原样带回回答，不改本机任何设置。
 */
let remoteSwitch: AgentNetRemoteSwitch | null = null;

function agentNetSwitchDisableBlock(): AgentNetSwitchDisableBlock | null {
  if (isAgentNetOnlyRelay(activeSelfHostedRelay())) return 'V2_ONLY_RELAY';
  const settings = readDeviceLinkSettings();
  return settings.agentNetEnabled === true && settings.agentNetOnlyEncrypted === true ? 'ENCRYPTION_REQUIRED' : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function installAgentNetRemoteSwitch(): void {
  if (remoteSwitch) return;
  const switchLog = createLogger('agent-net:remote-switch');
  remoteSwitch = createAgentNetRemoteSwitch({
    captureScope: captureOwner,
    readSettings: readDeviceLinkSettings,
    disableBlock: agentNetSwitchDisableBlock,
    // 「由谁打开」写好就推给本机窗口，开关下面立刻显示。
    writeChangedBy: async (value) => {
      await writeAgentNetSetting('agentNetChangedBy', value);
      broadcast(SELF_HOSTED_RELAY_IPC.CHANGED, getState());
    },
    writePending: (value) => writeAgentNetSetting('agentNetPendingSwitch', value),
    readiness: () => {
      const notReady = requireReady();
      if (notReady) return notReady === 'NOT_SIGNED_IN' ? 'NOT_SIGNED_IN' : 'SECURE_STORAGE_UNAVAILABLE';
      const relay = activeSelfHostedRelay();
      // 本机中转主人在启用时可以补身份；加入的/部署的中转必须先有该网络的身份。
      const canBootstrapHere = relay?.role === 'owner' && activeRelayOrigin() === 'host' && readRelayConfig().host.enabled;
      return relay && !readRelaySecrets(relay.relayId)?.agentNet && !canBootstrapHere ? 'RELAY_IDENTITY_MISSING' : null;
    },
    apply: async (enabled) => {
      try {
        const result = await applyAgentNet(enabled);
        emitChanged();
        return result.error ?? null;
      } catch (error) {
        return error instanceof RelayOperationExpired ? 'NOT_SIGNED_IN' : 'START_FAILED';
      }
    },
    linkIsAgentNet: (deviceId) => getDeviceLinkPeerLinks().links.some((link) => link.deviceId === deviceId && link.open && link.encrypted === true),
    now: () => Date.now(),
    pid: process.pid,
    isProcessAlive,
    log: switchLog,
  });
  const service = remoteSwitch;
  // 上次在等确认时应用退出了：等启动稳定后退回(记录它的进程还在运行时留给那个实例)。
  const timer = setTimeout(() => {
    void service.recover().catch((error: unknown) => switchLog.warn('recovering an interrupted remote agent-net switch failed', { error: String(error) }));
  }, 3_000);
  timer.unref?.();
}

/**
 * 被切电脑一侧的处理入口，bootstrap 交给 dispatch(setAgentNetSwitchRemoteHandler)。在 registerSelfHostedRelayIpc 之后调用。
 * 不在本模块直接引用 dispatch，避免把整个 dispatch 拉进中转运行时。
 */
export function agentNetSwitchRemoteHandler(): { handle(raw: unknown, controllerDeviceId: string, controllerName: string): Promise<unknown> } | null {
  const service = remoteSwitch;
  return service ? { handle: (raw, controllerDeviceId, controllerName) => service.handle(raw, controllerDeviceId, controllerName) } : null;
}

async function askPeerAgentNet(deviceId: string, request: PeerAgentNetRequest): Promise<PeerAgentNetReply> {
  const controllerBlock = agentNetSwitchDisableBlock();
  if (request.action === 'set' && !request.enabled && controllerBlock) {
    // 发起端自己拒绝旧连接时，不能先关掉对方，再因无法重连把已执行的关闭报告为失败。
    const code = controllerBlock === 'V2_ONLY_RELAY' ? 'AGENT_NET_SWITCH_V2_ONLY_RELAY' : 'AGENT_NET_SWITCH_CONTROLLER_ENCRYPTION_REQUIRED';
    return { ok: false, code: 'IPC_ERROR', message: `[${code}] this computer cannot reconnect over Device Link` };
  }
  try {
    const reply = await remoteBackgroundInvoke(deviceId, AGENT_NET_SWITCH_CHANNEL, [request]);
    return reply.ok
      ? { ok: true, result: reply.result, ...(request.action === 'status' ? { controllerBlock: agentNetSwitchDisableBlock() } : {}) }
      : { ok: false, code: reply.error.code, message: reply.error.message };
  } catch (error) {
    const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'NOT_CONNECTED';
    return { ok: false, code, message: error instanceof Error ? error.message : 'unavailable' };
  }
}

async function execute(command: SelfHostedRelayCommand): Promise<CommandResult> {
  switch (command.type) {
    case 'set-agent-net-encryption': {
      const assertOwner = captureOwner();
      // 本机的加密选择同样优先于已经接受、还未执行的远程切换。
      const change = async () => {
        assertOwner();
        await writeAgentNetSetting('agentNetOnlyEncrypted', command.enabled, assertOwner); assertOwner();
        restartDeviceLinkForRelayChange();
        return true;
      };
      if (remoteSwitch) await remoteSwitch.onLocalChange(change); else await change();
      assertOwner();
      return { state: getState() };
    }
    case 'set-agent-net': {
      const assertOwner = captureOwner();
      // 这台电脑上的人自己改了开关：以人为准，丢掉待确认的远程切换与「由谁打开」的说明。
      let result!: CommandResult;
      const change = async () => {
        assertOwner();
        result = await applyAgentNet(command.enabled); assertOwner();
        return !result.error;
      };
      if (remoteSwitch) await remoteSwitch.onLocalChange(change); else await change();
      assertOwner();
      return { ...result, state: getState() };
    }
    case 'peer-agent-net':
      return { state: getState(), peer: await askPeerAgentNet(command.deviceId, command.request) };
    case 'state':
      return { state: getState() };
    case 'enable-host':
      return enableHost(command);
    case 'disable-host':
    case 'use-official':
      return useOfficial();
    case 'create-join-link':
      return createJoinLink(command.fresh === true);
    case 'decide':
      return decide(command.requestId, command.approve);
    case 'join': {
      const link = parseRelayJoinLink(command.link);
      if (!link) return { state: getState(), error: requireReady() ?? 'INVALID_LINK' };
      return startJoin({ kind: 'link', link });
    }
    case 'refresh-account-relays':
      // 打开中转页时:顺带看看这条中转分享给了哪些账号(主人才有)。
      await Promise.all([refreshAccountRelays(false), refreshTenants()]);
      return { state: getState() };
    case 'revoke-tenant':
      return revokeTenant(command.tenantId);
    case 'join-account-relay': {
      const offer = accountOffers.find((item) => item.ownerDeviceId === command.ownerDeviceId && item.relayId === command.relayId);
      if (!offer) return { state: getState(), error: 'RELAY_UNAVAILABLE' };
      return startJoin({ kind: 'account', offer });
    }
    case 'cancel-join':
      cancelJoin();
      join = { status: 'idle' };
      return { state: getState() };
    case 'deploy':
      return deploy(command, 'deploy');
    case 'upgrade-deployment':
      return upgradeDeployment(command.relayId);
    case 'uninstall-deployment':
      return uninstallDeployment(command.relayId, command.removeData);
    case 'forget-deployment':
      return forgetDeployment(command.relayId);
    case 'use-deployment':
      return useDeployment(command.relayId);
    case 'rename-deployment':
      return renameDeployment(command.relayId, command.name);
    case 'check-server':
      return checkServer(command.sshHostId);
    case 'dismiss-deploy-job':
      if (deployJob && deployJob.status !== 'running') deployJob = null;
      return { state: getState() };
    case 'deployment-status':
      return deploymentStatus(command.relayId);
  }
}

export function registerSelfHostedRelayIpc(): void {
  // 先登记中转来源:之后 device-link 每次建连都按当前账号的选择走官方或自建中转。
  installSelfHostedRelayRouting();
  installAgentNetRemoteSwitch();
  ipcMain.handle(SELF_HOSTED_RELAY_IPC.COMMAND, async (event, raw: unknown) => {
    // 账号级本机设置:只接受本机应用窗口,不经设备互联代理。
    if (getDeviceLinkInvokeContext()) throwIpcError('PERMISSION_DENIED', 'Self-hosted relay settings are local only');
    assertTrustedAppRendererEvent(event);
    const command = parseSelfHostedRelayCommand(raw);
    if (!command) throwIpcError('INVALID_PARAMS', 'Invalid self-hosted relay command');
    let result: CommandResult;
    try {
      result = await execute(command);
    } catch (error) {
      if (!(error instanceof RelayOperationExpired)) throw error;
      return { state: getState(), error: 'NOT_SIGNED_IN' };
    }
    // 只读查询不改状态,不向所有窗口广播(重读同账号中转有变化时由它自己推送)。
    if (command.type !== 'state' && command.type !== 'check-server' && command.type !== 'deployment-status'
      && command.type !== 'refresh-account-relays' && command.type !== 'peer-agent-net') emitChanged();
    return result;
  });

  // 登录后按设置拉起本机中转;登出 / 换账号时停掉(中转属于开启它的账号)。
  // 登录态与账号数据作用域分两步就绪:作用域还没提交时短暂重试,不在临时命名空间里启动。
  // 提交账号后、运行时就绪前还有一段会话边界,期间 ensureHost 按未登录直接返回,而边界结束没有事件:
  // 换账号的清理照常立即做,启动等边界结束后补上,否则重开应用后已开启的本机中转要等手动保存才起来。
  let lastKey: string | null = null;
  let startDeferred = false;
  // 上一个账号的中转要等设备连接关掉才释放端口;推迟的启动先等它关完。
  let stopping: Promise<void> = Promise.resolve();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;
  const retrySoon = () => {
    retryTimer = setTimeout(sync, 1_000);
    retryTimer.unref?.();
  };
  const reportFailure = (error: unknown) => {
    if (!(error instanceof RelayOperationExpired)) log.warn('relay owner synchronization failed');
  };
  const sync = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    const authenticated = authManager.getAuthState().isAuthenticated;
    const ownerId = getActiveAppSession().dataOwnerId;
    if (authenticated && !ownerId && retries++ < 30) {
      retrySoon();
      return;
    }
    retries = 0;
    const key = authenticated && ownerId ? activeOwnerScopeKey() : null;
    if (key === lastKey) {
      if (!startDeferred) return;
      if (isAppSessionBoundaryPending()) {
        retrySoon();
        return;
      }
      startDeferred = false;
      const assertOwner = captureOwner();
      void stopping.then(() => {
        assertOwner();
        return ensureHost();
      }).then(() => { assertOwner(); emitChanged(); }).catch(reportFailure);
      return;
    }
    lastKey = key;
    ownerEpoch += 1;
    cancelJoin();
    join = { status: 'idle' };
    stopPairing();
    resetAccountDirectory();
    deployJob = null;
    hostStarting = null;
    startDeferred = key !== null && isAppSessionBoundaryPending();
    if (startDeferred) retrySoon();
    const deferred = startDeferred;
    const assertOwner = captureOwner();
    stopping = stopHost(false);
    void stopping.then(() => {
      assertOwner();
      return key && !deferred ? ensureHost() : undefined;
    }).then(() => { assertOwner(); emitChanged(); }).catch(reportFailure);
  };
  sync();
  authManager.onAuthStateChange(sync);
  onAppSessionInvalidated(() => {
    ownerEpoch += 1;
    cancelJoin();
    stopPairing();
    resetAccountDirectory();
    deployJob = null;
    setTimeout(sync, 0);
  });
  app.on('before-quit', () => {
    void stopHost(false);
  });
}
