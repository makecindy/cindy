/**
 * createDesktopProviderService —— 桌面端目录加载落地 + provider-service 接线。
 *
 * 两块职责：
 *   1. 目录加载器 `ensureActiveCatalogLoaded`：用 electron net.request 拉公共 Catalog、node fs 读 dev
 *      本地文件，把结果写进 active-catalog 单例（getActiveCatalog 同步读）。
 *        - release：优先从区域化 Model Access 公共接口加载，失败时回退旧 OSS 目录。
 *        - dev：关闭联网（与 manifestService 一致），可由 XDT_MODELS_PATH 指向本地文件即时生效。
 *        - env 兜底：XDT_MODELS_URL（完整覆盖 URL）/ XDT_DISABLE_MODELS_FETCH（强制不联网）。
 *      **每进程拉一次、存内存、无 TTL、无磁盘缓存**：远端目录是运行时真源，bundled 是最终兜底。
 *      启动期（splash）由 bootstrap-electron 在构造 Maker 前 await 一次（见 registerMakerIpcsAfterSplash）。
 *   2. `getDesktopProviderService`：把 active-catalog + 连接状态读取器注入 provider-service。
 *      连接状态直接复用现有凭证存储——XD = 托管 gateway key 是否存在、
 *      Anthropic = 系统 Claude.ai OAuth 是否登录、OpenAI = Codex 是否 OAuth 登录。
 *      与设置页现有 auth 流程同源，不另立通道。
 */

import { app, net } from 'electron';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import {
  BUNDLED_CATALOG,
  buildUserProvider,
  DEFAULT_REMOTE_CATALOG_BUDGET_MS,
  loadCatalog,
  loadCatalogWithSource,
  type Catalog,
  type CatalogIO,
  type CatalogSourceConfig,
} from '@cindy/model-providers';

import { createLogger } from '../logger.js';
import { getBaseUrl, isDev } from '../manifestService.js';
import { getBuildClientEndpoint, getClientEndpoint } from '../clientEndpointsService.js';
import {
  getActiveCatalog,
  setActiveCatalog,
  setCustomProviders,
  setDiscoveredCodexModels,
  setProviderModelsFromCatalog,
} from './active-catalog.js';
import {
  readCodexDiscoveredModels,
  readCodexDiscoveredModelsForAuthRefresh,
} from './codex-model-discovery.js';
import {
  getAnthropicModelDiscoveryFailure,
  loadAnthropicModelsFromDiskCache,
  refreshAnthropicModelsFromHttp,
} from './model-discovery/anthropic.js';
import { createProviderService, type ProviderService } from './provider-service.js';
import { readModelDisableOverrides } from './model-disable-store.js';
import { listCustomProviders } from './custom-provider-store.js';
import { setCustomProviderKeyReader, setOAuthTokenReader, setProviderOAuthTokenReader } from './provider-route.js';
import { setDiagnosticsKeyReader, setDiagnosticsOAuthTokenReader } from './provider-diagnostics.js';
import {
  configureGenericOAuth,
  hasGenericOAuthLogin,
  readCachedGenericOAuthAccessToken,
  resetGenericOAuthMemoryCache,
} from './generic-oauth.js';
import { genericOAuthSecretIo, addProviderSecretsClearedListener } from '../secrets/providerSecretStore.js';
import { readClaudeApiKey, desktopCodexAuthAdapter } from './auth-adapters.js';
import { readCustomProviderKey } from '../secrets/providerSecretStore.js';
import { hasClaudeAiOAuth, hasClaudeAiOAuthUnbound } from './claude-credentials-store.js';
import {
  getGrokAccessToken,
  hasGrokOAuthLogin,
  hasGrokOAuthLoginUnbound,
  resetGrokOAuthMemoryCache,
} from './grok-oauth-login.js';
import { getAuthState } from '../authManager.js';
import { getActiveAppSession } from '../appSessionState.js';
import {
  filterProviderCatalogForAccount,
  projectProviderCatalogForBuildRegion,
} from './provider-access-policy.js';
import { getAppCapabilities } from '../appCapabilities.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import {
  claimDetectedNativeProviderAuth,
  migrateLegacyNativeProviderAuthBindings,
} from './nativeProviderAuthBinding.js';
import { hasLegacyOwnerNamespaceClaim } from '../ownerNamespaceMigration.js';

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

