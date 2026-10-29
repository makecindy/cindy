/**
 * 自建中转服务的桌面端运行时(docs/self-hosted-relay-plan.md)。
 *
 * - 在这台电脑上开启中转(方式 B):Cindy 主进程内运行 `@cindy/device-link-relay`,本机作为主人设备
 *   连 `http://127.0.0.1:<端口>`;别的设备怎么访问到这台电脑由用户保证,Cindy 只列出本机地址。
 * - 部署到自己的服务器(方式 C):经已配置的 SSH 主机安装同一个中转内核,自动申请证书;本机是主人,
 *   远程生成加入链接、审批设备、升级与卸载(selfHostedRelayDeploy.ts)。
 * - 加入别的中转:粘贴主人电脑给出的加入链接 → 申请 → 主人同意 → 保存中转凭证与签名密钥并切换。
 * - 设备签名(§16):主人密钥只在主人电脑;同意加入时主人核对配对证明后签发设备证书。
 *
 * 只接受本机应用窗口的命令,不经设备互联代理。凭证、私钥、加入码、加入链接不写日志。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { app, ipcMain } from 'electron';
import {
  acceptRelayDeviceCert,
  buildRelayJoinLink,
  createRelayJoinIdentity,
  createRelayPairSecret,
  createRelaySigningKey,
  fetchRelayInfo,
  issueRelayDeviceCert,
  parseRelayJoinLink,
  relayPublicKeyOf,
  RelayJoinError,
  submitRelayPairRequest,
  verifyRelayPairProof,
  waitForRelayApproval,
  type RelayFetch,
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
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  parseSelfHostedRelayCommand,
  relayBaseUrlForAddress,
  SELF_HOSTED_RELAY_IPC,
  type SelfHostedRelayCommand,
  type SelfHostedRelayDeployJobView,
  type SelfHostedRelayErrorCode,
  type SelfHostedRelayJoinView,
  type SelfHostedRelayPairRequestView,
  type SelfHostedRelayState,
} from '../../shared/selfHostedRelay.js';
import { deviceName } from './deviceName.js';
import {
  broadcast,
  getDeviceLinkConnectionIssue,
  restartDeviceLinkForRelayChange,
  setKeepAwakeEnabled,
} from './index.js';
import { getDeviceLinkInvokeContext } from './invoke-context.js';
import { providerShareLinkApp } from './providerShareApi.js';
import {
  activeRelayOrigin,
  activeSelfHostedRelay,
  deleteRelaySecrets,
  installSelfHostedRelayRouting,
  readRelayConfig,
  readRelaySecrets,
  relayDataPath,
  secureStorageAvailable,
  writeRelayConfig,
  writeRelaySecrets,
  type RelayConfig,
  type RelayDeployment,
  type RelaySecrets,
} from './selfHostedRelayConfig.js';
import { bundledRelayVersion, deployRelayToServer, RelayDeployError, uninstallRelayFromServer } from './selfHostedRelayDeploy.js';
import { refreshRelayCertificatesSoon } from './selfHostedRelayFrameAuth.js';
import { readDeviceLinkSettings } from './settings-store.js';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending, onAppSessionInvalidated } from '../appSessionState.js';

const log = createLogger('self-hosted-relay');

const PENDING_POLL_MS = 2_000;
const JOIN_LINK_TTL_MS = 10 * 60 * 1000;

const relayFetch: RelayFetch = (url, init) => fetch(url, init);

let host: RelayServerHandle | null = null;
let hostKey: string | null = null;
let hostError: SelfHostedRelayErrorCode | null = null;
let hostStarting: Promise<void> | null = null;
let joinLink: { link: string; expiresAt: number } | null = null;
/** 这台电脑生成的加入链接里的配对秘密(只在内存,随链接一起过期)。 */
let pairSecrets: Array<{ relayId: string; secret: string; expiresAt: number }> = [];
let pendingRequests: SelfHostedRelayPairRequestView[] = [];
let pendingRaw = new Map<string, { deviceId: string; publicKey: string }>();
let pendingTimer: ReturnType<typeof setInterval> | null = null;
let join: SelfHostedRelayJoinView = { status: 'idle' };
let joinAbort: AbortController | null = null;
let deployJob: SelfHostedRelayDeployJobView | null = null;
let ownerEpoch = 0;

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
}

