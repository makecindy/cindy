/**
 * claude-gateway-config —— Anthropic 原生模型的 wire-string 分类器(纯函数)。
 *
 * 用途:在本地 loopback proxy 的路由决策里判定「这个模型是不是 Anthropic 原生」——
 * oauth-spawn 下没配网关 key 时,只有 Anthropic 模型能直连 api.anthropic.com 兜底
 * (见 anthropic-compat-proxy-host.ts ② 段)。退役全局鉴权开关后,默认/per-session 路由
 * 主体改由 catalog 描述符驱动(provider-route.ts),本文件只保留这个轻量分类器 + 直连上游常量。
 *
 * 判定 = 前缀白名单 ∪ 目录集合(anthropic 供应商名下的 claude-code 模型):
 *   - 目录集合是主判据:Anthropic 出新家族名(fable 之后的下一个)只改 OSS providers.json
 *     即可放行直连,不必发版;
 *   - 前缀白名单保留作兼容地板:历史存量 wire 串里的裸别名('sonnet[1m]' / 'opus')
 *     目录里没有对应 id,只有前缀能认;同时它保证目录加载失败回落 bundled 时行为不回退。
 * fail-safe 方向不变:两边都不认识 → 一律否(绝不会误带 OAuth token 直连 Anthropic)。
 *
 * 分类器吃的是 **toSdkModelString 改写后的 wire string**(proxy 看到的 body.model),
 * 例:claude-sonnet-4-6 → claude-sonnet-4-6[1m];claude-haiku-4-5 → claude-haiku-4-5-20251001。
 * 归一化(剥 [1m] / 日期后缀)后再查目录集合。
 */

import type { Catalog } from '@cindy/model-providers';

/** Anthropic 模型在 oauth-spawn 下直连的上游。 */
export const ANTHROPIC_DIRECT_UPSTREAM = 'https://api.anthropic.com';

/**
 * provider-oauth 形态 cc spawn 的占位 API key(真实凭证由 proxy 在路由时注入)。
 * 定义放本 leaf 模块:auth-adapters(写入 env)与 anthropic-compat-proxy-host
 * (路由时识别「这不是可用凭证」,#831)都要消费,而 auth-adapters 已 import
 * proxy-host,反向 import 会成环。
 */
export const CLAUDE_PROVIDER_AUTH_PLACEHOLDER_KEY = 'xdt-provider-auth-placeholder-key';

/**
 * 前缀兼容地板(见文件头)。新增 Anthropic 家族名**不需要**改这里——
 * 加进 OSS 目录 anthropic 供应商名下即可;此列表只为历史裸别名与目录失效兜底而存在。
 */
const ANTHROPIC_WIRE_MODEL_PREFIXES = ['claude-', 'sonnet', 'opus', 'haiku', 'fable'] as const;

/** 目录集合的 memo:目录对象每进程加载一次(active-catalog),按引用同一性缓存派生结果。 */
let cachedCatalog: Catalog | null = null;
let cachedIds: ReadonlySet<string> | null = null;

/**
 * 从目录派生「anthropic 供应商提供的模型 id 集合」(小写,**全部 agent**)。
 * 判据是供应商级事实——由 Anthropic 订阅授权提供的模型都允许带订阅 token 直连,
 * 不限定单个 agent 清单;方向安全:直连上游固定 api.anthropic.com,token 只会发给
 * Anthropic 自己。热路径每请求调用,按 catalog 引用 memo,首次 O(models) 之后 O(1)。
 */
export function anthropicCatalogModelIds(catalog: Catalog): ReadonlySet<string> {
  if (catalog === cachedCatalog && cachedIds) return cachedIds;
  const ids = new Set<string>();
  for (const p of catalog.providers) {
    if (p.id !== 'anthropic') continue;
    for (const models of Object.values(p.models)) {
      for (const m of models ?? []) ids.add(m.id.toLowerCase());
    }
  }
  cachedCatalog = catalog;
  cachedIds = ids;
  return ids;
}

/**
 * wire model 是否 Anthropic 原生(可走订阅 OAuth 直连)。大小写不敏感。
 * `catalogModelIds` 传 anthropicCatalogModelIds(getActiveCatalog()) 的结果;
 * 不传时退化为纯前缀判定(单测 / 目录不可用场景)。
 */
export function isAnthropicWireModel(
  wireModel: string,
  catalogModelIds?: ReadonlySet<string>,
): boolean {
  const m = wireModel.trim().toLowerCase();
  if (!m) return false;
  if (ANTHROPIC_WIRE_MODEL_PREFIXES.some((p) => m.startsWith(p))) return true;
  if (catalogModelIds && catalogModelIds.size > 0) {
    // wire 串 → 目录 id 归一化:先剥 [1m],再试剥日期版本号(claude-haiku-4-5-20251001)。
    // 两种形态都查一遍,防目录 id 本身以 8 位数字结尾的误剥。
    const bare = m.endsWith('[1m]') ? m.slice(0, -'[1m]'.length) : m;
    if (catalogModelIds.has(bare)) return true;
    const undated = bare.replace(/-\d{8}$/, '');
    if (undated !== bare && catalogModelIds.has(undated)) return true;
  }
  return false;
}