/** 桌面端 CatalogIO —— net + fs 落地（无磁盘缓存：目录每进程拉一次存内存，无需落盘）。 */
const io: CatalogIO = {
  fetchText,
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
 * 构建目录源配置。release 使用区域化 Model Access 公共接口，旧 OSS 保留为迁移期回退；dev 不联网。
 *
 * 会话切到另一 auth realm 时，Model Access 公共接口随 active endpoint 改变并触发整份目录
 * 重载。旧 OSS 只属于安装包区域，因此仅同区加载允许使用；跨区主源失败时直接退化 bundled，
 * 绝不把安装区域的 provider/routing 目录冒充成组织区域目录。
 */
function buildSource(): CatalogSourceConfig {
  const dev = isDev();
  const baseUrl = dev ? undefined : getClientEndpoint('modelAccessApiBaseUrl');
  const usesBuildRealm = !dev && baseUrl === getBuildClientEndpoint('modelAccessApiBaseUrl');
  return {
    url: process.env.XDT_MODELS_URL,
    localPath: process.env.XDT_MODELS_PATH,
    baseUrl,
    fallbackBaseUrl: dev || !usesBuildRealm ? undefined : getBaseUrl(),
    remoteBudgetMs: DEFAULT_REMOTE_CATALOG_BUDGET_MS,
    disableFetch: dev || process.env.XDT_DISABLE_MODELS_FETCH === '1',
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
 * 一次性清理旧版本遗留的目录磁盘缓存（provider-catalog-cache.json + .tmp）。
 * 现版本目录每进程拉一次存内存、不落盘，这两个文件不再被读写，纯属历史孤儿。
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
let catalogRefreshInflight: Promise<Catalog> | null = null;
let activeCatalogSourceKey: string | null = null;
let endpointReloadGeneration = 0;
let endpointReloadInflight: {
  sourceKey: string;
  promise: Promise<Catalog>;
} | null = null;

/**
 * 启动期（splash）await 一次：加载远端目录写入 active-catalog。幂等 + 并发去重。
 * loadCatalog 永不抛（最差回落 bundled），故本函数也不会抛。
 * 调用点：bootstrap-electron 的 registerMakerIpcsAfterSplash，第一次 getMaker() 构造之前。
 */
export function ensureActiveCatalogLoaded(): Promise<Catalog> {
  // 接通自定义供应商密钥读取器（idempotent）：provider-route 用 setter 注入避免触电，
  // 这里在路由发生前（splash 早于任何 turn）把真实 safeStorage 读取接进去。
  setCustomProviderKeyReader(readCustomProviderKey);
  setProviderOAuthTokenReader((providerId) => (providerId === 'xai' ? getGrokAccessToken() : null));
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
  addProviderSecretsClearedListener(() => {
    resetGenericOAuthMemoryCache();
    resetGrokOAuthMemoryCache();
  });
  const readOAuthToken = (providerId: string): string | null => {
    const provider = getActiveCatalog().providers.find((p) => p.id === providerId);
    return readCachedGenericOAuthAccessToken(providerId, provider?.auth.oauth);
  };
  setOAuthTokenReader(readOAuthToken);
  setDiagnosticsOAuthTokenReader(readOAuthToken);
  if (activeLoaded) return Promise.resolve(getActiveCatalog());
  if (!activeInflight) {
    const source = buildSource();
    const sourceKey = catalogSourceKey(source);
    // 首次加载时顺手清掉旧版磁盘缓存孤儿（fire-and-forget，每进程一次）。
    void cleanupLegacyCatalogCache();
    activeInflight = loadCatalog(source, io)
      .then(async (catalog) => {
        activeCatalogSourceKey = sourceKey;
        setActiveCatalog(catalog);
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
  setActiveCatalog(BUNDLED_CATALOG);

  const flight = loadCatalog(source, io)
    .then((catalog) => {
      if (
        endpointReloadGeneration !== generation ||
        catalogSourceKey(buildSource()) !== sourceKey
      ) {
        return getActiveCatalog();
      }
      activeCatalogSourceKey = sourceKey;
      setActiveCatalog(catalog);
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
 * 手动重载 xAI 模型目录。先确保启动期动态发现已完成，再复用同一 `loadCatalog`
 * 源选择与 bundled fallback；只投影 xAI 的静态模型列表，当前 routing/auth 以及其它
 * provider 全部保持不变，避免活跃 turn 中途被整份远端目录切换路由。
 */
export async function refreshActiveCatalogFromSource(): Promise<Catalog> {
  await ensureActiveCatalogLoaded();
  if (catalogRefreshInflight) return catalogRefreshInflight;
  const flight = loadCatalogWithSource(buildSource(), io)
    .then(({ catalog, source }) => {
      if (source === 'bundled') {
        throw new Error('catalog refresh exhausted configured sources; keeping current snapshot');
      }
      setProviderModelsFromCatalog('xai', catalog);
      return getActiveCatalog();
    })
    .finally(() => {
      if (catalogRefreshInflight === flight) catalogRefreshInflight = null;
    });
  catalogRefreshInflight = flight;
  return flight;
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
export async function refreshCustomProvidersIntoCatalog(): Promise<void> {
  try {
    const configs = await listCustomProviders();
    setCustomProviders(configs.map((c) => buildUserProvider(c)));
    log.info('custom providers merged into active catalog', { count: configs.length });
  } catch (err) {
    log.warn('failed to load custom providers; keeping last valid active catalog snapshot', {
      err: String(err),
    });
  }
}

/**
 * 连接态读取路径上的绑定自愈(同步凭证的两家:anthropic / xai)。
 *
 * 写失败绝不抛穿:connection 回调服务于 listProviders,抛出会让整份供应商列表取不到,
 * 比「这一次没认领上」严重得多 —— 下一次读取还会再试。Codex 的同款自愈挂在异步
 * reconcile 收口(见 auth-adapters.claimDetectedCodexOAuthBinding),因为它的凭证是
 * 惰性物化的;这两家的凭证同步可读,在读连接态时就地认领即可。
 */
function claimNativeProviderAuthOnRead(
  provider: 'anthropic' | 'xai',
  hasCredential: () => boolean,
  onClaimed?: () => void,
): void {
  try {
    if (!claimDetectedNativeProviderAuth(provider, hasCredential)) return;
    log.info('native provider credential auto-bound to current owner', { provider });
    onClaimed?.();
    // 认领成功 = 这家供应商刚从「未连接」翻成「已连接」,但只有触发这次读取的那个调用方
    // 拿到了新快照。其它窗口会一直留着 connected:false;配对的手机 / 控制端更是只认
    // maker:provider:changed 这一条推送来失效缓存,不广播就永远停在旧快照
    // (PR #548 review)。显式登录 / 登出路径本来就会广播,自愈这条同样得补上。
    notifyNativeProviderClaimed();
  } catch (err) {
    log.warn('native provider auth binding claim failed', { provider, error: String(err) });
  }
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
  const regionCatalog = projectProviderCatalogForBuildRegion(
    getActiveCatalog(),
    CURRENT_CINDY_REGION,
  );
  return filterProviderCatalogForAccount(regionCatalog, {
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
      xai: hasGrokOAuthLoginUnbound(),
    });
  }
  if (singleton) return singleton;
  singleton = createProviderService({
    getCatalog: getDesktopSelectableCatalog,
    connection: {
      xd: () => getAppCapabilities().canUseCindyGateway && readClaudeApiKey() != null,
      // 三家 native provider 统一口径:先跑一次绑定自愈,再读「绑定 + 凭证」的连接态。
      // hasClaudeAiOAuth / hasCodexOAuthLogin / hasGrokOAuthLogin 内部都已校验绑定,
      // 所以这里不再前置 isNativeProviderAuthBound —— 前置短路是纯冗余,而且会把
      // listProviders 挡在自愈之前,正是「设置页已连接 / 聊天无来源」假报的成因(#294)。
      anthropic: ({ allowSideEffects }) => {
        // 自愈会写绑定文件、读凭证作用域缓存并发起带凭证的上游请求。listProviders 这条通道
        // 同时服务 device-link 与可能不受信的渲染上下文,所以副作用只在本机主页面发起时
        // 才放行,其余降级为纯读(PR #548 review)。
        if (!allowSideEffects) return hasClaudeAiOAuth();
        claimNativeProviderAuthOnRead('anthropic', hasClaudeAiOAuthUnbound, () => {
          // anthropic 清单的唯一来源是动态发现,而发现只在启动期与显式 OAuth 登录成功
          // 时触发。绑定是在这两个时机之后才建立的,启动期那次早被登录态 gate 掉 ——
          // 不在认领成功时补拉一次,供应商会停在「已连接 + 零模型」直到下次重启。
          //
          // 磁盘缓存要先补:启动期的 loadAnthropicModelsFromDiskCache 同样因当时未绑定而
          // 早退了。先把上次成功的清单摆出来,再去拉最新的 —— 否则这次 HTTP 一旦超时或
          // 失败,明明有可用的缓存清单,用户还是一个模型都选不了(PR #548 review)。
          void loadAnthropicModelsFromDiskCache()
            .catch(() => undefined)
            .finally(() => {
              void refreshAnthropicModelsFromHttp();
            });
        });
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
      xai: ({ allowSideEffects }) => {
        if (allowSideEffects) claimNativeProviderAuthOnRead('xai', hasGrokOAuthLoginUnbound);
        return hasGrokOAuthLogin();
      },
    },
    // 通用 OAuth 供应商（目录 auth.oauth 描述符驱动）：连接态 = 本机凭证 blob 是否存在。
    genericOAuthConnected: (providerId) => hasGenericOAuthLogin(providerId),
    // 动态清单发现的失败归因：目前只有 anthropic 是「清单唯一来源是动态发现」的供应商，
    // 拉不到就是零模型 —— UI 要据此讲明失败理由，而不是一直说「正在发现」。
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