function lanAddresses(): string[] {
  const result: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) result.push(entry.address);
    }
  }
  return result;
}

function suggestedUrls(config: RelayConfig): string[] {
  if (!config.host.listenAll) return [];
  return lanAddresses().map((address) => `http://${address}:${config.host.port}`);
}

/** 本机中转加入链接里写的地址:用户填的对外地址优先;监听所有网络时退回第一个局域网地址。 */
function hostJoinBaseUrl(config: RelayConfig): string | null {
  return config.host.externalUrl ?? suggestedUrls(config)[0] ?? null;
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
  const deployment = config.deployment;
  return {
    available: authManager.getAuthState().isAuthenticated && secureStorageAvailable(),
    mode: relay ? 'self-hosted' : 'official',
    relay: relay && origin ? { name: relay.name, baseUrl: relay.baseUrl, role: relay.role, origin } : null,
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
    deployment: deployment
      ? {
          sshHostId: deployment.sshHostId,
          address: deployment.address,
          baseUrl: deployment.baseUrl,
          name: deployment.name,
          relayVersion: deployment.complete ? deployment.relayVersion : '',
          deployedAt: deployment.deployedAt,
          active: relay?.relayId === deployment.relayId,
          upgradeAvailable: Boolean(bundled && deployment.complete && bundled !== deployment.relayVersion),
        }
      : null,
    deployJob,
    bundledRelayVersion: bundled,
    joinLink: joinLink ? { link: joinLink.link, expiresAt: new Date(joinLink.expiresAt).toISOString() } : null,
    pendingRequests,
    join,
  };
}

// ─── 主人身份 ────────────────────────────────────────────────────────────────

/** 新建一份主人身份:凭证与签名私钥只存本机安全存储。 */
function createOwnerSecrets(relayId: string): RelaySecrets {
  const secrets = { credential: createDeviceCredential().credential, seed: createRelaySigningKey(crypto).seed };
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
  pendingRaw = new Map();
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
  if (existingId) deleteRelaySecrets(existingId);
  const relayId = randomUUID();
  const secrets = createOwnerSecrets(relayId);
  await initializeRelay({ dataDir, ...ownerInitArgs(relayId, secrets, deviceName().slice(0, 64) || 'Cindy') });
  assertOwner();
  writeRelayConfig({ ...readRelayConfig(), host: { ...config.host, relayId } });
  return relayId;
}

