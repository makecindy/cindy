/**
 * provider-service —— 把当前生效目录与连接状态合成「供应商视图」。
 *
 * 职责（host 侧）：
 *   1. 从注入的 `getCatalog()` 取当前生效目录（桌面端注入 active-catalog 的 getActiveCatalog，
 *      该目录由 splash 期 `ensureActiveCatalogLoaded` 拉取一次后存内存：OSS 优先 / bundled 兜底）。
 *   2. 注入「各供应商是否已连接」的判定（XD: api_key 是否存在 / Anthropic: claude.ai
 *      是否有 OAuth / OpenAI: codex 是否 OAuth 登录），合成 ProviderView[]。
 *
 * **本模块是纯编排**：目录读取与连接判定都由调用方注入（见 createDesktopProviderService
 * 的接线），因此可脱离 Electron 单测。目录不在此缓存、不设 TTL——每进程一次的加载语义由
 * active-catalog 统一持有；连接状态每次实时读（凭证变化要立即反映）。
 */

import type { ProviderPickerModel } from '@cindy/device-link';
import { createLogger } from '../logger.js';
import { mediaErrorForLog } from '../cindy-media/mediaRequestLog.js';

import {
  buildRegistry,
  type Catalog,
  type ConnectionState,
  type ModelDisableOverrides,
  type ModelDiscoveryFailureState,
  type ProviderModelDiscoveryFailure,
  type ProviderView,
  type Provider,
  isCustomRoutedProvider,
  isProviderDisabled,
  isCindyDistributedProvider,
  isCindyAutoModelId,
  type AgentKind,
} from '@cindy/model-providers';

const log = createLogger('provider-service');

interface SubscriptionConnectionOptions {
  /** Derived from a host-provided full catalog for existing bound task routes. */
  includeBoundAccounts?: boolean;
}

/**
 * 读取连接态时是否允许附带**本机副作用**（绑定自愈、随之而来的清单拉取）。
 *
 * 纯读取一律安全，但自愈会写绑定文件、读凭证作用域缓存并发起带凭证的上游请求。这条
 * 通道（`maker:provider:list`）同时服务于 device-link 与可能不受信的渲染上下文，所以副作用
 * 只在调用方明确是「本机主页面」时才放行；其余一律降级为纯读（PR #548 review）。
 */
export interface ConnectionReadOptions extends SubscriptionConnectionOptions {
  allowSideEffects: boolean;
  /** Host-only snapshot read: never refresh CLI status or load account presentation. */
  snapshotOnly?: boolean;
  /**
   * Wait for post-claim model discovery before materializing this snapshot.
   * This is an internal readiness hint for routing callers; ordinary provider reads
   * intentionally keep the low-latency/LKG behavior even when side effects are allowed.
   */
  waitForDiscovery?: boolean;
  /** This picker already refreshed its own subscription pools. */
  pickerPoolsReady?: boolean;
}

export interface ProviderListOptions extends ConnectionReadOptions {
  /** Attach cached subscription models for the local UI beside the current routing view. */
  includeSubscriptionDisplayModels?: boolean;
  /** Same-account remote picker. Full management and routing callers leave this unset. */
  picker?: {
    scope: 'available' | ProviderPickerModel;
    describe?: (providerOrder: string[], deferredProviderIds: string[]) => void;
  };
  /**
   * Internal catalog override for policy consumers that need the routing truth
   * rather than the user-selectable projection. Never sourced from IPC input.
   */
  catalog?: Catalog;
  /**
   * Internal lazy full-catalog override. Policy callers use this when an allowed connection read
   * may claim credentials and refresh dynamic models before the provider view is materialized.
   * Evaluated after every async connection reader settles; never sourced from IPC input.
   */
  getCatalog?: () => Catalog;
}

/** 内置三家供应商「是否已连接」的判定器（由 host 注入，读各自凭证存储）。 */
export interface ProviderConnectionReaders {
  /** XD 网关：托管 api_key 是否存在。 */
  xd: (opts: ConnectionReadOptions) => boolean | Promise<boolean>;
  /** Anthropic：内置 Claude Code CLI 是否已登录且 Cindy 获准使用。 */
  anthropic: (opts: ConnectionReadOptions) => boolean | Promise<boolean>;
  /** OpenAI：Codex 是否 OAuth 登录。 */
  openai: (opts: ConnectionReadOptions) => boolean | Promise<boolean>;
  /** xAI：SuperGrok OAuth 是否登录(responses-bridge 直连 api.x.ai)。 */
  xai: (opts: ConnectionReadOptions) => boolean | Promise<boolean>;
}

