/**
 * 自建中转的本机配置与秘密(按当前账号隔离)。
 *
 * - `config.json`:当前用哪个中转(官方 / 自建)、本机中转的开启设置、部署到服务器的中转记录。不含秘密。
 * - `secrets/<中转ID>.enc`:本机在这个中转上的设备凭证与签名私钥,经 Electron safeStorage
 *   (钥匙串 / DPAPI)加密。Linux 只有明文后端(basic_text)时不保存,直接报不可用。
 *   主人(本机中转 / 部署的服务器中转)与成员(加入的中转)都按中转 ID 各存一份:切走再切回不用重新加入。
 *
 * device-link 的地址、认证方案、token、签名与 REST 都从这里同步读取当前选择(内存缓存,按账号作用域
 * 失效),因此读取不能有异步 IO;写入是原子替换。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import { isRelayPublicKey } from '@cindy/device-link';
import { activeOwnerScopeKey, getActiveAppSession, ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { oauthSecureStorageAvailable } from '../plugin-oauth/identityStore.js';
import { DEFAULT_RELAY_PORT } from '../../shared/selfHostedRelay.js';
import { setSelfHostedRelaySource, type ActiveSelfHostedRelay } from './selfHostedRelayRouting.js';

const log = createLogger('self-hosted-relay:config');

const DIR = 'device-link-relay';
const CONFIG_VERSION = 2;
const RELAY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type RelayRole = 'owner' | 'member';
/** 当前中转从哪来:本机开启 / 部署到服务器 / 加入别人的。 */
export type RelayOrigin = 'host' | 'server' | 'join';

export interface ActiveRelay {
  relayId: string;
  name: string;
  baseUrl: string;
  role: RelayRole;
  origin: RelayOrigin;
  /** 本机在这个中转上的设备 ID。 */
  deviceId: string;
  ownerPublicKey: string;
}

export interface RelayHostSettings {
  enabled: boolean;
  port: number;
  listenAll: boolean;
  externalUrl: string | null;
  /** 本机中转数据对应的中转 ID;null = 还没初始化过。 */
  relayId: string | null;
}

/** 部署到服务器上的中转(本机是它的主人)。 */
export interface RelayDeployment {
  sshHostId: string;
  /** 访问地址:域名或公网 IP(证书签给它)。 */
  address: string;
  baseUrl: string;
  relayId: string;
  name: string;
  ownerPublicKey: string;
  relayVersion: string;
  deployedAt: string;
  /** 上次部署 / 升级是否走完;未完成时保留身份,重试不会与服务器上已初始化的数据冲突。 */
  complete: boolean;
}

export interface RelayConfig {
  version: typeof CONFIG_VERSION;
  /** null = 使用 Cindy 官方中转。 */
  active: ActiveRelay | null;
  host: RelayHostSettings;
  deployment: RelayDeployment | null;
}

/** 本机在某个中转上的秘密。 */
export interface RelaySecrets {
  credential: string;
  /** Ed25519 私钥种子(base64url)。 */
  seed: string;
}

const DEFAULT_CONFIG: RelayConfig = {
  version: CONFIG_VERSION,
  active: null,
  host: { enabled: false, port: DEFAULT_RELAY_PORT, listenAll: false, externalUrl: null, relayId: null },
  deployment: null,
};

interface Cache {
  scope: string;
  config: RelayConfig;
  secrets: Map<string, RelaySecrets | null>;
}

let cache: Cache | null = null;

export function relayDataPath(...parts: string[]): string {
  return ownerScopedUserDataPath(DIR, ...parts);
}

export function secureStorageAvailable(): boolean {
  const backend = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.();
  return oauthSecureStorageAvailable({
    platform: process.platform,
    available: safeStorage.isEncryptionAvailable(),
    backend,
  });
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseActive(raw: unknown): ActiveRelay | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (
    !isString(a.relayId) ||
    !RELAY_ID_PATTERN.test(a.relayId) ||
    !isString(a.name) ||
    !isString(a.baseUrl) ||
    (a.role !== 'owner' && a.role !== 'member') ||
    (a.origin !== 'host' && a.origin !== 'server' && a.origin !== 'join') ||
    !isString(a.deviceId) ||
    !isRelayPublicKey(a.ownerPublicKey)
  ) {
    return null;
  }
  return {
    relayId: a.relayId,
    name: a.name,
    baseUrl: a.baseUrl,
    role: a.role,
    origin: a.origin,
    deviceId: a.deviceId,
    ownerPublicKey: a.ownerPublicKey,
  };
}

function parseDeployment(raw: unknown): RelayDeployment | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (
    !isString(d.sshHostId) ||
    !isString(d.address) ||
    !isString(d.baseUrl) ||
    !isString(d.relayId) ||
    !RELAY_ID_PATTERN.test(d.relayId) ||
    !isString(d.name) ||
    !isRelayPublicKey(d.ownerPublicKey) ||
    typeof d.relayVersion !== 'string' ||
    !isString(d.deployedAt)
  ) {
    return null;
  }
  return {
    sshHostId: d.sshHostId,
    address: d.address,
    baseUrl: d.baseUrl,
    relayId: d.relayId,
    name: d.name,
    ownerPublicKey: d.ownerPublicKey,
    relayVersion: d.relayVersion,
    deployedAt: d.deployedAt,
    complete: d.complete === true,
  };
}

