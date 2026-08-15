/**
 * createDesktopProviderService —— 桌面端目录加载落地 + provider-service 接线。
 *
 * 两块职责：
 *   1. 目录加载器 `ensureActiveCatalogLoaded`：用 electron net.request 拉公共 Catalog、node fs 读 dev
 *      本地文件，把结果写进 active-catalog 单例（getActiveCatalog 同步读）。
 *        - release / dev：都从区域化 Model Access 公共接口加载，失败时回退旧 OSS 目录。
 *        - dev 可由 XDT_MODELS_PATH 指向本地文件即时生效（本地文件优先于远端）。
 *        - env 兜底：XDT_MODELS_URL（完整覆盖 URL）/ XDT_DISABLE_MODELS_FETCH（强制不联网）。
 *      **每进程拉一次、存内存、无 TTL**：启动总是先拉远端；失败时才读按端点隔离的
 *      last-known-good 快照，最后回退 bundled。
 *      启动期（splash）由 bootstrap-electron 在构造 Maker 前 await 一次（见 registerMakerIpcsAfterSplash）。
 *   2. `getDesktopProviderService`：把 active-catalog + 连接状态读取器注入 provider-service。
 *      连接状态直接复用现有凭证存储——XD = 托管 gateway key 是否存在、
 *      Anthropic = 系统 Claude.ai OAuth 是否登录、OpenAI = Codex 是否 OAuth 登录。
 *      与设置页现有 auth 流程同源，不另立通道。
 */

import { app, net } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import {
  BUNDLED_CATALOG,
  compareModelRegistryRevisions,
  decideModelRegistrySnapshot,
  DEFAULT_REMOTE_CATALOG_BUDGET_MS,
  loadCatalog,
  loadCatalogWithSource,
  parseCatalog,
  storedCustomProviderId,
  type Catalog,
  type CatalogCapabilityEvidence,
  type CatalogIO,
  type CatalogLoadResult,
  type CatalogSourceConfig,
} from '@cindy/model-providers';

import { createLogger } from '../logger.js';
import { getBaseUrl } from '../manifestService.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { getBuildClientEndpoint, getClientEndpoint } from '../clientEndpointsService.js';
import {
  commitActiveCatalogSnapshot,
  getActiveCatalog,
  getModelPlaneWarnings,
  setActiveCatalog,
  setCustomProviderConfigs,
  setCustomProviders,
  setDiscoveredCodexModels,
  setLocalCatalogOverrides,
} from './active-catalog.js';
import { readModelCatalogOverrides } from './model-catalog-override-store.js';
import {
  readCodexDiscoveredModels,
  readCodexDiscoveredModelsForAuthRefresh,
} from './codex-model-discovery.js';
import {
  getAnthropicModelDiscoveryFailure,
  loadAnthropicModelsFromDiskCache,
  refreshAnthropicModelsFromHttp,
} from './model-discovery/anthropic.js';
import {
  clearXaiDiscoveredModels,
  loadXaiModelsFromDiskCache,
  refreshXaiModelsFromHttp,
} from './model-discovery/xai.js';
import { createProviderService, type ProviderService } from './provider-service.js';
import { readModelDisableOverrides } from './model-disable-store.js';
import { listCustomProvidersWithSecureHeaders } from './custom-provider-header-secrets.js';
import {
  setCustomProviderKeyReader,
  setOAuthTokenReader,
  setProviderOAuthTokenReader,
  setProviderViewsReader,
  type ProviderOAuthTokenReadOptions,
} from './provider-route.js';
import { setDiagnosticsKeyReader, setDiagnosticsOAuthTokenReader } from './provider-diagnostics.js';
import {
  configureGenericOAuth,
  hasGenericOAuthLogin,
  readCachedGenericOAuthAccessToken,
  resetGenericOAuthMemoryCache,
} from './generic-oauth.js';
import {
  genericOAuthSecretIo,
  addProviderSecretsClearedListener,
} from '../secrets/providerSecretStore.js';
import { readClaudeApiKey, desktopCodexAuthAdapter } from './auth-adapters.js';
import { getProviderSecretStore, readCustomProviderKey } from '../secrets/providerSecretStore.js';
import { hasClaudeAiOAuth, hasClaudeAiOAuthUnbound } from './claude-credentials-store.js';
import { getValidClaudeAiOAuth } from './claude-oauth-refresh.js';
import {
  getGrokAccessToken,
  hasGrokOAuthLogin,
  recoverGrokAuthAfterRejection,
  resetGrokOAuthMemoryCache,
} from './grok-oauth-login.js';
import { clearXaiMediaModels } from './model-discovery/xai-media.js';
import { getAuthState } from '../authManager.js';
import { getActiveAppSession } from '../appSessionState.js';
import { filterProviderCatalogForAccount } from './provider-access-policy.js';
import { getAppCapabilities } from '../appCapabilities.js';
import {
  claimDetectedNativeProviderAuth,
  migrateLegacyNativeProviderAuthBindings,
} from './nativeProviderAuthBinding.js';
import { hasLegacyOwnerNamespaceClaim } from '../ownerNamespaceMigration.js';
import { broadcastReferenceModelPricing } from '../usage/referenceModelPricing.js';

const log = createLogger('provider-service');

/**
 * electron net.request GET → 文本。非 200 / 超时 / 网络错均 reject，
 * 由 loadCatalog 兜底到内置目录（绝不让目录加载抛穿）。
 */