async function startHost(config: RelayConfig): Promise<void> {
  const assertOwner = captureOwner();
  const key = `${config.host.port}:${config.host.listenAll}:${config.host.externalUrl ?? ''}`;
  if (host && hostKey === key) return;
  await stopHost(false);
  assertOwner();
  hostError = null;
  const dataDir = relayDataPath('host');
  try {
    await prepareHostData(dataDir, config);
    assertOwner();
    const started = await startRelayServer({
      dataDir,
      host: config.host.listenAll ? '0.0.0.0' : '127.0.0.1',
      port: config.host.port,
      publicUrl: config.host.externalUrl ?? undefined,
      // 只监听本机时,请求来自同机的前置代理,可以信任它给的外部地址。
      trustProxyHeaders: !config.host.listenAll,
      logger: {
        info: (message, fields) => log.info(message, fields ?? {}),
        warn: (message, fields) => log.warn(message, fields ?? {}),
        error: (message, fields) => log.error(message, fields ?? {}),
      },
    });
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

async function refreshPendingRequests(): Promise<void> {
  const assertOwner = captureOwner();
  const owner = ownerBase();
  if (!owner) return;
  try {
    const body = (await ownerFetch('/relay/admin/pair-requests')) as { requests?: unknown[] };
    assertOwner();
    if (ownerBase()?.relayId !== owner.relayId) return;
    const raw = new Map<string, { deviceId: string; publicKey: string }>();
    const next = (body.requests ?? []).flatMap((item): SelfHostedRelayPairRequestView[] => {
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
      return [{
        requestId: r.requestId,
        deviceName: r.deviceName,
        platform: typeof r.platform === 'string' ? r.platform : null,
        verifyCode: r.verifyCode,
        replacesExisting: r.replacesExisting === true,
        verified: proofMatches(owner.relayId, { deviceId: r.deviceId, publicKey: r.publicKey, proof: r.proof }),
      }];
    });
    pendingRaw = raw;
    if (JSON.stringify(next) !== JSON.stringify(pendingRequests)) {
      pendingRequests = next;
      emitChanged();
    }
  } catch {
    // 中转刚重启或暂时连不上:下一轮再试;停用时轮询会被一并停掉。
  }
}

function startPendingPolling(): void {
  stopPendingPolling();
  pendingTimer = setInterval(() => {
    if (!joinLink || joinLink.expiresAt < Date.now()) {
      // 加入码过期后最后再看一次,让已经提交的申请仍能被处理完。
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

async function createJoinLink(): Promise<CommandResult> {
  const assertOwner = captureOwner();
  const owner = ownerBase();
  if (!owner) return { state: getState(), error: activeRelayOrigin() === 'host' ? 'START_FAILED' : 'NOT_OWNER' };
  const base = activeRelayOrigin() === 'host' ? hostJoinBaseUrl(readRelayConfig()) : activeSelfHostedRelay()!.baseUrl;
  if (!base) return { state: getState(), error: 'EXTERNAL_URL_REQUIRED' };
  try {
    const body = (await ownerFetch('/relay/admin/join-codes', { method: 'POST' })) as { code: string };
    assertOwner();
    if (ownerBase()?.relayId !== owner.relayId) return { state: getState(), error: 'NOT_OWNER' };
    const pairSecret = createRelayPairSecret(crypto);
    const expiresAt = Date.now() + JOIN_LINK_TTL_MS;
    pairSecrets.push({ relayId: owner.relayId, secret: pairSecret, expiresAt });
    joinLink = {
      link: buildRelayJoinLink({
        baseUrl: base,
        code: body.code,
        ownerPublicKey: owner.ownerPublicKey,
        pairSecret,
        app: providerShareLinkApp(),
      }),
      expiresAt,
    };
    pendingRequests = [];
    startPendingPolling();
    return { state: getState() };
  } catch {
    return { state: getState(), error: 'FAILED' };
  }
}

async function decide(requestId: string, approve: boolean): Promise<CommandResult> {
  const owner = ownerBase();
  if (!owner) return { state: getState(), error: 'NOT_OWNER' };
  const view = pendingRequests.find((request) => request.requestId === requestId);
  const raw = pendingRaw.get(requestId);
  let error: SelfHostedRelayErrorCode | undefined;
  try {
    if (approve) {
      // 配对证明对不上:公钥不是拿着这台电脑给出的链接的那台设备生成的(可能被中转替换),不能签发证书。
      if (!view?.verified || !raw) {
        error = 'PAIR_PROOF_INVALID';
      } else {
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
      await ownerFetch(`/relay/admin/pair-requests/${requestId}/reject`, { method: 'POST' });
    }
  } catch {
    // 申请可能已过期:刷新列表让界面反映真实状态。
  }
  await refreshPendingRequests();
  return { state: getState(), error };
}

// ─── 命令 ────────────────────────────────────────────────────────────────────

type CommandResult = { state: SelfHostedRelayState; error?: SelfHostedRelayErrorCode };

function requireReady(): SelfHostedRelayErrorCode | null {
  // 账号数据作用域提交之前不能读写中转配置(否则会落进临时命名空间)。
  if (isAppSessionBoundaryPending() || !authManager.getAuthState().isAuthenticated || !getActiveAppSession().dataOwnerId) return 'NOT_SIGNED_IN';
  if (!secureStorageAvailable()) return 'SECURE_STORAGE_UNAVAILABLE';
  return null;
}

/** 成员退出所加入的中转(尽力而为,中转不可达也照样在本机切回),并删掉本机在它上面的秘密。 */
async function leaveMemberRelay(): Promise<void> {
  const assertOwner = captureOwner();
  const relay = activeSelfHostedRelay();
  if (relay?.role !== 'member') return;
  try {
    await fetch(`${relay.baseUrl}/api/device-link/devices/${encodeURIComponent(relay.deviceId)}`, {
      method: 'DELETE',
      headers: { authorization: `CindyRelay ${relay.credential}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    log.info('could not notify the relay before leaving; switching locally');
  }
  assertOwner();
  deleteRelaySecrets(relay.relayId);
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
  // 中转所在电脑一休眠,所有设备都会断开:开启时顺带打开「保持唤醒」。
  if (!readDeviceLinkSettings().keepAwake) await setKeepAwakeEnabled(true).catch(() => undefined);
  assertOwner();
  restartDeviceLinkForRelayChange();
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

function startJoin(rawLink: string): CommandResult {
  const assertOwner = captureOwner();
  const notReady = requireReady();
  if (notReady) return { state: getState(), error: notReady };
  if (readRelayConfig().host.enabled) return { state: getState(), error: 'HOSTING' };
  const link = parseRelayJoinLink(rawLink);
  if (!link) return { state: getState(), error: 'INVALID_LINK' };
  cancelJoin();
  const abort = new AbortController();
  joinAbort = abort;
  join = { status: 'connecting' };
  const accountUserId = authManager.getCurrentUserId();
  const deviceId = authManager.getDeviceId();
  void (async () => {
    try {
      const info = await fetchRelayInfo(relayFetch, link.baseUrl, abort.signal);
      assertOwner();
      if (abort.signal.aborted) return;
      const identity = createRelayJoinIdentity(crypto, link, info.relayId, deviceId);
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
      join = { status: 'waiting', relayName: info.name, verifyCode: request.verifyCode };
      emitChanged();
      const result = await waitForRelayApproval(relayFetch, link, request, { signal: abort.signal });
      assertOwner();
      // 等待期间换了账号:凭证属于旧账号,不能写进新账号的配置。
      if (abort.signal.aborted || authManager.getCurrentUserId() !== accountUserId) return;
      // 证书必须出自链接里的主人、发给本机这把公钥;否则中转可能被人替换,不加入。
      acceptRelayDeviceCert(crypto, link, { relayId: info.relayId, deviceId, publicKey: identity.publicKey, cert: result.cert });
      // 之前加入的中转先退出(不能用 leaveCurrent:它会取消正在进行的这次加入)。
      await leaveMemberRelay();
      assertOwner();
      if (abort.signal.aborted) return;
      stopPairing();
      writeRelaySecrets(info.relayId, { credential: result.credential, seed: identity.seed });
      writeRelayConfig({
        ...readRelayConfig(),
        active: {
          relayId: info.relayId,
          name: info.name,
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
      join = { status: 'failed', error: error instanceof RelayJoinError ? error.code : 'FAILED' };
    } finally {
      if (joinAbort === abort) joinAbort = null;
      emitChanged();
    }
  })();
  return { state: getState() };
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

function runDeployJob(action: SelfHostedRelayDeployJobView['action'], work: (onStep: (step: SelfHostedRelayDeployJobView['step']) => void, assertOwner: () => void) => Promise<void>): void {
  const assertOwner = captureOwner();
  const isCurrent = () => {
    try { assertOwner(); return true; } catch { return false; }
  };
  deployJob = { action, step: 'connect', status: 'running' };
  const onStep = (step: SelfHostedRelayDeployJobView['step']) => {
    assertOwner();
    if (deployJob?.status !== 'running') return;
    deployJob = { ...deployJob, step };
    emitChanged();
  };
  void work(onStep, assertOwner)
    .then(() => {
      if (!isCurrent()) return;
      deployJob = { action, step: 'finish', status: 'done' };
    })
    .catch((error: unknown) => {
      if (!isCurrent()) return;
      const step = deployJob?.step ?? 'connect';
      if (error instanceof RelayDeployError) {
        deployJob = { action, step, status: 'failed', error: error.code, detail: error.detail };
      } else {
        log.warn('relay deployment failed', { reason: error instanceof Error ? error.name : 'unknown' });
        deployJob = { action, step, status: 'failed', error: 'DEPLOY_FAILED', detail: error instanceof Error ? error.message.slice(0, 300) : undefined };
      }
    })
    .finally(() => { if (isCurrent()) emitChanged(); });
}

/** 部署或升级。身份(中转 ID、主人秘密)跟着部署记录走:重试与升级都保留它。 */
function deploy(input: { sshHostId: string; address: string; name: string; replaceExisting: boolean }, action: 'deploy' | 'upgrade'): CommandResult {
  const notReady = requireReady();
  if (notReady) return { state: getState(), error: notReady };
  if (deployJob?.status === 'running') return { state: getState(), error: 'BUSY' };
  if (!bundledRelayVersion()) return { state: getState(), error: 'BUNDLE_MISSING' };
  const config = readRelayConfig();
  const previous = config.deployment;
  const reuse = previous && previous.sshHostId === input.sshHostId && !input.replaceExisting ? readRelaySecrets(previous.relayId) : null;
  const relayId = reuse && previous ? previous.relayId : randomUUID();
  const secrets = reuse ?? createOwnerSecrets(relayId);
  let replacedActive = false;
  if (previous && previous.relayId !== relayId) {
    // 换了一台服务器(或清掉重来):旧身份作废。正在用旧中转时先切回官方,不留下指向已删秘密的配置。
    replacedActive = config.active?.relayId === previous.relayId;
    if (replacedActive) {
      stopPairing();
      config.active = null;
    }
    deleteRelaySecrets(previous.relayId);
  }
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
  // 先记下身份再动服务器:中途失败后重试,用的还是已经写进服务器的这一份。
  writeRelayConfig({ ...config, deployment: record });
  if (replacedActive) restartDeviceLinkForRelayChange();
  runDeployJob(action, async (onStep, assertOwner) => {
    const { relayVersion } = await deployRelayToServer({
      sshHostId: input.sshHostId,
      address: input.address,
      baseUrl,
      replaceExisting: input.replaceExisting,
      init,
      preferMirror: providerShareLinkApp() === 'cindycn',
      onStep,
      assertCurrent: assertOwner,
    });
    onStep('finish');
    const done: RelayDeployment = { ...record, relayVersion, deployedAt: new Date().toISOString(), complete: true };
    // 改用服务器上的中转:本机中转停掉,加入的中转退出。
    const before = readRelayConfig();
    if (activeRelayOrigin() !== 'server' || activeSelfHostedRelay()?.relayId !== relayId) {
      if (before.host.enabled) await stopHost(false);
      assertOwner();
      await leaveCurrent();
      assertOwner();
    }
    writeRelayConfig({ ...readRelayConfig(), deployment: done, active: deploymentActive(done), host: { ...before.host, enabled: false } });
    restartDeviceLinkForRelayChange();
  });
  return { state: getState() };
}

function upgradeDeployment(): CommandResult {
  const deployment = readRelayConfig().deployment;
  if (!deployment) return { state: getState(), error: 'NO_DEPLOYMENT' };
  return deploy({ sshHostId: deployment.sshHostId, address: deployment.address, name: deployment.name, replaceExisting: false }, 'upgrade');
}

function uninstallDeployment(removeData: boolean): CommandResult {
  const notReady = requireReady();
  if (notReady) return { state: getState(), error: notReady };
  if (deployJob?.status === 'running') return { state: getState(), error: 'BUSY' };
  const deployment = readRelayConfig().deployment;
  if (!deployment) return { state: getState(), error: 'NO_DEPLOYMENT' };
  runDeployJob('uninstall', async (onStep, assertOwner) => {
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
    deployment: removeIdentity ? null : { ...deployment, complete: false },
  });
  if (wasActive) restartDeviceLinkForRelayChange();
}

async function useDeployment(): Promise<CommandResult> {
  const assertOwner = captureOwner();
  const notReady = requireReady();
  if (notReady) return { state: getState(), error: notReady };
  const config = readRelayConfig();
  const deployment = config.deployment;
  if (!deployment?.complete || !readRelaySecrets(deployment.relayId)) return { state: getState(), error: 'NO_DEPLOYMENT' };
  if (config.host.enabled) await stopHost(false);
  assertOwner();
  await leaveCurrent();
  assertOwner();
  writeRelayConfig({ ...readRelayConfig(), active: deploymentActive(deployment), host: { ...readRelayConfig().host, enabled: false } });
  restartDeviceLinkForRelayChange();
  return { state: getState() };
}

async function execute(command: SelfHostedRelayCommand): Promise<CommandResult> {
  switch (command.type) {
    case 'state':
      return { state: getState() };
    case 'enable-host':
      return enableHost(command);
    case 'disable-host':
    case 'use-official':
      return useOfficial();
    case 'create-join-link':
      return createJoinLink();
    case 'decide':
      return decide(command.requestId, command.approve);
    case 'join':
      return startJoin(command.link);
    case 'cancel-join':
      cancelJoin();
      join = { status: 'idle' };
      return { state: getState() };
    case 'deploy':
      return deploy(command, 'deploy');
    case 'upgrade-deployment':
      return upgradeDeployment();
    case 'uninstall-deployment':
      return uninstallDeployment(command.removeData);
    case 'forget-deployment': {
      const deployment = readRelayConfig().deployment;
      if (!deployment) return { state: getState(), error: 'NO_DEPLOYMENT' };
      if (deployJob?.status === 'running') return { state: getState(), error: 'BUSY' };
      forgetDeploymentLocally(deployment, true);
      deployJob = null;
      return { state: getState() };
    }
    case 'use-deployment':
      return useDeployment();
  }
}

export function registerSelfHostedRelayIpc(): void {
  // 先登记中转来源:之后 device-link 每次建连都按当前账号的选择走官方或自建中转。
  installSelfHostedRelayRouting();
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
    if (command.type !== 'state') emitChanged();
    return result;
  });

  // 登录后按设置拉起本机中转;登出 / 换账号时停掉(中转属于开启它的账号)。
  // 登录态与账号数据作用域分两步就绪:作用域还没提交时短暂重试,不在临时命名空间里启动。
  let lastKey: string | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;
  const sync = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    const authenticated = authManager.getAuthState().isAuthenticated;
    const ownerId = getActiveAppSession().dataOwnerId;
    if (authenticated && !ownerId && retries++ < 30) {
      retryTimer = setTimeout(sync, 1_000);
      retryTimer.unref?.();
      return;
    }
    retries = 0;
    const key = authenticated && ownerId ? activeOwnerScopeKey() : null;
    if (key === lastKey) return;
    lastKey = key;
    ownerEpoch += 1;
    cancelJoin();
    join = { status: 'idle' };
    stopPairing();
    deployJob = null;
    hostStarting = null;
    const assertOwner = captureOwner();
    void stopHost(false).then(() => {
      assertOwner();
      return key ? ensureHost() : undefined;
    }).then(() => { assertOwner(); emitChanged(); }).catch((error: unknown) => {
      if (!(error instanceof RelayOperationExpired)) log.warn('relay owner synchronization failed');
    });
  };
  sync();
  authManager.onAuthStateChange(sync);
  onAppSessionInvalidated(() => {
    ownerEpoch += 1;
    cancelJoin();
    stopPairing();
    deployJob = null;
    setTimeout(sync, 0);
  });
  app.on('before-quit', () => {
    void stopHost(false);
  });
}