export interface ProviderServiceDeps {
  /** Read once per view; exact agent/provider/model keys, never written into the catalog. */
  getModelContextLimits?: () => Readonly<Record<string, number>>;
  projectProvider?: (provider: ProviderView) => ProviderView;
  /** Organization branding only; local name/removal preferences must not leak into managed providers. */
  getOrganizationProviderLogoKind?: (provider: ProviderView) => ProviderView['logoKind'];
  getProviderPresentation?: (providerId: string) => { name?: string; removed?: boolean; logoKind?: ProviderView['logoKind'] };
  /** Exact-route user budget/price overrides keep independent rows. */
  hasModelAliasOverride?: (providerId: string, agent: AgentKind, modelId: string) => boolean;
  /** 返回当前生效目录（同步）。桌面端注入 active-catalog 的 getActiveCatalog。 */
  getCatalog: () => Catalog;
  /** Live membership precedes access overrides. Explicit/lazy routing reads retain history-only models. */
  projectCatalog?: (catalog: Catalog, routingCatalog: boolean, include?: (provider: Provider) => boolean, includeLastConfirmed?: boolean) => Catalog;
  refreshPickerPools?: (providers: readonly Provider[]) => Promise<void>;
  /** 连接状态判定器。 */
  connection: ProviderConnectionReaders;
  /**
   * 通用 OAuth 供应商（目录 auth.oauth 描述符驱动、非内置 bespoke 四家）的连接态判定
   * （生产 = generic-oauth 的 hasGenericOAuthLogin）。缺省 = 一律未连接。
   */
  genericOAuthConnected?: (providerId: string) => boolean;
  codexAccountConnected?: (providerId: string, options?: SubscriptionConnectionOptions) => boolean;
  /** A provider Cindy created for subscription accounts: one of its own accounts is signed in. */
  subscriptionPoolConnected?: (providerId: string, options?: SubscriptionConnectionOptions) => boolean;
  subscriptionAccountConnected?: (providerId: string) => boolean;
  subscriptionReadUnavailable?: (providerId: string) => boolean;
  subscriptionReadUnreachable?: (providerId: string) => boolean;
  subscriptionModelsConfirmedAt?: (providerId: string) => number | undefined;
  subscriptionAccountInfo?: (providerId: string) => Promise<ProviderView['subscriptionAccount']>;
  openAiAccountInfo?: (providerId: string) => Promise<ProviderView['openAiAccount']>;
  /**
   * 内置 API-key 供应商(auth.method 'apiKey' 且 source 'builtin',如 Gemini 图像来源,
   * 2026-07)的连接态判定:连接 = 该供应商的 key 已存(生产 = providerSecretStore.has)。
   * 缺省 = 一律未连接。
   */
  builtinApiKeyConnected?: (providerId: string) => boolean;
  /** Saved custom configuration is not evidence that its credential still exists. */
  customApiKeyConnected?: (provider: Provider) => boolean;
  /** Runtime-owned media readiness, not inferred from chat authentication. */
  getAvailableMediaModels?: () => readonly { providerId: string; id: string }[];
  /**
   * 动态清单发现的最近一次失败（生产 = anthropic 的 getAnthropicModelDiscoveryFailure）。
   * 只有「清单唯一来源是动态发现」的供应商需要，缺席 = 该供应商没有这种失败态。
   *
   * `connected` 是本次快照刚算出的连接态，直接传下去供实现复用：这些判定往往要读凭证库
   * （macOS 上是一次同步的 Keychain 子进程），同一次 listProviders 里不该读第二遍。
   */
  modelDiscoveryFailure?: (
    providerId: string,
    connected: boolean,
  ) => ProviderModelDiscoveryFailure | null;
  /**
   * 「模型 / 供应商停用」override(生产 = model-disable-store 的 readModelDisableOverrides)。
   * buildRegistry 据此烘焙 ProviderView.suspended 与 CatalogModel.disabled,让所有
   * 消费方(renderer / IM / Orca 路由 / device-link)拿到同一份准入事实。缺省 = 全启用。
   */
  getModelAccess?: () => ModelDisableOverrides;
}