function fetchText(url: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    try {
      const request = net.request(url);
      request.setHeader('Cache-Control', 'no-cache');
      let body = '';
      const timer = setTimeout(() => {
        request.abort();
        settle(() => reject(new Error(`catalog fetch timeout: ${url}`)));
      }, timeoutMs);

      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          clearTimeout(timer);
          response.on('data', () => {});
          settle(() => reject(new Error(`catalog fetch HTTP ${response.statusCode}`)));
          return;
        }
        response.on('data', (chunk) => {
          body += chunk.toString();
        });
        response.on('end', () => {
          clearTimeout(timer);
          settle(() => resolve(body));
        });
        response.on('error', (err) => {
          clearTimeout(timer);
          settle(() => reject(err));
        });
      });
      request.on('error', (err) => {
        clearTimeout(timer);
        settle(() => reject(err));
      });
      request.end();
    } catch (err) {
      settle(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}

const CATALOG_LKG_VERSION = 2;

interface CatalogLkgEnvelope {
  version: typeof CATALOG_LKG_VERSION;
  scopeHash: string;
  catalog: string;
}

interface CatalogLkgFileIo {
  rename(from: string, to: string): Promise<void>;
  rm(target: string, options: { force: boolean }): Promise<void>;
}

const catalogLkgWriteTails = new Map<string, Promise<void>>();

function catalogScopeHash(scope: string): string {
  return createHash('sha256').update(scope).digest('hex');
}

function catalogLkgPath(scope: string): string {
  return path.join(
    app.getPath('userData'),
    'cache',
    'model-catalog',
    `${catalogScopeHash(scope).slice(0, 24)}.json`,
  );
}

function catalogLkgEnvelope(scope: string, catalog: string): CatalogLkgEnvelope {
  return {
    version: CATALOG_LKG_VERSION,
    scopeHash: catalogScopeHash(scope),
    catalog,
  };
}

async function readCatalogLkg(scope: string): Promise<string | null> {
  const file = catalogLkgPath(scope);
  for (const candidate of [file, `${file}.bak`]) {
    try {
      const envelope = JSON.parse(
        await fsp.readFile(candidate, 'utf8'),
      ) as Partial<CatalogLkgEnvelope>;
      return envelope.version === CATALOG_LKG_VERSION &&
        envelope.scopeHash === catalogScopeHash(scope) &&
        typeof envelope.catalog === 'string'
        ? envelope.catalog
        : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
  return null;
}

/**
 * Replace an existing LKG without depending on POSIX rename-overwrite semantics. Windows may
 * reject that operation while the destination exists, so preserve the prior snapshot until the
 * new file is in place and restore it if the second rename fails.
 */
async function replaceCatalogLkgFile(
  temporary: string,
  file: string,
  fileIo: CatalogLkgFileIo = fsp,
): Promise<void> {
  try {
    await fileIo.rename(temporary, file);
    await fileIo.rm(`${file}.bak`, { force: true }).catch(() => undefined);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY' && code !== 'EEXIST') throw err;
  }

  const backup = `${file}.bak`;
  await fileIo.rm(backup, { force: true }).catch(() => undefined);
  let preservedExisting = false;
  try {
    await fileIo.rename(file, backup);
    preservedExisting = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  try {
    await fileIo.rename(temporary, file);
  } catch (err) {
    if (preservedExisting) {
      await fileIo.rename(backup, file).catch(() => undefined);
    }
    throw err;
  }
  if (preservedExisting) {
    await fileIo.rm(backup, { force: true }).catch(() => undefined);
  }
}

function catalogLkgTemporaryPath(file: string, nonce = randomUUID()): string {
  return `${file}.${process.pid}.${nonce}.tmp`;
}

/** Serialize the complete replace transaction per scope while leaving different scopes parallel. */
async function serializeCatalogLkgWrite<T>(file: string, write: () => Promise<T>): Promise<T> {
  const previous = catalogLkgWriteTails.get(file) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(write);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  catalogLkgWriteTails.set(file, tail);
  try {
    return await current;
  } finally {
    if (catalogLkgWriteTails.get(file) === tail) catalogLkgWriteTails.delete(file);
  }
}

function selectCatalogLkgSnapshot(incoming: string, current: string | null): string {
  if (current === null) return incoming;
  try {
    const incomingRegistry = parseCatalog(incoming).modelRegistry;
    const currentRegistry = parseCatalog(current).modelRegistry;
    const decision = decideModelRegistrySnapshot(incomingRegistry, currentRegistry);
    if (decision !== 'accept-incoming') {
      // Registry 缺失、revision 回退或同 revision 异内容都不能覆盖磁盘 LKG；否则
      // 下一次启动已经失去可对照的 last-good，source 层的守卫也无法再救回旧快照。
      return current;
    }
  } catch {
    // An invalid current envelope payload is not an LKG; replace it with the already-validated input.
  }
  return incoming;
}

async function writeCatalogLkg(scope: string, catalog: string): Promise<string> {
  const file = catalogLkgPath(scope);
  return serializeCatalogLkgWrite(file, async () => {
    const selected = selectCatalogLkgSnapshot(catalog, await readCatalogLkg(scope));
    if (selected !== catalog) return selected;
    const temporary = catalogLkgTemporaryPath(file);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const envelope = catalogLkgEnvelope(scope, selected);
    await fsp.writeFile(temporary, JSON.stringify(envelope), 'utf8');
    try {
      await replaceCatalogLkgFile(temporary, file);
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
    }
    return selected;
  });
}

/** 桌面端 CatalogIO —— net + fs + 按端点隔离的 last-known-good 快照。 */
const io: CatalogIO = {
  fetchText,
  readCache: readCatalogLkg,
  writeCache: writeCatalogLkg,
  async readFile(p) {
    try {
      return await fsp.readFile(p, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  },
  log: (level, msg, meta) => log[level](msg, meta),
};

/**
 * 构建目录源配置。release 与 dev 统一使用区域化 Model Access 公共接口，旧 OSS 保留为迁移期回退。
 *
 * 会话切到另一 auth realm 时，Model Access 公共接口随 active endpoint 改变并触发整份目录
 * 重载。旧 OSS 只属于安装包区域，因此仅同区加载允许使用；跨区主源失败时直接退化 bundled，
 * 绝不把安装区域的 provider/routing 目录冒充成组织区域目录。
 */
function buildSource(): CatalogSourceConfig {
  const explicitUrl = process.env.XDT_MODELS_URL;
  const baseUrl = getClientEndpoint('modelAccessApiBaseUrl');
  const usesBuildRealm = baseUrl === getBuildClientEndpoint('modelAccessApiBaseUrl');
  return {
    url: explicitUrl,
    localPath: process.env.XDT_MODELS_PATH,
    baseUrl,
    fallbackBaseUrl: !usesBuildRealm ? undefined : getBaseUrl(),
    remoteBudgetMs: DEFAULT_REMOTE_CATALOG_BUDGET_MS,
    disableFetch: process.env.XDT_DISABLE_MODELS_FETCH === '1',
  };
}

function catalogSourceKey(source: CatalogSourceConfig): string {
  return JSON.stringify({
    url: source.url ?? null,
    localPath: source.localPath ?? null,
    baseUrl: source.baseUrl ?? null,
    fallbackBaseUrl: source.fallbackBaseUrl ?? null,
    disableFetch: source.disableFetch ?? false,
  });
}

/**
 * 一次性清理旧版本遗留的未分 scope 目录缓存（provider-catalog-cache.json + .tmp）。
 * 新版 LKG 使用 cache/model-catalog/<scope-hash>.json，不读取这两个历史文件。
 * best-effort：不存在 / 删除失败都静默忽略（fsp.rm force 不因 ENOENT 抛），绝不阻塞或抛。
 */
async function cleanupLegacyCatalogCache(): Promise<void> {
  const file = path.join(app.getPath('userData'), 'provider-catalog-cache.json');
  for (const p of [file, `${file}.tmp`]) {
    try {
      await fsp.rm(p, { force: true });
    } catch {
      /* 历史孤儿清理失败无所谓（权限 / 占用等），不影响目录加载。 */
    }
  }
}

let activeLoaded = false;
let activeInflight: Promise<Catalog> | null = null;
let catalogRefreshInflight: {
  sourceKey: string;
  promise: Promise<Catalog>;
} | null = null;
let activeCatalogSourceKey: string | null = null;
let endpointReloadGeneration = 0;
let endpointReloadInflight: {
  sourceKey: string;
  promise: Promise<Catalog>;
} | null = null;

async function readXaiProviderOAuthToken(
  options?: ProviderOAuthTokenReadOptions,
): Promise<string | null> {
  if (!options?.forceRefresh) return getGrokAccessToken();

  // A forced retry must stay bound to the exact bearer rejected upstream. Without that
  // baseline we cannot safely decide which account generation to refresh.
  const staleToken = options.staleToken;
  if (!staleToken) return null;

  const outcome = await recoverGrokAuthAfterRejection(staleToken);
  if (outcome !== 'refreshed' && outcome !== 'superseded') return null;

  // `superseded` means another request/login already replaced the rejected credential.
  // Return that newer token, but never replay the bearer which caused the 401/403.
  const token = await getGrokAccessToken();
  return token !== staleToken ? token : null;
}

/** Set 用稳定函数引用去重，ensureActiveCatalogLoaded 的幂等调用不会重复注册清理副作用。 */
function handleProviderSecretsCleared(): void {
  resetGenericOAuthMemoryCache();
  resetGrokOAuthMemoryCache();
  clearXaiDiscoveredModels();
  clearXaiMediaModels();
}

/**
 * 启动期（splash）await 一次：加载远端目录写入 active-catalog。幂等 + 并发去重。
 * loadCatalog 永不抛（最差回落 bundled），故本函数也不会抛。
 * 调用点：bootstrap-electron 的 registerMakerIpcsAfterSplash，第一次 getMaker() 构造之前。
 */
export function ensureActiveCatalogLoaded(): Promise<Catalog> {
  // 接通自定义供应商密钥读取器（idempotent）：provider-route 用 setter 注入避免触电，
  // 这里在路由发生前（splash 早于任何 turn）把真实 safeStorage 读取接进去。
  setCustomProviderKeyReader(readCustomProviderKey);
  setProviderOAuthTokenReader((providerId, agent, options) => {
    if (providerId === 'xai') return readXaiProviderOAuthToken(options);
    // Codex and Pi processes do not carry Claude Code's native OAuth credential.
    // Their Anthropic bridges read the host-owned Claude.ai token and allow the
    // existing refresher to rotate it when needed.
    if (providerId === 'anthropic' && (agent === 'codex' || agent === 'pi')) {
      return getValidClaudeAiOAuth(options).then((oauth) => oauth?.accessToken ?? null);
    }
    return null;
  });
  // 测试连接探测与路由同源读 key（同 setter 模式，见 provider-diagnostics.ts）。
  setDiagnosticsKeyReader(readCustomProviderKey);
  // 通用 OAuth Runner 接线（idempotent）：safeStorage blob IO + 系统浏览器拉起;
  // 路由热路径的同步 token 读取（描述符现查目录,临期后台单飞刷新,不阻塞路由）。
  configureGenericOAuth({
    storage: genericOAuthSecretIo,
    openExternal: async (url) => {
      const { shell } = await import('electron');
      await shell.openExternal(url);
    },
  });
  // 账号切换清空本机密钥后,同步失效 generic-oauth 的内存缓存——
  // 不失效的话磁盘 blob 已删但缓存还热,B 账号会继续用 A 的 token 路由(串号)。
  addProviderSecretsClearedListener(handleProviderSecretsCleared);
  const readOAuthToken = (providerId: string): string | null => {
    const provider = getActiveCatalog().providers.find((p) => p.id === providerId);
    const storageProviderId =
      provider?.source === 'user' ? storedCustomProviderId(providerId) : providerId;
    return readCachedGenericOAuthAccessToken(storageProviderId, provider?.auth.oauth);
  };
  setOAuthTokenReader(readOAuthToken);
  setDiagnosticsOAuthTokenReader(readOAuthToken);
  // 在启动期固定 service 实例，避免请求路由热路径重复进入 getter 里的 legacy
  // owner 绑定迁移；每次 listProviders 仍会实时读取凭证连接态。
  const providerService = getDesktopProviderService();
  setProviderViewsReader(() =>
    providerService.listProviders({
      allowSideEffects: false,
      catalog: getActiveCatalog(),
    }),
  );
  if (activeLoaded) {
    // 幂等路径也重同步本地 override:手改文件 / 换 owner 后,任何经过这里的
    // 刷新触发都会带出新快照(store 内 mtime/路径守卫,未变零开销)。
    syncLocalCatalogOverridesIntoActiveCatalog();
    const activeCatalog = getActiveCatalog();
    logModelPlaneWarnings();
    return Promise.resolve(activeCatalog);
  }
  if (!activeInflight) {
    const source = buildSource();
    const sourceKey = catalogSourceKey(source);
    // 首次加载时顺手清掉旧版磁盘缓存孤儿（fire-and-forget，每进程一次）。
    void cleanupLegacyCatalogCache();
    let capabilityEvidence: CatalogCapabilityEvidence = 'fallback';
    let unverifiedXdMediaKinds: CatalogLoadResult['unverifiedXdMediaKinds'] = [
      'image',
      'video',
      'embedding',
    ];
    activeInflight = loadCatalog(source, io, (result) => {
      capabilityEvidence = result.capabilityEvidence;
      unverifiedXdMediaKinds = result.unverifiedXdMediaKinds;
    })
      .then(async (catalog) => {
        activeCatalogSourceKey = sourceKey;
        setActiveCatalog(catalog, { capabilityEvidence, unverifiedXdMediaKinds });
        syncLocalCatalogOverridesIntoActiveCatalog();
        getActiveCatalog();
        logModelPlaneWarnings();
        broadcastReferenceModelPricing();
        // 读 codex models_cache.json 得到规范化快照,由 active-catalog 同时投影到 Codex 与
        // Claude bridge。null 表示没读到有效 cache,保留现值 / 静态兜底;[] 表示合法空快照。
        try {
          const discovered = await readCodexDiscoveredModels();
          if (discovered !== null) setDiscoveredCodexModels(discovered);
        } catch {
          /* 读/映射失败:保持现值,不影响启动 */
        }
        // Anthropic 动态清单:同步加载磁盘缓存(上次成功结果,登录态 gate 在内部),
        // 让首次 maker 构建的 availableModels 派生就包含它;HTTP 刷新放后台,
        // 不阻塞 splash(失败保留现值,语义见 model-discovery/anthropic.ts)。
        await loadAnthropicModelsFromDiskCache();
        void refreshAnthropicModelsFromHttp();
        // xAI 账号成员同样先恢复当前 owner 的成功 LKG，再后台读官方账号清单。
        // 无 LKG / 刷新失败时 active-catalog 才继续使用 server Catalog → bundled 救急。
        await loadXaiModelsFromDiskCache();
        void refreshXaiModelsFromHttp();
        activeLoaded = true;
        return catalog;
      })
      .finally(() => {
        activeInflight = null;
      });
  }
  return activeInflight;
}

/**
 * Auth realm 激活后的整目录重载。若目标端点变化，先同步失效旧区域目录并回到
 * bundled，再异步加载目标区域；generation 保证快速 CN↔Global 切换时迟到响应
 * 不能覆盖最新区域。
 */
export function reloadActiveCatalogForEndpointChange(): Promise<Catalog> {
  if (!activeLoaded) {
    return ensureActiveCatalogLoaded().then(() => reloadActiveCatalogForEndpointChange());
  }

  // owner 切换与 endpoint/realm 切换可能同时发生；即使 URL 没变、下面直接早退，
  // 也必须先按新的 ownerScopedUserDataPath 换掉本地 override，不能让上一账号的
  // additions/patches 继续留在 active-catalog 内存层。
  syncLocalCatalogOverridesIntoActiveCatalog();

  const source = buildSource();
  const sourceKey = catalogSourceKey(source);
  if (endpointReloadInflight?.sourceKey === sourceKey) {
    return endpointReloadInflight.promise;
  }
  if (activeCatalogSourceKey === sourceKey && endpointReloadInflight === null) {
    return Promise.resolve(getActiveCatalog());
  }

  const generation = ++endpointReloadGeneration;
  activeCatalogSourceKey = null;
  // 必须在网络 await 前失效：登录提交后 renderer/agent 可能立即读取目录。
  setActiveCatalog(BUNDLED_CATALOG, { capabilityEvidence: 'fallback' });
  broadcastReferenceModelPricing();

  let capabilityEvidence: CatalogCapabilityEvidence = 'fallback';
  let unverifiedXdMediaKinds: CatalogLoadResult['unverifiedXdMediaKinds'] = [
    'image',
    'video',
    'embedding',
  ];
  const flight = loadCatalog(source, io, (result) => {
    capabilityEvidence = result.capabilityEvidence;
    unverifiedXdMediaKinds = result.unverifiedXdMediaKinds;
  })
    .then((catalog) => {
      if (
        endpointReloadGeneration !== generation ||
        catalogSourceKey(buildSource()) !== sourceKey
      ) {
        return getActiveCatalog();
      }
      activeCatalogSourceKey = sourceKey;
      setActiveCatalog(catalog, { capabilityEvidence, unverifiedXdMediaKinds });
      broadcastReferenceModelPricing();
      return getActiveCatalog();
    })
    .finally(() => {
      if (endpointReloadInflight?.promise === flight) {
        endpointReloadInflight = null;
      }
    });
  endpointReloadInflight = { sourceKey, promise: flight };
  return flight;
}

/**
 * 重载模型平面(xAI 双 root 静态清单 + 统一 modelRegistry)。先确保启动期动态发现
 * 已完成,再复用同一 `loadCatalogWithSource` 源选择;bundled fallback 视为失败保
 * LKG。守卫序:realm/generation → updatedAt 时间单调 → 同一时刻规范化 digest
 * (同=no-op,异=拒收+告警——线上纠错必须 forward-fix 抬 updatedAt)。通过后经
 * `commitActiveCatalogSnapshot` **单次 swap、单次 markChanged** 提交,成功且有
 * 变化 = 恰 1 revision/1 广播(出口只有 active-catalog changedListener),
 * fallback → current 会连同完整目录快照一起替换；精确 no-op/失败/拒收 = 0。
 */
export async function refreshActiveCatalogFromSource(): Promise<Catalog> {
  await ensureActiveCatalogLoaded();
  const sourceConfig = buildSource();
  // XDT_DISABLE_MODELS_FETCH=1 时这里根本不会发起请求,落到 bundled 是
  // 预期行为而非网络失败——用专用错误码如实返回,不让 renderer 误报成可重试的刷新失败。
  // XDT_MODELS_PATH 是纯本地源,不依赖远程拉取,不受 disableFetch 约束。
  if (sourceConfig.disableFetch && !sourceConfig.localPath) {
    throwIpcError(
      'MODEL_CATALOG_FETCH_DISABLED',
      '模型目录远程拉取未启用,本次未发起请求(若已设 XDT_DISABLE_MODELS_FETCH=1 请先移除)',
    );
  }
  const sourceKey = catalogSourceKey(sourceConfig);
  if (catalogRefreshInflight?.sourceKey === sourceKey) {
    return catalogRefreshInflight.promise;
  }
  const generation = endpointReloadGeneration;
  const flight = loadCatalogWithSource(sourceConfig, io)
    .then(({ catalog, source, capabilityEvidence, unverifiedXdMediaKinds }) => {
      if (source === 'bundled') {
        throw new Error('catalog refresh exhausted configured sources; keeping current snapshot');
      }
      if (
        endpointReloadGeneration !== generation ||
        activeCatalogSourceKey !== sourceKey ||
        catalogSourceKey(buildSource()) !== sourceKey
      ) {
        return getActiveCatalog();
      }
      const currentRegistry = getActiveCatalog().modelRegistry;
      const incomingRegistry = catalog.modelRegistry;
      if (currentRegistry && incomingRegistry) {
        const relation = compareModelRegistryRevisions(incomingRegistry, currentRegistry);
        if (relation === 'older') {
          // 旧版拒收，不 commit，零 revision 零广播。
          return getActiveCatalog();
        }
        if (relation === 'same') {
          // Registry 相同不代表 provider media / presets 等完整目录相同；无论本次
          // 选中 current 还是 fallback，都必须把完整快照与能力证据原子安装。
          // commitActiveCatalogSnapshot 会保留完整快照与证据均相同的精确 no-op。
          commitActiveCatalogSnapshot(catalog, {
            capabilityEvidence,
            unverifiedXdMediaKinds,
          });
          return getActiveCatalog();
        }
        if (relation === 'invalid-incoming') {
          log.warn('model registry updatedAt is invalid; rejecting', {
            incomingUpdatedAt: incomingRegistry.updatedAt,
            currentUpdatedAt: currentRegistry.updatedAt,
          });
          return getActiveCatalog();
        }
        if (relation === 'conflict') {
          // 同一 revision 异内容 = 非法重发:拒收保当前快照并告警(telemetry 走日志管道)。
          log.warn(
            'model registry republished the same revision with different content; rejecting',
            {
              incomingUpdatedAt: incomingRegistry.updatedAt,
              currentUpdatedAt: currentRegistry.updatedAt,
            },
          );
          return getActiveCatalog();
        }
      }
      commitActiveCatalogSnapshot(catalog, { capabilityEvidence, unverifiedXdMediaKinds });
      // computeMerged 在这里同步完成，确保告警属于刚提交的同一代目录；不能读取
      // 上一代惰性缓存留下的 warnings。
      const activeCatalog = getActiveCatalog();
      logModelPlaneWarnings();
      broadcastReferenceModelPricing();
      return activeCatalog;
    })
    .finally(() => {
      if (catalogRefreshInflight?.promise === flight) catalogRefreshInflight = null;
    });
  catalogRefreshInflight = { sourceKey, promise: flight };
  return flight;
}

/**
 * 把 owner-scoped 本地目录 override 快照同步进 active-catalog。mtime/路径守卫在
 * store 内(手改文件、换 owner 都会现读);内容未变时不触发 revision。
 * 调用点:启动装载、目录刷新、realm 重载——owner 切换后任一路径都会带出新快照。
 */
let lastSyncedOverridesJson: string | null = null;
let lastLoggedModelPlaneWarningsJson: string | null = null;

function logModelPlaneWarnings(): void {
  const warnings = getModelPlaneWarnings();
  if (warnings.length === 0) {
    lastLoggedModelPlaneWarningsJson = null;
    return;
  }
  const serialized = JSON.stringify(warnings);
  if (serialized === lastLoggedModelPlaneWarningsJson) return;
  lastLoggedModelPlaneWarningsJson = serialized;
  log.warn('model plane ignored inconsistent registry/local entries', {
    count: warnings.length,
    samples: warnings.slice(0, 5),
  });
}

export function syncLocalCatalogOverridesIntoActiveCatalog(): void {
  const overrides = readModelCatalogOverrides();
  const serialized = JSON.stringify(overrides);
  if (serialized === lastSyncedOverridesJson) return;
  lastSyncedOverridesJson = serialized;
  setLocalCatalogOverrides(overrides);
}

/**
 * 重读 codex models_cache.json 并刷新 catalog 里的规范化 Codex 模型快照。
 * 启动期 ensureActiveCatalogLoaded 只读一次,若当时 models_cache 尚不存在(codex 从未登录 /
 * 首次登录还没写缓存)或 codex 之后发现了新模型,discovered 列表会一直停在启动时的旧值直到
 * 重启 —— 因此 codex auth 变化(登录/登出/切模式)收口时调用本函数,再广播 provider 更新,
 * renderer refetch 即能看到最新清单。登出时由 authenticated=false 直接清空；登录边界
 * 读取失败 / cache 缺失时也清空动态快照，回到静态目录，避免继续暴露上一账号的模型。
 */
export async function refreshDiscoveredCodexModels(
  authenticated = true,
  shouldApply: () => boolean = () => true,
): Promise<void> {
  if (!authenticated) {
    if (shouldApply()) setDiscoveredCodexModels([]);
    return;
  }
  const discovered = await readCodexDiscoveredModelsForAuthRefresh();
  if (shouldApply()) setDiscoveredCodexModels(discovered);
}

/**
 * 把当前账号 localDb 里的自定义供应商配置展开成标准 Provider，注入 active-catalog。
 *
 * 调用时机：
 *   - DB ready / 换账号（bootstrap onReady(userId)，DB 文件按 user 切片，重开后内容随账号变）；
 *   - 自定义供应商 CRUD 之后（providerHandlers，刷新 active-catalog 让路由 / 列表 / 选择器即时反映）。
 *
 * best-effort：localDb 未就绪 / 读失败时清空 custom（不抛），不影响内置供应商与路由默认行为。
 */
export async function refreshCustomProvidersIntoCatalog(
  shouldApply: () => boolean = () => true,
): Promise<void> {
  try {
    const configs = await listCustomProvidersWithSecureHeaders();
    if (!shouldApply()) {
      log.info('discarded stale custom provider catalog refresh');
      return;
    }
    setCustomProviderConfigs(configs);
    log.info('custom providers merged into active catalog', { count: configs.length });
  } catch (err) {
    if (!shouldApply()) {
      log.info('discarded stale custom provider catalog refresh failure', {
        err: String(err),
      });
      return;
    }
    setCustomProviders([]);
    log.warn('failed to load custom providers; cleared current owner catalog snapshot', {
      err: String(err),
    });
  }
}

/**
 * 连接态读取路径上的原生 Harness 绑定自愈。
 *
 * 写失败绝不抛穿:connection 回调服务于 listProviders,抛出会让整份供应商列表取不到,
 * 比「这一次没认领上」严重得多 —— 下一次读取还会再试。Codex 的同款自愈挂在异步
 * reconcile 收口(见 auth-adapters.claimDetectedCodexOAuthBinding),因为它的凭证是
 * 惰性物化的；Claude 凭证同步可读，在读连接态时就地认领即可。
 */
async function claimNativeProviderAuthOnRead(
  provider: 'anthropic',
  hasCredential: () => boolean,
  onClaimed?: () => void | Promise<void>,
  waitForClaimed = false,
): Promise<void> {
  try {
    if (!claimDetectedNativeProviderAuth(provider, hasCredential)) return;
    log.info('native provider credential auto-bound to current owner', { provider });
    const ownerAtClaim = getActiveAppSession();
    const notifyIfClaimStillCurrent = () => {
      const current = getActiveAppSession();
      if (
        current.generation !== ownerAtClaim.generation ||
        current.dataOwnerId !== ownerAtClaim.dataOwnerId
      ) {
        log.info('native provider claim broadcast skipped after owner change', {
          provider,
          claimedGeneration: ownerAtClaim.generation,
          currentGeneration: current.generation,
        });
        return;
      }
      notifyNativeProviderClaimed();
    };
    const claimedWork = onClaimed?.();
    if (waitForClaimed) {
      await claimedWork;
      // 认领成功 = 这家供应商刚从「未连接」翻成「已连接」,但只有触发这次读取的那个调用方
      // 拿到了新快照。其它窗口会一直留着 connected:false;配对的手机 / 控制端更是只认
      // maker:provider:changed 这一条推送来失效缓存,不广播就永远停在旧快照
      // (PR #548 review)。显式登录 / 登出路径本来就会广播,自愈这条同样得补上。
      notifyIfClaimStillCurrent();
      return;
    }
    if (claimedWork) {
      // 连接态已经在本次读里从 false 翻成 true，必须立即广播；媒体／模型发现可以继续
      // 在后台跑，成功时 active-catalog revision 会再广播清单变化。不能让慢上游把
      // “已连接”本身拖到超时以后才出现在其它窗口。
      notifyIfClaimStillCurrent();
      void Promise.resolve(claimedWork).catch((err) => {
        log.warn('native provider post-claim work failed', { provider, error: String(err) });
      });
      return;
    }
    // 认领成功 = 这家供应商刚从「未连接」翻成「已连接」,但只有触发这次读取的那个调用方
    // 拿到了新快照。其它窗口会一直留着 connected:false;配对的手机 / 控制端更是只认
    // maker:provider:changed 这一条推送来失效缓存,不广播就永远停在旧快照
    // (PR #548 review)。显式登录 / 登出路径本来就会广播,自愈这条同样得补上。
    notifyIfClaimStillCurrent();
  } catch (err) {
    log.warn('native provider auth binding claim failed', { provider, error: String(err) });
  }
}

/**
 * 首个 Anthropic 绑定认领后的目录补拉共用同一趟 flight。
 * 普通 provider 读取只启动后台补拉并保留低延迟/LKG；scheduler 与 Orca 等明确要求
 * post-claim routing snapshot 的调用方通过 waitForDiscovery 共等这趟 flight。
 */
let anthropicClaimDiscoveryInflight: Promise<void> | null = null;

function refreshAnthropicCatalogAfterClaim(): Promise<void> {
  if (anthropicClaimDiscoveryInflight) return anthropicClaimDiscoveryInflight;

  const flight = (async () => {
    // 启动期两条加载都可能因尚未绑定而早退。先恢复最后一次成功的磁盘清单，再刷新
    // HTTP；任一失败都保留已有目录，不把连接态读取整条打穿。
    await loadAnthropicModelsFromDiskCache().catch(() => undefined);
    await refreshAnthropicModelsFromHttp().catch(() => false);
  })();
  anthropicClaimDiscoveryInflight = flight;
  const clear = () => {
    if (anthropicClaimDiscoveryInflight === flight) {
      anthropicClaimDiscoveryInflight = null;
    }
  };
  void flight.then(clear, clear);
  return flight;
}

let nativeProviderClaimListener: (() => void) | null = null;

/**
 * 注册「绑定自愈成功」的收口（desktop host 装配时接 PROVIDER_CHANGED 广播；传 null 解绑）。
 * 监听器不可抛——广播失败不该反过来把这次认领算作失败。
 */
export function setNativeProviderClaimListener(listener: (() => void) | null): void {
  nativeProviderClaimListener = listener;
}

function notifyNativeProviderClaimed(): void {
  try {
    nativeProviderClaimListener?.();
  } catch (err) {
    log.warn('native provider claim broadcast failed', { error: String(err) });
  }
}

let singleton: ProviderService | null = null;

/**
 * User-selectable desktop catalog. Account-free local sessions do not receive
 * the Cindy AI provider or any models whose only source is Cindy AI; every
 * Cindy account session keeps the full active catalog.
 */
export function getDesktopSelectableCatalog(): Catalog {
  return filterProviderCatalogForAccount(getActiveCatalog(), {
    canUseCindyGateway: getAppCapabilities().canUseCindyGateway,
  });
}

/** 进程内单例：注入 active-catalog（同步读）+ 实时连接状态读取器。 */
export function getDesktopProviderService(): ProviderService {
  const authState = getAuthState();
  const ownerId = getActiveAppSession().dataOwnerId;
  if (
    authState.mode === 'cloud' &&
    ownerId &&
    authState.user?.id === ownerId &&
    hasLegacyOwnerNamespaceClaim(ownerId)
  ) {
    migrateLegacyNativeProviderAuthBindings(ownerId, {
      anthropic: hasClaudeAiOAuthUnbound(),
      openai: desktopCodexAuthAdapter.hasCodexOAuthLoginUnbound(),
      // 这是升级迁移，不是 CLI 自动发现：旧 xAI blob 只可能由 Cindy OAuth 写入，
      // nativeProviderAuthBinding 会把它记为 explicit-provider-oauth。
      xai: getProviderSecretStore().has('xai'),
    });
  }
  if (singleton) return singleton;
  singleton = createProviderService({
    getCatalog: getDesktopSelectableCatalog,
    connection: {
      xd: () => getAppCapabilities().canUseCindyGateway && readClaudeApiKey() != null,
      // Claude/Codex 是原生 Harness，可继承本机 CLI 凭证；xAI 是下游 provider，
      // 只能读取已经由 Cindy OAuth 明确绑定的 token，禁止在连接态读取时自动认领。
      anthropic: async ({ allowSideEffects, waitForDiscovery }) => {
        // 自愈会写绑定文件、读凭证作用域缓存并发起带凭证的上游请求。listProviders 这条通道
        // 同时服务 device-link 与可能不受信的渲染上下文,所以副作用只在本机主页面发起时
        // 才放行,其余降级为纯读(PR #548 review)。
        if (!allowSideEffects) return hasClaudeAiOAuth();
        await claimNativeProviderAuthOnRead(
          'anthropic',
          hasClaudeAiOAuthUnbound,
          () => {
            // anthropic 的 live entitlement 证据只来自动态发现，而发现只在启动期与
            // 显式 OAuth 登录成功时触发。绑定是在这两个时机之后才建立的，启动期那次
            // 早被登录态 gate 掉——不在认领成功时补拉，目录虽可能有 Registry presence，
            // 运行时仍缺少当前账号的可用性证据。
            //
            // 磁盘缓存要先补:启动期的 loadAnthropicModelsFromDiskCache 同样因当时未绑定而
            // 早退了。先把上次成功的清单摆出来,再去拉最新的 —— 否则这次 HTTP 一旦超时或
            // 失败,明明有可用的缓存清单,用户还是一个模型都选不了(PR #548 review)。
            return refreshAnthropicCatalogAfterClaim();
          },
          waitForDiscovery === true,
        );
        // 认领者写完绑定后、目录补拉完成前，并发读取会走「已经绑定」分支。它们也必须
        // 等同一趟补拉，才能让随后求值的 lazy catalog 与连接态属于同一个新快照。
        if (waitForDiscovery === true && anthropicClaimDiscoveryInflight) {
          await anthropicClaimDiscoveryInflight;
        }
        return hasClaudeAiOAuth();
      },
      // openai 的自愈挂在 adapter 的 reconcile 收口里(#294 既有形态),这里同样要受开关约束:
      // hasCodexOAuthLogin() 经 getAccessToken 触发 reconcileWithSystemCodex,它会把本机 CLI
      // 凭证硬链进 codex-home 并为首个 owner 补写绑定 —— 判据不是「有没有发上游请求」,而是
      // 「不受信 sender 能不能引发特权状态变更」,建硬链和写绑定都在其内(PR #548 review)。
      openai: ({ allowSideEffects }) =>
        allowSideEffects
          ? desktopCodexAuthAdapter.hasCodexOAuthLogin()
          : desktopCodexAuthAdapter.hasCodexOAuthLoginReadOnly(),
      // xAI is a downstream provider, not a native Harness. Its connection state
      // only reflects a Cindy OAuth binding (or the explicit legacy migration above);
      // reading the provider list must never auto-claim an arbitrary local token.
      xai: () => hasGrokOAuthLogin(),
    },
    // 通用 OAuth 供应商（目录 auth.oauth 描述符驱动）：连接态 = 本机凭证 blob 是否存在。
    genericOAuthConnected: (providerId) => hasGenericOAuthLogin(storedCustomProviderId(providerId)),
    // 内置 API-key 供应商(如 gemini 图像来源):连接态 = key 已存(providerSecretStore)。
    builtinApiKeyConnected: (providerId) =>
      providerId === 'gemini' ? Boolean(getProviderSecretStore().get('gemini')?.trim()) : false,
    // 动态发现失败归因：目前只有 anthropic 的 live entitlement 证据依赖这条通道。
    // 即使 Registry presence 仍能展示目录，UI 也要说明当前账号验证失败，而不是一直
    // 说「正在发现」。
    //
    // 连接态直接沿用本次快照已经算好的那个：它内部要读凭证库，macOS 上每读一次就是一个
    // 同步的 `security` 子进程，同一次 listProviders 不该为此阻塞主线程两回（PR #548 review）。
    modelDiscoveryFailure: (providerId, connected) =>
      providerId === 'anthropic' ? getAnthropicModelDiscoveryFailure(connected) : null,
    // 「模型 / 供应商停用」override:main 侧持久化真源,烘焙进 ProviderView 后
    // renderer / IM / Orca / device-link 全部消费同一份准入事实。
    getModelAccess: readModelDisableOverrides,
  });
  return singleton;
}

export const __testing = {
  catalogLkgEnvelope,
  catalogLkgPath,
  catalogLkgTemporaryPath,
  readCatalogLkg,
  replaceCatalogLkgFile,
  readXaiProviderOAuthToken,
  selectCatalogLkgSnapshot,
  serializeCatalogLkgWrite,
  writeCatalogLkg,
};
