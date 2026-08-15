import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import { storedCustomProviderId } from '@cindy/model-providers';

import { createLogger } from '../logger.js';
import {
  providerSecretStorageKey,
  customProviderHeaderStorageKey,
  customProviderSecretStorageKey,
  customMcpSecretStorageKey,
  CUSTOM_MCP_SECRET_PREFIX,
  CUSTOM_PROVIDER_HEADER_SECRET_PREFIX,
  providerOAuthStorageKey,
  ghostSecretStorageKey,
  ghostSecretHintStorageKey,
  deriveGhostSecretTail,
  GHOST_SECRET_PREFIX,
  GHOST_SECRET_HINT_PREFIX,
  PROVIDER_SECRET_IDS,
  PI_PROXY_DERIVATION_KEY_STORAGE_KEY,
  REMOTE_MCP_BRIDGE_TOKEN_STORAGE_KEY,
  type ProviderSecretId,
} from '../../shared/providerSecrets.js';
import {
  getActiveAppSession,
  dataOwnerStorageKey,
  LOCAL_DATA_OWNER_ID,
} from '../appSessionState.js';
import { hasLegacyOwnerNamespaceClaim } from '../ownerNamespaceMigration.js';

const log = createLogger('providerSecretStore');

/**
 * 记录「本机这批 provider 密钥归属哪个账号」的标记键(非密钥,存同目录便于统一管理)。
 * 用于账号边界:登录 / 冷启动确立 userId 后,若 owner 与之不同(同机换账号),清掉
 * 上一个账号留在本机的密钥防串号;同账号重新登录 / 会话过期重登则保留,不必重填。
 */
const OWNER_STORAGE_KEY = 'provider_secret_owner';

/**
 * providerSecretStore.ts (main)
 * ---------------------------------------------------------------------------
 * 供应商 API key 的本机读写封装 —— **本地 only**,从不碰服务器。
 *
 * 在 Electron safeStorage(OS keychain / DPAPI 加密的 .enc 文件,目录
 * userData/safe-storage/<key>.enc)之上,提供 providerId 维度的
 * get / set / remove / has。存储键名由 shared/providerSecrets 统一解析。
 *
 * 存储格式与 bootstrap-electron 的 safe-storage IPC **字节级一致**,二者读写同一批
 * .enc 文件可互通(renderer 经 IPC 写、main 端经本 store 读)。改动默认 IO 的编码
 * 方式前务必同步 bootstrap-electron,否则跨进程读不到。
 *
 * 低层 IO 抽成 SecretStorageIo 便于注入测试(无需启动 Electron);默认实现走真实
 * safeStorage + fs。
 *
 * 注意:本 store 的 set / remove **不触发** 任何副作用(例如 api_key 变更后重建
 * Codex —— 那是 safe-storage IPC 层 onApiKeyChangedMaybeRestartCodex 的职责)。
 * main 端写路径仅限自定义供应商 CRUD 的 per-provider mutation queue；若扩展到
 * 需要重建运行时的内置 provider key，必须同步补对应副作用。
 */

/** 低层加密 KV(按 safeStorage 存储键名读写),抽出以便注入测试。 */
export interface SecretStorageIo {
  /** Production storage namespaces every logical key by the active data owner. */
  ownerScoped?: boolean;
  isAvailable(): boolean;
  read(storageKey: string): string | null;
  write(storageKey: string, value: string): boolean;
  remove(storageKey: string): { success: boolean; error?: string };
  /** 列出本机已落盘的全部存储键名（.enc 文件名去后缀）。用于按前缀批量清理动态键。 */
  list(): string[];
}

function secretDir(): string {
  return path.join(app.getPath('userData'), 'safe-storage');
}

const DYNAMIC_SECRET_PREFIXES = [
  CUSTOM_MCP_SECRET_PREFIX,
  CUSTOM_PROVIDER_HEADER_SECRET_PREFIX,
  'provider_key_',
  'provider_oauth_',
  GHOST_SECRET_PREFIX,
  GHOST_SECRET_HINT_PREFIX,
] as const;