function parseConfig(raw: unknown): RelayConfig {
  if (!raw || typeof raw !== 'object') return structuredClone(DEFAULT_CONFIG);
  const value = raw as Record<string, unknown>;
  const host = (value.host ?? {}) as Partial<RelayHostSettings>;
  // 第 1 版没有设备签名:它的中转身份与凭证不再可用,只保留本机中转的端口等设置。
  const current = value.version === CONFIG_VERSION;
  return {
    version: CONFIG_VERSION,
    active: current ? parseActive(value.active) : null,
    host: {
      enabled: current && host.enabled === true,
      port: typeof host.port === 'number' && Number.isInteger(host.port) ? host.port : DEFAULT_RELAY_PORT,
      listenAll: host.listenAll === true,
      externalUrl: typeof host.externalUrl === 'string' && host.externalUrl ? host.externalUrl : null,
      relayId: current && isString(host.relayId) && RELAY_ID_PATTERN.test(host.relayId) ? host.relayId : null,
    },
    deployment: current ? parseDeployment(value.deployment) : null,
  };
}

function secretsFile(relayId: string): string {
  return relayDataPath('secrets', `${relayId}.enc`);
}

function readSecretsFile(relayId: string): RelaySecrets | null {
  if (!RELAY_ID_PATTERN.test(relayId) || !secureStorageAvailable()) return null;
  try {
    const encrypted = fs.readFileSync(secretsFile(relayId), 'utf8');
    const parsed = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64'))) as Partial<RelaySecrets>;
    return isString(parsed.credential) && isString(parsed.seed) ? { credential: parsed.credential, seed: parsed.seed } : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('relay secrets unreadable');
    return null;
  }
}

/** 第 1 版的秘密文件:不再使用,迁移时删掉,不让旧凭证留在磁盘上。 */
function removeLegacySecrets(): void {
  for (const name of ['credential.enc', 'owner-credential.enc']) {
    try {
      fs.rmSync(relayDataPath(name), { force: true });
    } catch {
      // 尽力而为
    }
  }
}

function load(): Cache {
  const scope = activeOwnerScopeKey();
  if (cache?.scope === scope) return cache;
  let config = structuredClone(DEFAULT_CONFIG);
  if (getActiveAppSession().dataOwnerId) {
    try {
      const raw = JSON.parse(fs.readFileSync(relayDataPath('config.json'), 'utf8')) as Record<string, unknown>;
      config = parseConfig(raw);
      if (raw.version !== CONFIG_VERSION) removeLegacySecrets();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('relay config unreadable, using official relay');
    }
  }
  cache = { scope, config, secrets: new Map() };
  return cache;
}

function cachedSecrets(state: Cache, relayId: string): RelaySecrets | null {
  if (!state.secrets.has(relayId)) state.secrets.set(relayId, readSecretsFile(relayId));
  return state.secrets.get(relayId) ?? null;
}

export function readRelayConfig(): RelayConfig {
  return structuredClone(load().config);
}

export function readRelaySecrets(relayId: string): RelaySecrets | null {
  if (!getActiveAppSession().dataOwnerId) return null;
  return cachedSecrets(load(), relayId);
}

/** 当前使用的自建中转与秘密;使用官方中转时返回 null。同步、无 IO(命中缓存时)。 */
export function activeSelfHostedRelay(): ActiveSelfHostedRelay | null {
  // 账号作用域还没提交时(启动早期 / 登出)一律走官方中转,不读任何账号私有文件。
  if (!getActiveAppSession().dataOwnerId) return null;
  const state = load();
  const active = state.config.active;
  // 秘密缺失(钥匙串被清 / 换机):退回官方,避免拿空凭证无限重连。
  const secrets = active ? cachedSecrets(state, active.relayId) : null;
  if (!active || !secrets) return null;
  return {
    relayId: active.relayId,
    name: active.name,
    baseUrl: active.baseUrl,
    role: active.role,
    credential: secrets.credential,
    deviceId: active.deviceId,
    signingSeed: secrets.seed,
    ownerPublicKey: active.ownerPublicKey,
  };
}

/** 当前中转的来源(界面区分本机中转 / 服务器中转 / 加入的中转)。 */
export function activeRelayOrigin(): RelayOrigin | null {
  return activeSelfHostedRelay() ? load().config.active!.origin : null;
}

/** 启动时把本模块登记为 device-link 的中转来源(见 selfHostedRelayRouting.ts)。 */
export function installSelfHostedRelayRouting(): void {
  setSelfHostedRelaySource(activeSelfHostedRelay);
}

function writeAtomically(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function requireSignedIn(): void {
  // 未登录(没有账号作用域)时拒绝写入,不把私有状态落到临时命名空间。
  if (!getActiveAppSession().dataOwnerId) throw new Error('NOT_SIGNED_IN');
}

export function writeRelayConfig(next: RelayConfig): void {
  requireSignedIn();
  const state = load();
  writeAtomically(relayDataPath('config.json'), JSON.stringify(next, null, 2));
  state.config = structuredClone(next);
}

export function writeRelaySecrets(relayId: string, secrets: RelaySecrets): void {
  requireSignedIn();
  if (!RELAY_ID_PATTERN.test(relayId)) throw new Error('INVALID_RELAY_ID');
  if (!secureStorageAvailable()) throw new Error('SECURE_STORAGE_UNAVAILABLE');
  writeAtomically(secretsFile(relayId), safeStorage.encryptString(JSON.stringify(secrets)).toString('base64'));
  load().secrets.set(relayId, { ...secrets });
}

export function deleteRelaySecrets(relayId: string): void {
  if (!getActiveAppSession().dataOwnerId || !RELAY_ID_PATTERN.test(relayId)) return;
  fs.rmSync(secretsFile(relayId), { force: true });
  load().secrets.set(relayId, null);
}

/** 测试与账号切换后强制重新读取。 */
export function invalidateRelayConfigCache(): void {
  cache = null;
}
