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

import {
  buildRegistry,
  type Catalog,
  type ConnectionState,
  type ModelDisableOverrides,
  type ModelDiscoveryFailureState,
  type ProviderModelDiscoveryFailure,
  type ProviderView,
} from '@cindy/model-providers';

/**
 * 读取连接态时是否允许附带**本机副作用**（绑定自愈、随之而来的清单拉取）。
 *
 * 纯读取一律安全，但自愈会写绑定文件、读凭证作用域缓存并发起带凭证的上游请求。这条
 * 通道（`maker:provider:list`）同时服务于 device-link 与可能不受信的渲染上下文，所以副作用
 * 只在调用方明确是「本机主页面」时才放行；其余一律降级为纯读（PR #548 review）。
 */
export interface ConnectionReadOptions {
  allowSideEffects: boolean;
  /**
   * Wait for post-claim model discovery before materializing this snapshot.
   * This is an internal readiness hint for routing callers; ordinary provider reads
   * intentionally keep the low-latency/LKG behavior even when side effects are allowed.
   */
  waitForDiscovery?: boolean;
}

export interface ProviderListOptions extends ConnectionReadOptions {
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
  /** Anthropic：系统 Claude.ai OAuth 是否登录。 */
  anthropic: (opts: ConnectionReadOptions) => boolean | Promise<boolean>;
  /** OpenAI：Codex 是否 OAuth 登录。 */
  openai: (opts: ConnectionReadOptions) => boolean | Promise<boolean>;
  /** xAI：SuperGrok OAuth 是否登录(responses-bridge 直连 api.x.ai)。 */
  xai: (opts: ConnectionReadOptions) => boolean | Promise<boolean>;
}

export interface ProviderServiceDeps {
  /** 返回当前生效目录（同步）。桌面端注入 active-catalog 的 getActiveCatalog。 */
  getCatalog: () => Catalog;
  /** 连接状态判定器。 */
  connection: ProviderConnectionReaders;
  /**
   * 通用 OAuth 供应商（目录 auth.oauth 描述符驱动、非内置 bespoke 四家）的连接态判定
   * （生产 = generic-oauth 的 hasGenericOAuthLogin）。缺省 = 一律未连接。
   */
  genericOAuthConnected?: (providerId: string) => boolean;
  /**
   * 内置 API-key 供应商(auth.method 'apiKey' 且 source 'builtin',如 Gemini 图像来源,
   * 2026-07)的连接态判定:连接 = 该供应商的 key 已存(生产 = providerSecretStore.has)。
   * 缺省 = 一律未连接。
   */
  builtinApiKeyConnected?: (providerId: string) => boolean;
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
    const readOpts: ConnectionReadOptions = {
      allowSideEffects: opts?.allowSideEffects === true,
      waitForDiscovery: opts?.waitForDiscovery === true,
    };
    const [xd, anthropic, openai, xai] = await Promise.all([
      Promise.resolve(deps.connection.xd(readOpts)),
      Promise.resolve(deps.connection.anthropic(readOpts)),
      Promise.resolve(deps.connection.openai(readOpts)),
      Promise.resolve(deps.connection.xai(readOpts)),
    ]);
    const catalog = opts?.getCatalog?.() ?? opts?.catalog ?? deps.getCatalog();
    const connected: ConnectionState = { xd, anthropic, openai, xai };
    // 自定义（user）供应商：存在于目录即视为「已连接」——用「编辑 / 删除」替代「连接 / 断开」，
    // 没有独立鉴权握手（密钥缺失则请求失败，但 UI 连接态为已配置）。
    for (const p of catalog.providers) {
      // 无鉴权供应商无需任何登录或密钥：只要目录声明有效，就可立即参与模型选择。
      // 该规则与 source 无关，覆盖远端目录下发的 built-in/self-hosted 条目。
      if (p.auth.method === 'none') {
        connected[p.id] = p.agents.some((agent) => {
          const routing = p.routing[agent];
          return routing !== undefined && routing.disabled !== true;
        });
      }
      // 通用 OAuth 供应商（带 auth.oauth 描述符，内置目录下发或用户自建皆同）：
      // 连接态 = 本机是否有凭证 blob（登录过才算连接）。
      else if (p.auth.method === 'oauth' && p.auth.oauth && !(p.id in connected)) {
        connected[p.id] = deps.genericOAuthConnected?.(p.id) ?? false;
      }
      // API key 形态的自定义（user）供应商：存在于目录即视为「已连接」——用「编辑 / 删除」
      // 替代「连接 / 断开」，没有独立鉴权握手（密钥缺失则请求失败，但 UI 连接态为已配置）。
      else if (p.source === 'user') connected[p.id] = true;
      // 内置 API-key 供应商(如 Gemini 图像来源):连接 = key 已存。与自定义供应商
      // 不同,内置条目常驻目录,「存在即连接」会让没配 key 的用户看到一个假连接行。
      else if (p.auth.method === 'apiKey' && !(p.id in connected)) {
        connected[p.id] = deps.builtinApiKeyConnected?.(p.id) ?? false;
      }
    }
    const discoveryFailures: ModelDiscoveryFailureState = {};
    if (deps.modelDiscoveryFailure) {
      for (const p of catalog.providers) {
        const failure = deps.modelDiscoveryFailure(p.id, connected[p.id] === true);
        if (failure) discoveryFailures[p.id] = failure;
      }
    }
    return buildRegistry(catalog, connected, discoveryFailures, deps.getModelAccess?.());
  }

  return { listProviders };
}
