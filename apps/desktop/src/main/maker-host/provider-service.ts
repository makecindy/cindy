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

import { buildRegistry, type Catalog, type ConnectionState, type ProviderView } from '@cindy/model-providers';

/** 内置三家供应商「是否已连接」的判定器（由 host 注入，读各自凭证存储）。 */
export interface ProviderConnectionReaders {
  /** XD 网关：托管 api_key 是否存在。 */
  xd: () => boolean | Promise<boolean>;
  /** Anthropic：系统 Claude.ai OAuth 是否登录。 */
  anthropic: () => boolean | Promise<boolean>;
  /** OpenAI：Codex 是否 OAuth 登录。 */
  openai: () => boolean | Promise<boolean>;
  /** xAI：SuperGrok OAuth 是否登录(responses-bridge 直连 api.x.ai)。 */
  xai: () => boolean | Promise<boolean>;
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
}

export interface ProviderService {
  /** 当前供应商视图（含实时连接状态）。 */
  listProviders(): Promise<ProviderView[]>;
}

/**
 * 创建供应商服务。目录每次从 `getCatalog()` 现读（active-catalog 已持有进程级单例，零额外 IO）；
 * 连接状态每次实时读（凭证变化要立即反映）。
 */
export function createProviderService(deps: ProviderServiceDeps): ProviderService {
  async function listProviders(): Promise<ProviderView[]> {
    const [xd, anthropic, openai, xai] = await Promise.all([
      Promise.resolve(deps.connection.xd()),
      Promise.resolve(deps.connection.anthropic()),
      Promise.resolve(deps.connection.openai()),
      Promise.resolve(deps.connection.xai()),
    ]);
    const catalog = deps.getCatalog();
    const connected: ConnectionState = { xd, anthropic, openai, xai };
    // 自定义（user）供应商：存在于目录即视为「已连接」——用「编辑 / 删除」替代「连接 / 断开」，
    // 没有独立鉴权握手（密钥缺失则请求失败，但 UI 连接态为已配置）。
    for (const p of catalog.providers) {
      // 无鉴权供应商无需任何登录或密钥：只要目录声明有效，就可立即参与模型选择。
      // 该规则与 source 无关，覆盖远端目录下发的 built-in/self-hosted 条目。
      if (p.auth.method === 'none') {
        connected[p.id] = true;
      }
      // 通用 OAuth 供应商（带 auth.oauth 描述符，内置目录下发或用户自建皆同）：
      // 连接态 = 本机是否有凭证 blob（登录过才算连接）。
      else if (p.auth.method === 'oauth' && p.auth.oauth && !(p.id in connected)) {
        connected[p.id] = deps.genericOAuthConnected?.(p.id) ?? false;
      }
      // API key 形态的自定义（user）供应商：存在于目录即视为「已连接」——用「编辑 / 删除」
      // 替代「连接 / 断开」，没有独立鉴权握手（密钥缺失则请求失败，但 UI 连接态为已配置）。
      else if (p.source === 'user') connected[p.id] = true;
    }
    return buildRegistry(catalog, connected);
  }

  return { listProviders };
}