export interface ProviderService {
  /**
   * 当前供应商视图（含实时连接状态）。
   *
   * `allowSideEffects` 缺省为 false —— 副作用要显式请求，默认值必须是安全的那一侧：漏传
   * 只会少做一次自愈，传反了则是把特权变更敞给不受信的调用方。
   *
   * 判据不是「调用得频不频繁」，而是**这次读取由谁驱动**：
   *   · 主进程自己的业务逻辑（IM、scheduler、hook-control、title、Orca 路由…）跑在本机
   *     owner 的授权下，自愈只会把本机凭证绑给当前 owner —— 显式传 true，否则这些入口会
   *     重新出现「凭证在场却从未认领 / 清单从不刷新」（PR #548 review）。
   *   · 跨进程边界进来的（renderer IPC、device-link 合成 event）按 sender 可信度决定，
   *     见 providerHandlers 的 isTrustedSender。
   */
  listProviders(opts?: Partial<ProviderListOptions>): Promise<ProviderView[]>;
}

/**
 * 创建供应商服务。目录每次从 `getCatalog()` 现读（active-catalog 已持有进程级单例，零额外 IO）；
 * 连接状态每次实时读（凭证变化要立即反映）。
 */
export function createProviderService(deps: ProviderServiceDeps): ProviderService {
  async function listProviders(opts?: Partial<ProviderListOptions>): Promise<ProviderView[]> {
    const routingCatalog = Boolean(opts?.getCatalog || opts?.catalog);
    const subscriptionOptions = routingCatalog ? { includeBoundAccounts: true } : undefined;
    const readOpts: ConnectionReadOptions = {
      allowSideEffects: opts?.allowSideEffects === true && opts?.snapshotOnly !== true,
      snapshotOnly: opts?.snapshotOnly === true,
      waitForDiscovery: opts?.waitForDiscovery === true,
      ...subscriptionOptions,
    };
    const picker = opts?.picker;
    const access = picker ? deps.getModelAccess?.() : undefined;
    let pickerCatalog: Catalog | undefined;
    const autoSourceIdentities: ProviderView[] = [];
    if (picker) {
      const base = deps.getCatalog();
      const scope = picker.scope;
      const include = (p: Provider) => scope === 'available'
        ? !isProviderDisabled(access, p.id)
        : isProviderDisabled(access, p.id) && (scope.providerId === null || scope.providerId === p.id);
      const deferred = scope === 'available' ? base.providers.filter(p => !include(p)) : base.providers.filter(include);
      picker.describe?.(scope === 'available' ? base.providers.map(p => p.id) : [], deferred.map(p => p.id));
      if (scope === 'available') {
        for (const p of deferred) {
          // Saved Auto choices can move between Cindy-distributed sources. Preserve just
          // their membership for relocation, without reading credentials or publishing routes.
          if (isCindyDistributedProvider(p)) autoSourceIdentities.push({
            id: p.id, name: p.name, source: p.source, agents: p.agents, auth: { method: p.auth.method },
            routing: {}, connected: false, suspended: true,
            models: Object.fromEntries(p.agents.map(agent => [agent,
              p.models[agent]?.filter(m => isCindyAutoModelId(m.id)).map(m => ({
                id: m.id, name: m.name, efforts: m.efforts, defaultEffort: m.defaultEffort, contextWindow: m.contextWindow,
                defaultEnabled: m.defaultEnabled, availability: m.availability,
              })) ?? [],
            ])),
          });
        }
      }
      // Cold built-in, created and legacy account pools can discover the bound model
      // only after refresh. For an implicit route, narrow by agent before reading membership.
      const implicitAgent = scope !== 'available' && scope.providerId === null ? scope.agent : undefined;
      const pools = base.providers.filter(p => include(p) && (!implicitAgent || p.agents.includes(implicitAgent))
        && (p.id === 'openai' || p.id === 'anthropic' || p.subscriptionPool !== undefined || p.auth.native === 'codex'));
      await deps.refreshPickerPools?.(pools);
      readOpts.pickerPoolsReady = true;
      const projected = deps.projectCatalog?.(base, false, include) ?? base;
      let providers = projected.providers.filter(include);
      if (scope !== 'available') {
        providers = providers.flatMap(p => {
          const model = p.models[scope.agent]?.find(m => m.id === scope.modelId);
          return model ? [{ ...p, models: { [scope.agent]: [model] }, imageModels: undefined, videoModels: undefined,
            audioModels: undefined, evaluationModels: undefined, embeddingModels: undefined }] : [];
        });
      }
      pickerCatalog = { ...projected, providers };
    }
    const readConnection = (id: keyof ProviderConnectionReaders) =>
      !pickerCatalog || pickerCatalog.providers.some(p => p.id === id) ? deps.connection[id](readOpts) : false;
    const [xd, anthropic, openai, xai] = await Promise.all([
      readConnection('xd'), readConnection('anthropic'), readConnection('openai'), readConnection('xai'),
    ]);
    // Full routing reads must materialize their catalog after all connection claims settle.
    const sourceCatalog = pickerCatalog ?? opts?.getCatalog?.() ?? opts?.catalog ?? deps.getCatalog();
    const catalog = pickerCatalog ?? deps.projectCatalog?.(sourceCatalog, routingCatalog) ?? sourceCatalog;
    const connected: ConnectionState = { xd, anthropic, openai, xai };
    for (const p of catalog.providers) {
      // 无鉴权供应商无需任何登录或密钥：只要目录声明有效，就可立即参与模型选择。
      // 该规则与 source 无关，覆盖远端目录下发的 built-in/self-hosted 条目。
      if (p.auth.method === 'none') {
        connected[p.id] = p.agents.some((agent) => {
          const routing = p.routing[agent];
          return routing !== undefined && routing.disabled !== true;
        });
      }
      // 为订阅账号新建的供应商（2026-11-13）：自己名下有已登录的账号才算连接。
      else if (p.subscriptionPool) {
        connected[p.id] = deps.subscriptionPoolConnected?.(p.id, subscriptionOptions) ?? false;
      }
      // 通用 OAuth 供应商（带 auth.oauth 描述符，内置目录下发或用户自建皆同）：
      // 连接态 = 本机是否有凭证 blob（登录过才算连接）。
      else if (p.auth.native === 'claude' || p.auth.native === 'xai') {
        connected[p.id] = deps.subscriptionAccountConnected?.(p.id) ?? false;
      } else if (p.auth.native === 'codex') {
        connected[p.id] = deps.codexAccountConnected?.(p.id, subscriptionOptions) ?? false;
      } else if (p.auth.method === 'oauth' && p.auth.oauth && !(p.id in connected)) {
        connected[p.id] = deps.genericOAuthConnected?.(p.id) ?? false;
      } else if (isCustomRoutedProvider(p)) {
        connected[p.id] = deps.customApiKeyConnected?.(p) ?? false;
      }
      // 内置 API-key 供应商(如 Gemini 图像来源):连接 = key 已存。与自定义供应商
      // 不同,内置条目常驻目录,「存在即连接」会让没配 key 的用户看到一个假连接行。
      else if (p.auth.method === 'apiKey' && !(p.id in connected)) {
        connected[p.id] = deps.builtinApiKeyConnected?.(p.id) ?? false;
      }
    }
    const unavailableSubscriptions = new Map<string, number | undefined>();
    for (const provider of catalog.providers) {
      if (deps.subscriptionReadUnavailable?.(provider.id)) {
        unavailableSubscriptions.set(provider.id, deps.subscriptionModelsConfirmedAt?.(provider.id));
      }
    }
    // Both projections read the same cached account state, without starting another refresh.
    const displayCatalog = !routingCatalog && !picker && opts?.includeSubscriptionDisplayModels &&
      [...unavailableSubscriptions.values()].some(confirmedAt => confirmedAt !== undefined)
      ? deps.projectCatalog?.(sourceCatalog, false,
          provider => unavailableSubscriptions.get(provider.id) !== undefined, true)
      : undefined;
    const discoveryFailures: ModelDiscoveryFailureState = {};
    if (deps.modelDiscoveryFailure) {
      for (const p of catalog.providers) {
        const failure = deps.modelDiscoveryFailure(p.id, connected[p.id] === true);
        if (failure) discoveryFailures[p.id] = failure;
      }
    }
    let media: readonly { providerId: string; id: string }[] | undefined;
    try {
      if (!picker) media = deps.getAvailableMediaModels?.();
    } catch (error) {
      // Media is optional enrichment; configuration and chat providers remain usable.
      media = [];
      log.warn(
        'Media readiness unavailable; returning provider configuration without media readiness',
        { error: mediaErrorForLog(error) },
      );
    }
    const accountInfo = new Map<string, ProviderView['openAiAccount']>();
    if (!readOpts.snapshotOnly && deps.openAiAccountInfo) {
      await Promise.all(catalog.providers.filter((p) => p.id === 'openai' || p.auth.native === 'codex').map(async (p) => {
        accountInfo.set(p.id, await deps.openAiAccountInfo!(p.id));
      }));
    }
    const subscriptionInfo = new Map<string, ProviderView['subscriptionAccount']>();
    if (!readOpts.snapshotOnly && deps.subscriptionAccountInfo) await Promise.all(catalog.providers
      .filter(p => p.id === 'anthropic' || p.id === 'xai' || p.auth.native === 'claude' || p.auth.native === 'xai')
      .map(async p => subscriptionInfo.set(p.id, await deps.subscriptionAccountInfo!(p.id))));
    const contextLimits = deps.getModelContextLimits?.() ?? {};
    const modelAccess = picker ? access : deps.getModelAccess?.();
    const formatModels = (provider: ProviderView): ProviderView => {
      const withContext: ProviderView = {
        ...provider,
        models: Object.fromEntries(Object.entries(provider.models).map(([agent, models]) => [
          agent, models?.map((model) => {
            const { contextWindowOverride: _previous, ...base } = model;
            const limit = contextLimits[`${agent}:${provider.id}:${model.id}`];
            return typeof limit === 'number' && Number.isFinite(limit) && limit > 0
              ? { ...base, contextWindowOverride: limit } : base;
          }),
        ])),
      };
      provider = withContext;
      if (!deps.hasModelAliasOverride) return provider;
      const blocked = new Set(Object.entries(provider.models).flatMap(([agent, models]) =>
        (models ?? []).filter((m) => m.selectionAliasKey &&
          deps.hasModelAliasOverride!(provider.id, agent as AgentKind, m.id))
          .map((m) => m.selectionAliasKey!)));
      if (!blocked.size) return provider;
      return { ...provider, models: Object.fromEntries(Object.entries(provider.models).map(([agent, models]) =>
        [agent, models?.map((m) => {
          if (!m.selectionAliasKey || !blocked.has(m.selectionAliasKey)) return m;
          const { selectionAliasKey: _marker, ...original } = m;
          return original;
        })])) };
    };
    const displayModels = new Map(displayCatalog
      ? buildRegistry({
          ...displayCatalog,
          providers: displayCatalog.providers.filter(provider =>
            unavailableSubscriptions.get(provider.id) !== undefined),
        }, connected, {}, modelAccess).map(provider => [provider.id, formatModels(provider).models] as const)
      : []);
    return buildRegistry(catalog, connected, discoveryFailures, modelAccess).map(formatModels).map((provider) => ({
      ...(subscriptionInfo.get(provider.id) ? { subscriptionAccount: subscriptionInfo.get(provider.id) } : {}),
      ...provider, ...(provider.source === 'builtin' ? deps.getProviderPresentation?.(provider.id) ?? {} : {}), ...(accountInfo.get(provider.id) ? { openAiAccount: accountInfo.get(provider.id) } : {}),
      ...(provider.source === 'organization' ? { logoKind: deps.getOrganizationProviderLogoKind?.(provider) } : {}),
      // Deletion disconnects first. A live binding wins over a stale removed flag if
      // restoring display preferences failed after authentication was committed.
      ...(provider.connected ? { removed: false } : {}),
      ...(unavailableSubscriptions.has(provider.id)
        ? { subscriptionReadUnavailable: true as const, subscriptionModelsConfirmedAt: unavailableSubscriptions.get(provider.id),
          ...(deps.subscriptionReadUnreachable?.(provider.id) ? { subscriptionReadUnreachable: true as const } : {}) } : {}),
      ...(displayModels.has(provider.id) ? { subscriptionDisplayModels: displayModels.get(provider.id) } : {}),
    })).map(
      (provider) =>
        media === undefined
          ? provider
          : {
              ...provider,
              availableMediaModelIds: provider.suspended
                ? []
                : [
                    ...new Set(
                      media
                        .filter((model) => model.providerId === provider.id)
                        .map((model) => model.id),
                    ),
                  ],
            },
    ).map(provider => deps.projectProvider?.(provider) ?? provider).concat(autoSourceIdentities);
  }

  return { listProviders };
}