function isManagedSecretStorageKey(key: string): boolean {
  return (
    PROVIDER_SECRET_IDS.some((id) => providerSecretStorageKey(id) === key) ||
    DYNAMIC_SECRET_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

function ownerStoragePrefix(ownerId: string): string {
  return `owner_${dataOwnerStorageKey(ownerId)}_`;
}

/** Resolve a renderer/main logical provider-secret key into the active owner's key. */
export function resolveOwnerScopedSecretStorageKey(storageKey: string): string | null {
  const ownerId = getActiveAppSession().dataOwnerId;
  if (!ownerId) return null;
  return `${ownerStoragePrefix(ownerId)}${storageKey}`;
}

function readPhysical(storageKey: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null;
  const filepath = path.join(secretDir(), `${storageKey}.enc`);
  if (!fs.existsSync(filepath)) return null;
  return safeStorage.decryptString(Buffer.from(fs.readFileSync(filepath, 'utf-8'), 'base64'));
}

function writePhysical(storageKey: string, value: string): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  fs.mkdirSync(secretDir(), { recursive: true });
  const encrypted = safeStorage.encryptString(value);
  fs.writeFileSync(
    path.join(secretDir(), `${storageKey}.enc`),
    encrypted.toString('base64'),
    'utf-8',
  );
  return true;
}

/**
 * Move the pre-namespace secret files into a verified cloud owner exactly once.
 * Local mode never scans or claims legacy credentials.
 */
function migrateLegacySecretsForCloudOwner(ownerId: string): void {
  if (ownerId === LOCAL_DATA_OWNER_ID) return;
  // The global claim decides which verified cloud owner may interpret the
  // pre-namespace files. A separate provider marker must not let a later
  // owner adopt leftovers when the first owner's migration was partial.
  if (!hasLegacyOwnerNamespaceClaim(ownerId)) return;
  let previousLegacyOwner: string | null = null;
  try {
    previousLegacyOwner = readPhysical(OWNER_STORAGE_KEY);
  } catch {
    previousLegacyOwner = null;
  }
  if (previousLegacyOwner && previousLegacyOwner !== ownerId) return;

  const targetPrefix = ownerStoragePrefix(ownerId);
  try {
    for (const fileName of fs.readdirSync(secretDir())) {
      if (!fileName.endsWith('.enc')) continue;
      const logicalKey = fileName.slice(0, -'.enc'.length);
      if (!isManagedSecretStorageKey(logicalKey)) continue;
      const source = path.join(secretDir(), fileName);
      const target = path.join(secretDir(), `${targetPrefix}${logicalKey}.enc`);
      if (fs.existsSync(target)) fs.unlinkSync(source);
      else fs.renameSync(source, target);
    }
    writePhysical(OWNER_STORAGE_KEY, ownerId);
    log.info('legacy provider secrets migrated into owner namespace', { ownerId });
  } catch (err) {
    log.warn('legacy provider secret migration failed', {
      ownerId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 默认 IO:Electron safeStorage + fs。编码 / 路径 / 幂等语义与
 * bootstrap-electron 的 safe-storage-{store,read,remove} 完全对齐。
 */
const electronSecretIo: SecretStorageIo = {
  ownerScoped: true,
  isAvailable() {
    return safeStorage.isEncryptionAvailable();
  },
  read(storageKey) {
    const scopedKey = resolveOwnerScopedSecretStorageKey(storageKey);
    return scopedKey ? readPhysical(scopedKey) : null;
  },
  write(storageKey, value) {
    const scopedKey = resolveOwnerScopedSecretStorageKey(storageKey);
    return scopedKey ? writePhysical(scopedKey, value) : false;
  },
  remove(storageKey) {
    const scopedKey = resolveOwnerScopedSecretStorageKey(storageKey);
    if (!scopedKey) return { success: true };
    try {
      fs.unlinkSync(path.join(secretDir(), `${scopedKey}.enc`));
      return { success: true };
    } catch (err) {
      // ENOENT:文件本就不存在 → 视为成功(幂等),与 IPC 层一致。
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { success: true };
      }
      return { success: false, error: 'remove_failed' };
    }
  },
  list() {
    const ownerId = getActiveAppSession().dataOwnerId;
    if (!ownerId) return [];
    const prefix = ownerStoragePrefix(ownerId);
    try {
      return fs
        .readdirSync(secretDir())
        .filter((f) => f.startsWith(prefix) && f.endsWith('.enc'))
        .map((f) => f.slice(prefix.length, -'.enc'.length));
    } catch {
      // 目录不存在(尚无任何密钥落盘)等 → 空列表。
      return [];
    }
  },
};

/**
 * 「本机密钥被整体清空」监听(账号切换触发)。用于让上层失效各自的内存缓存——
 * 典型:generic-oauth 的 blob 内存缓存,不失效会让 B 账号继续用 A 的 token 路由。
 * setter 注入避免 secrets 层反向依赖 maker-host(host 启动期接线)。
 */
const secretsClearedListeners = new Set<() => void>();
/**
 * 重置为单个监听(覆盖式,历史 API)。测试用它隔离状态;生产代码一律用
 * addProviderSecretsClearedListener —— 多个上层各自缓存各自的密钥,
 * 单槽覆盖会让后注册者把先注册者的失效回调挤掉。
 */
export function setProviderSecretsClearedListener(listener: () => void): void {
  secretsClearedListeners.clear();
  secretsClearedListeners.add(listener);
}
/** 追加一个清空监听,返回注销函数。生产代码注册缓存失效回调的入口。 */
export function addProviderSecretsClearedListener(listener: () => void): () => void {
  secretsClearedListeners.add(listener);
  return () => {
    secretsClearedListeners.delete(listener);
  };
}

/** providerId 维度的密钥读写器。 */
export interface ProviderSecretStore {
  /** 读取某供应商的密钥;不存在 / safeStorage 不可用 / 读失败均返回 null。 */
  get(id: ProviderSecretId): string | null;
  /** 写入(覆盖)某供应商的密钥;返回是否成功落盘。 */
  set(id: ProviderSecretId, value: string): boolean;
  /** 移除某供应商的密钥;文件本就不存在视为成功(幂等)。 */
  remove(id: ProviderSecretId): { success: boolean; error?: string };
  /** 该供应商本机是否已配置密钥。 */
  has(id: ProviderSecretId): boolean;
  /** 清空本机所有已登记 provider 的密钥(账号切换时用)。不动 owner 标记本身。 */
  clearAll(): void;
  /** Invalidate process-local OAuth/token caches without deleting owner files. */
  invalidateCaches(): void;
  /** 读取「本机密钥归属账号」标记;未设置返回 null。 */
  getOwnerUserId(): string | null;
  /**
   * 账号边界对账:在登录 / 冷启动确立 userId 后调用。
   * - owner 不存在(首次)或等于 userId → 保留本机密钥,仅刷新 owner 标记;
   * - owner 与 userId 不同(同机换账号)→ 先清空本机密钥,再写新 owner。
   * 返回是否发生了清空。
   */
  reconcileOwner(userId: string): { cleared: boolean };
}

/** 用注入的 IO 构造 store(测试用);生产走 getProviderSecretStore() 单例。 */
export function createProviderSecretStore(
  io: SecretStorageIo = electronSecretIo,
): ProviderSecretStore {
  let lastReconciledOwnerId: string | null = null;
  const notifySecretsCleared = (): void => {
    for (const listener of secretsClearedListeners) {
      try {
        listener();
      } catch {
        /* 监听器异常不阻断账号边界清理与其他监听器 */
      }
    }
  };
  const clearAllSecrets = (): void => {
    for (const id of PROVIDER_SECRET_IDS) {
      io.remove(providerSecretStorageKey(id));
    }
    // SSH 远端 daemon 直连 MCP bridge 的 persistent token 同清:同机换账号后,
    // 旧账号远端 host 上仍在跑的 daemon env 里的 token 必须失效,防串号。
    io.remove(REMOTE_MCP_BRIDGE_TOKEN_STORAGE_KEY);
    io.remove(PI_PROXY_DERIVATION_KEY_STORAGE_KEY);
    // 动态键名密钥同清(按前缀扫 io.list()):自定义 MCP bearer token(mcp_token_<id>)、
    // 自定义供应商 per-runtime key(provider_key_*)、通用 OAuth 凭证 blob(provider_oauth_*)、
    // 意识 network 槽凭证(ghost_secret_*)。这些不在 PROVIDER_SECRET_IDS 静态集合里,
    // 漏清会让同机换账号后 B 用 A 的凭证串号。
    for (const key of io.list()) {
      if (DYNAMIC_SECRET_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        io.remove(key);
      }
    }
    notifySecretsCleared();
  };
  return {
    get(id) {
      try {
        return io.read(providerSecretStorageKey(id));
      } catch (err) {
        log.warn(
          { id, err: err instanceof Error ? err.message : String(err) },
          'read provider secret failed',
        );
        return null;
      }
    },
    set(id, value) {
      try {
        return io.write(providerSecretStorageKey(id), value);
      } catch (err) {
        log.warn(
          { id, err: err instanceof Error ? err.message : String(err) },
          'write provider secret failed',
        );
        return false;
      }
    },
    remove(id) {
      return io.remove(providerSecretStorageKey(id));
    },
    has(id) {
      try {
        return io.read(providerSecretStorageKey(id)) != null;
      } catch {
        return false;
      }
    },
    clearAll() {
      clearAllSecrets();
    },
    invalidateCaches() {
      lastReconciledOwnerId = null;
      notifySecretsCleared();
    },
    getOwnerUserId() {
      if (io.ownerScoped) return getActiveAppSession().dataOwnerId;
      try {
        return io.read(OWNER_STORAGE_KEY);
      } catch {
        return null;
      }
    },
    reconcileOwner(userId) {
      if (io.ownerScoped) {
        if (getActiveAppSession().dataOwnerId !== userId) {
          log.warn('provider secret owner does not match active app session', { userId });
          return { cleared: false };
        }
        migrateLegacySecretsForCloudOwner(userId);
        if (lastReconciledOwnerId !== userId) {
          // Owner-scoped files remain isolated on disk, but generic OAuth and
          // similar consumers still keep process-local token caches. Invalidate
          // those caches whenever the committed data owner changes.
          notifySecretsCleared();
          lastReconciledOwnerId = userId;
        }
        return { cleared: false };
      }
      let prev: string | null = null;
      try {
        prev = io.read(OWNER_STORAGE_KEY);
      } catch {
        prev = null;
      }
      const cleared = prev != null && prev !== userId;
      if (cleared) {
        clearAllSecrets();
        log.info({ prevOwner: prev, userId }, 'provider secrets cleared on account switch');
      }
      try {
        io.write(OWNER_STORAGE_KEY, userId);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'write provider secret owner failed',
        );
      }
      return { cleared };
    },
  };
}

let singleton: ProviderSecretStore | null = null;

/** 进程内单例(默认 Electron IO)。 */
export function getProviderSecretStore(): ProviderSecretStore {
  if (!singleton) singleton = createProviderSecretStore();
  return singleton;
}

/**
 * 读取某自定义供应商**某 runtime** 的 API key(**main 侧路由 resolve 专用**)。
 * 不存在 / safeStorage 不可用 / 读失败均返回 null。复用默认 electronSecretIo,
 * 与 renderer 经通用 safe-storage IPC 写入的 .enc 文件字节级互通。
 */
export function readCustomProviderKey(providerId: string, agent: string): string | null {
  const storageProviderId = storedCustomProviderId(providerId);
  try {
    return electronSecretIo.read(customProviderSecretStorageKey(storageProviderId, agent));
  } catch (err) {
    log.warn(
      { providerId, agent, err: err instanceof Error ? err.message : String(err) },
      'read custom provider key failed',
    );
    return null;
  }
}

function parseCustomProviderHeaders(raw: string): Record<string, string> {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('custom provider headers must be an object');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([name, headerValue]) => !name || typeof headerValue !== 'string')) {
    throw new Error('custom provider headers must be string pairs');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Read one runtime's encrypted custom headers for routing/Pi injection. */
export function readCustomProviderHeaders(
  providerId: string,
  agent: string,
): Record<string, string> | null {
  const storageProviderId = storedCustomProviderId(providerId);
  try {
    const raw = electronSecretIo.read(customProviderHeaderStorageKey(storageProviderId, agent));
    return raw === null ? null : parseCustomProviderHeaders(raw);
  } catch (err) {
    log.warn(
      { providerId, agent, err: err instanceof Error ? err.message : String(err) },
      'read custom provider headers failed',
    );
    return null;
  }
}

/**
 * 配置 CRUD 回滚前的严格 API key 快照读取。
 * 仅 ENOENT 表示“没有旧 key”；owner / 加密不可用、文件读取或解密失败都必须抛错，
 * 防止调用方把暂时不可读的现有凭证误判为空并永久删除。
 */
export function readCustomProviderKeyForMutation(
  providerId: string,
  agent: string,
): string | null {
  const logicalKey = customProviderSecretStorageKey(providerId, agent);
  const scopedKey = resolveOwnerScopedSecretStorageKey(logicalKey);
  if (!scopedKey) throw new Error('provider secret owner is unavailable');
  let encoded: string;
  try {
    encoded = fs.readFileSync(path.join(secretDir(), `${scopedKey}.enc`), 'utf-8');
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    log.warn(
      { providerId, agent, err: err instanceof Error ? err.message : String(err) },
      'read custom provider key snapshot failed',
    );
    throw new Error('existing provider credential is unreadable');
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('provider credential encryption is unavailable');
  }
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch (err) {
    log.warn(
      { providerId, agent, err: err instanceof Error ? err.message : String(err) },
      'decrypt custom provider key snapshot failed',
    );
    throw new Error('existing provider credential is unreadable');
  }
}

/** Strict mutation snapshot for an encrypted runtime header blob. */
export function readCustomProviderHeadersForMutation(
  providerId: string,
  agent: string,
): Record<string, string> | null {
  const logicalKey = customProviderHeaderStorageKey(providerId, agent);
  const scopedKey = resolveOwnerScopedSecretStorageKey(logicalKey);
  if (!scopedKey) throw new Error('provider secret owner is unavailable');
  let encoded: string;
  try {
    encoded = fs.readFileSync(path.join(secretDir(), `${scopedKey}.enc`), 'utf-8');
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('existing provider header credentials are unreadable');
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('provider credential encryption is unavailable');
  }
  try {
    return parseCustomProviderHeaders(
      safeStorage.decryptString(Buffer.from(encoded, 'base64')),
    );
  } catch (err) {
    log.warn(
      { providerId, agent, err: err instanceof Error ? err.message : String(err) },
      'decrypt custom provider headers snapshot failed',
    );
    throw new Error('existing provider header credentials are unreadable');
  }
}

/** 写入某自定义供应商 runtime 的 API key；供 main 侧原子配置更新使用。 */
export function storeCustomProviderKey(
  providerId: string,
  agent: string,
  value: string,
): boolean {
  try {
    return electronSecretIo.write(customProviderSecretStorageKey(providerId, agent), value);
  } catch (err) {
    log.warn(
      { providerId, agent, err: err instanceof Error ? err.message : String(err) },
      'write custom provider key failed',
    );
    return false;
  }
}

/** Persist one runtime's complete custom-header map as a main-only encrypted blob. */
export function storeCustomProviderHeaders(
  providerId: string,
  agent: string,
  headers: Record<string, string>,
): boolean {
  try {
    return electronSecretIo.write(
      customProviderHeaderStorageKey(providerId, agent),
      JSON.stringify(headers),
    );
  } catch (err) {
    log.warn(
      { providerId, agent, err: err instanceof Error ? err.message : String(err) },
      'write custom provider headers failed',
    );
    return false;
  }
}

/**
 * 读取 SSH 远端 daemon 直连 MCP bridge 的 persistent bearer token
 * (**main 侧 HTTP bridge 鉴权专用**)。不存在 / safeStorage 不可用 / 读失败
 * 均返回 null。与通用 safe-storage IPC 字节级互通;main-only 键,renderer
 * 不可经 generic bridge 访问。
 */
export function readRemoteMcpBridgeToken(): string | null {
  try {
    return electronSecretIo.read(REMOTE_MCP_BRIDGE_TOKEN_STORAGE_KEY);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'read remote mcp bridge token failed',
    );
    return null;
  }
}

/** 写入 remote MCP bridge persistent token(仅不存在时的首次生成路径调用)。 */
export function writeRemoteMcpBridgeToken(value: string): boolean {
  try {
    return electronSecretIo.write(REMOTE_MCP_BRIDGE_TOKEN_STORAGE_KEY, value);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'write remote mcp bridge token failed',
    );
    return false;
  }
}

/** Read the host-only HMAC key used to derive remote Pi proxy session tokens. */
export function readPiProxyDerivationKey(): string | null {
  try {
    return electronSecretIo.read(PI_PROXY_DERIVATION_KEY_STORAGE_KEY);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'read pi proxy derivation key failed',
    );
    return null;
  }
}

