type PluginId = string;


/**
 * @cindy/mcps/providers.ts 里的已知 MCP provider name。
 * 每个内置 provider 都必须在 PROVIDER_NAME_TO_PLUGIN_ID 里有映射。
 */
export type KnownProviderName =
  | 'cindy_android'
  | 'cindy_browser'
  | 'cindy_computer'
  | 'cindy_feishu_bot'
  | 'cindy_wechat'
  | 'cindy_slack'
  | 'cindy_scheduler'
  | 'cindy_ssh'
  | 'cindy_memory'
  | 'cindy_contacts'
  | 'cindy_docs'
  | 'cindy_helper'
  | 'cindy_orca'
  | 'cindy_lsp';


/**
 * MCP provider `name`(@cindy/mcps/providers.ts) → 用户可见 plugin id 的映射。
 *
 * 现役 provider name 使用 `cindy_` 前缀；用户配置使用短 id('feishu'、'memory')。
 * 这张表桥接两者，让 mcp-providers.ts
 * 可以调用：
 *
 *   const pluginId = pluginIdForProviderName(p.name);
 *   pluginRegistry.isEnabled(pluginId, ctx.workingDir)
 *
 * 这里用 Record<KnownProviderName, PluginId> 而不是 Partial；更新 KnownProviderName
 * 后会由 TypeScript 保证穷尽。真实 provider 列表覆盖由测试从 createLiziMcpProviders
 * 派生后校验，防止新增 provider 漏映射。
 */
export const PROVIDER_NAME_TO_PLUGIN_ID: Record<KnownProviderName, PluginId> = {
  cindy_android: 'android',
  cindy_browser: 'browser',
  cindy_computer: 'computer',
  cindy_feishu_bot: 'feishu_bot',
  cindy_wechat: 'wechat',
  cindy_slack: 'slack',
  cindy_scheduler: 'scheduler',
  cindy_ssh: 'ssh',
  cindy_memory: 'memory',
  cindy_contacts: 'contacts',
  cindy_docs: 'docs',
  cindy_helper: 'xdt_helper',
  cindy_orca: 'collab',
  cindy_lsp: 'lsp',
};


/**
 * 把 @cindy/mcps 的 MCP provider name 解析成用户可见 plugin id。
 * 未知 name 原样透传；registry 会按 fail-open 处理为默认启用。
 */
export function pluginIdForProviderName(name: string): PluginId {
  return PROVIDER_NAME_TO_PLUGIN_ID[name as KnownProviderName] ?? name;
}


/** Resolve only first-party built-in providers; custom MCP ids must never inherit this policy. */
export function pluginIdForKnownProviderName(name: string): PluginId | null {
  return PROVIDER_NAME_TO_PLUGIN_ID[name as KnownProviderName] ?? null;
}