/** Persist the host-only remote Pi proxy derivation key on first use. */
export function writePiProxyDerivationKey(value: string): boolean {
  try {
    return electronSecretIo.write(PI_PROXY_DERIVATION_KEY_STORAGE_KEY, value);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'write pi proxy derivation key failed',
    );
    return false;
  }
}

/** 删除某自定义供应商 runtime 的 API key；不存在视为成功。 */
export function removeCustomProviderKey(
  providerId: string,
  agent: string,
): { success: boolean; error?: string } {
  try {
    return electronSecretIo.remove(customProviderSecretStorageKey(providerId, agent));
  } catch (err) {
    log.warn(
      { providerId, agent, err: err instanceof Error ? err.message : String(err) },
      'remove custom provider key failed',
    );
    return { success: false, error: 'remove_failed' };
  }
}

/** Delete one runtime's encrypted custom-header blob; absence is success. */
export function removeCustomProviderHeaders(
  providerId: string,
  agent: string,
): { success: boolean; error?: string } {
  try {
    return electronSecretIo.remove(customProviderHeaderStorageKey(providerId, agent));
  } catch (err) {
    log.warn(
      { providerId, agent, err: err instanceof Error ? err.message : String(err) },
      'remove custom provider headers failed',
    );
    return { success: false, error: 'remove_failed' };
  }
}

/**
 * 读取某自定义 MCP 服务器的 bearer token(**main 侧 CustomMcpProvider resolve 专用**)。
 * 不存在 / safeStorage 不可用 / 读失败均返回 null。与 renderer 经通用 safe-storage IPC
 * 写入的 .enc 文件字节级互通。
 */
export function readCustomMcpToken(mcpId: string): string | null {
  try {
    return electronSecretIo.read(customMcpSecretStorageKey(mcpId));
  } catch (err) {
    log.warn(
      { mcpId, err: err instanceof Error ? err.message : String(err) },
      'read custom mcp token failed',
    );
    return null;
  }
}

/**
 * 通用 OAuth 供应商凭证 blob 的 main 侧存储 IO（`provider_oauth_<id>`，机制同上）。
 * generic-oauth Runner 经 setter 注入消费（保持 Runner 可脱 Electron 单测）。
 */
/**
 * 读取某意识的某条 network 槽凭证(**main 侧 networkSlot 注入专用**)。
 * 不存在 / safeStorage 不可用 / 读失败均返回 null。与 renderer 经通用
 * safe-storage IPC 写入的 .enc 文件字节级互通。凭证值从不进日志(只记 id)。
 */
export function readGhostSecret(ghostId: string, secretKey: string): string | null {
  try {
    return electronSecretIo.read(ghostSecretStorageKey(ghostId, secretKey));
  } catch (err) {
    log.warn(
      { ghostId, secretKey, err: err instanceof Error ? err.message : String(err) },
      'read ghost secret failed',
    );
    return null;
  }
}

/**
 * Strict Ghost secret read for owner-stable repair jobs. Absence is still a
 * normal null result, while keychain, IO, and decrypt failures remain errors
 * so the durable coordinator can retry instead of memoizing a false no-op.
 */
export function readGhostSecretStrict(ghostId: string, secretKey: string): string | null {
  const physicalKey = resolveOwnerScopedSecretStorageKey(
    ghostSecretStorageKey(ghostId, secretKey),
  );
  if (!physicalKey) return null;
  const filepath = path.join(secretDir(), `${physicalKey}.enc`);
  let encoded: string;
  try {
    encoded = fs.readFileSync(filepath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage is unavailable');
  }
  return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
}

/**
 * 只查某意识凭证是否已入库(加密文件存在性,**不解密**)。插件页 setup
 * 就绪检查专用:判定只需要「存没存」,解密既无必要,还会把 safeStorage
 * 读取异常折叠成「未配置」造成误拦——存在性口径下,文件在就算已配置
 * (即便当下解密不可用,那是注入期要处理的问题,不该拦在使用入口)。
 * ENOENT 之外的真 IO 异常(如权限)**原样上抛**:「查询失败」≠「未配置」,
 * 调用方(ghosts:setup-status)让 invoke reject,renderer 侧 fail-open。
 * 键名走 ghostSecretStorageKey(官方别名同 read 侧)。
 */
export function ghostSecretSaved(ghostId: string, secretKey: string): boolean {
  try {
    const physicalKey = resolveOwnerScopedSecretStorageKey(
      ghostSecretStorageKey(ghostId, secretKey),
    );
    if (!physicalKey) return false;
    fs.statSync(path.join(secretDir(), `${physicalKey}.enc`));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * 写入某意识的某条 network 槽凭证(**main 侧 /secrets 只写通道专用**,
 * input:'ghost' 凭证由意识 settingsHtml 收单后经协议一次性交来)。
 * 键名走 ghostSecretStorageKey(官方别名同 read 侧),与 renderer 写入的
 * .enc 文件字节级互通。凭证值从不进日志(只记 id)。
 */
export function storeGhostSecret(ghostId: string, secretKey: string, value: string): boolean {
  try {
    const ok = electronSecretIo.write(ghostSecretStorageKey(ghostId, secretKey), value);
    if (ok) {
      // 入库即截尾 4 位指纹(分键保管,读路径永不碰明文);值太短不产指纹,
      // 且要清掉旧值可能留下的指纹。指纹写失败不连坐主凭证(best-effort)。
      try {
        const tail = deriveGhostSecretTail(value);
        const hintKey = ghostSecretHintStorageKey(ghostId, secretKey);
        if (tail) electronSecretIo.write(hintKey, tail);
        else electronSecretIo.remove(hintKey);
      } catch (err) {
        log.warn(
          { ghostId, secretKey, err: err instanceof Error ? err.message : String(err) },
          'store ghost secret tail failed',
        );
      }
    }
    return ok;
  } catch (err) {
    log.warn(
      { ghostId, secretKey, err: err instanceof Error ? err.message : String(err) },
      'store ghost secret failed',
    );
    return false;
  }
}

/**
 * 读某意识某条凭证的「尾 4 位指纹」(/secrets GET 状态回查用)。
 * 常规路径只回入库时预截的指纹;老键(host 收单时代或别名互通存的)没截过
 * 指纹,首查时**懒回填**——main 本来就持有明文读取权(每次代发注入都在读),
 * 此处补读一次截存指纹,沙箱可见面不变(仍只有预截的 4 个字符)。
 * 没存过 / 值太短不产指纹 / 读失败均返回 null(UI 降级成只显示「已保存」)。
 * io 可注入以便单测;生产走 electronSecretIo 包装。
 */
export function readGhostSecretTailFromIo(
  io: SecretStorageIo,
  ghostId: string,
  secretKey: string,
): string | null {
  try {
    const hintKey = ghostSecretHintStorageKey(ghostId, secretKey);
    const existing = io.read(hintKey);
    if (existing !== null) return existing;
    const value = io.read(ghostSecretStorageKey(ghostId, secretKey));
    if (value === null) return null;
    const tail = deriveGhostSecretTail(value);
    if (tail) io.write(hintKey, tail);
    return tail;
  } catch (err) {
    log.warn(
      { ghostId, secretKey, err: err instanceof Error ? err.message : String(err) },
      'read ghost secret tail failed',
    );
    return null;
  }
}

/** readGhostSecretTailFromIo 的生产入口(默认 safeStorage IO)。 */
export function readGhostSecretTail(ghostId: string, secretKey: string): string | null {
  return readGhostSecretTailFromIo(electronSecretIo, ghostId, secretKey);
}

/** 清除某意识的单条 network 槽凭证(/secrets DELETE 用;幂等,连同尾指纹)。 */
export function removeGhostSecret(ghostId: string, secretKey: string): void {
  try {
    electronSecretIo.remove(ghostSecretStorageKey(ghostId, secretKey));
    electronSecretIo.remove(ghostSecretHintStorageKey(ghostId, secretKey));
  } catch (err) {
    log.warn(
      { ghostId, secretKey, err: err instanceof Error ? err.message : String(err) },
      'remove ghost secret failed',
    );
  }
}

/**
 * 清掉某意识名下的全部 network 槽凭证(卸载意识时调用;幂等)。
 * 按 `ghost_secret_<ghostId>_` 前缀扫 io.list(),不依赖清单里的 secrets
 * 声明——旧版本声明过、新版本删掉的孤儿键也一并清。
 */
export function removeGhostSecrets(ghostId: string): void {
  const prefixes = [`${GHOST_SECRET_PREFIX}${ghostId}_`, `${GHOST_SECRET_HINT_PREFIX}${ghostId}_`];
  try {
    for (const key of electronSecretIo.list()) {
      if (prefixes.some((prefix) => key.startsWith(prefix))) electronSecretIo.remove(key);
    }
  } catch (err) {
    log.warn(
      { ghostId, err: err instanceof Error ? err.message : String(err) },
      'remove ghost secrets failed',
    );
  }
}

export const genericOAuthSecretIo = {
  read(providerId: string): string | null {
    try {
      return electronSecretIo.read(providerOAuthStorageKey(providerId));
    } catch (err) {
      log.warn(
        { providerId, err: err instanceof Error ? err.message : String(err) },
        'read generic oauth blob failed',
      );
      return null;
    }
  },
  readStrict(providerId: string): string | null {
    const logicalKey = providerOAuthStorageKey(providerId);
    const scopedKey = resolveOwnerScopedSecretStorageKey(logicalKey);
    if (!scopedKey) throw new Error('provider secret owner is unavailable');
    let encoded: string;
    try {
      encoded = fs.readFileSync(path.join(secretDir(), `${scopedKey}.enc`), 'utf-8');
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      log.warn(
        { providerId, err: err instanceof Error ? err.message : String(err) },
        'read generic oauth blob snapshot failed',
      );
      throw new Error('existing OAuth credential is unreadable');
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('provider credential encryption is unavailable');
    }
    try {
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
    } catch (err) {
      log.warn(
        { providerId, err: err instanceof Error ? err.message : String(err) },
        'decrypt generic oauth blob snapshot failed',
      );
      throw new Error('existing OAuth credential is unreadable');
    }
  },
  write(providerId: string, value: string): boolean {
    try {
      return electronSecretIo.write(providerOAuthStorageKey(providerId), value);
    } catch (err) {
      log.warn(
        { providerId, err: err instanceof Error ? err.message : String(err) },
        'write generic oauth blob failed',
      );
      return false;
    }
  },
  remove(providerId: string): boolean {
    try {
      const result = electronSecretIo.remove(providerOAuthStorageKey(providerId));
      if (!result.success) {
        log.warn(
          { providerId, error: result.error ?? 'remove_failed' },
          'remove generic oauth blob failed',
        );
      }
      return result.success;
    } catch (err) {
      // 键名校验抛错（非法 id）或底层删除异常：保留现有登录态并把失败交给调用方。
      log.warn(
        { providerId, err: err instanceof Error ? err.message : String(err) },
        'remove generic oauth blob failed',
      );
      return false;
    }
  },
};
