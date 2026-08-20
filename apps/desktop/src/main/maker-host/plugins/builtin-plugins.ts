/**
 * 内置 plugin 定义：把现有 LiziMcpProvider factory 包成带 metadata
 * (name, description, essential flag) 的 Plugin descriptor。
 *
 * **Plugin ID 是稳定的用户可见契约**，用于：
 *   - 项目设置：.claude/settings.json → xdtMaker.builtinTools.{id}
 *
 * 所有 ID 都使用短且一致的名字，不带 `cindy_` 前缀：
 *   android | ios-simulator | browser | computer | feishu_bot | wechat |
 *   scheduler | ssh | memory | contacts | docs | xdt_helper | collab(→ cindy_orca) | lsp
 *
 * @cindy/mcps/providers.ts 里的现役 MCP provider `name` 使用 `cindy_` 前缀；
 * 用户配置仍使用稳定的短 plugin id。映射关系由 PROVIDER_NAME_TO_PLUGIN_ID 定义，
 * mcp-providers.ts 包装 isEnabled gate 时消费。
 */

import type { Plugin, PluginId } from './types.js';
import { ESSENTIAL_PLUGIN_IDS } from './types.js';
import type { LiziMcpId } from '@cindy/mcps';

interface BuiltinPluginMeta {
  id: PluginId;
  name: string;
  description: string;
}

/**
 * 内置 MCP plugin，按注册顺序排列。
 * `id` 是面向用户的稳定标识，用在 settings 文件和 IPC 中。
 */
const BUILTIN_META: BuiltinPluginMeta[] = [
  { id: 'android',     name: 'Android Automation', description: 'Android adb automation — screenshots, UI dump, taps, swipes, text input, and app launch on connected devices' },
  { id: 'ios-simulator', name: 'iOS Simulator', description: 'Cindy embedded iOS Simulator — create or attach a session-owned device, boot it in the embedded viewer, build/install/launch apps, inspect screens, and debug interactions.' },
  { id: 'browser',     name: 'Browser',      description: 'Browser automation — isolated browsing, snapshots, screenshots, and page actions' },
  { id: 'computer',    name: 'Computer Use', description: 'Local desktop automation — apps, windows, UI inspection, clicks, and typing via an installed driver' },
  { id: 'feishu_bot',   name: 'Feishu Bot',   description: 'Send files and notifications to Feishu users via bot messages' },
  { id: 'wechat',       name: 'Personal WeChat', description: 'Send proactive messages to known personal WeChat contacts' },
  { id: 'slack',        name: 'Slack',        description: 'Slack tools via the bound Slack connection — search, read history, and post through Slack\'s hosted MCP as the bound user' },
  { id: 'scheduler',    name: 'Scheduler',    description: 'Task scheduling — cron-based recurring jobs and one-shot reminders' },
  { id: 'ssh',          name: 'SSH Remote',   description: 'Run commands on configured SSH hosts via the built-in connection pool (aliases, ssh-agent/keys) — nothing installed remotely' },
  { id: 'memory',       name: 'Maker Memory', description: 'Cross-agent long-term memory for persistent context across sessions' },
  { id: 'contacts',     name: 'Smart Contacts', description: 'Agent-native contacts — cross-platform identity resolution, relationship context, and timeline events' },
  { id: 'docs',         name: 'Document Toolkit', description: 'Turn content into real files — PDF, Word, Excel, and PowerPoint — and read them back to verify the result. No extra software to install.' },
  { id: 'xdt_helper',   name: 'Cindy Helper', description: 'Host capability disclosure — tells agents what tools and models are available' },
  { id: 'collab',       name: 'Collab Mode',  description: 'Multi-worker collaboration (Orca team) — start_team / create_worker / send_to_worker etc.' },
  { id: 'lsp',          name: 'LSP',          description: 'TypeScript LSP queries (Beta — gated by Settings → Experimental → LSP Mode)' },
  // xd_service 已于 2026-07-13 退役:Pages 能力(含部署)整体迁入内置意识
  // xd-pages(登录邮箱派生凭证 + 目录过户上传),不再是 MCP 插件。
  // mivo 已于 2026-07-13 退役:13 工具整体迁入内置意识 xd-mivo(exchange
  // 二段式凭证 + 双路媒体落地),不再是 MCP 插件。
  // github 已于 2026-07-14 退役:GitHub 能力整体迁入内置意识 cindy-github
  // (老 PAT 由 githubAccountsMigration 无感搬账),不再是 MCP 插件。
  // gitlab 已于 2026-07-14 退役:GitLab 能力整体迁入内置意识 cindy-gitlab
  // (老 PAT + 实例地址由 gitlabAccountsMigration 无感搬账),不再是 MCP 插件。
  // slack 插件 2026-07-19 回归(cindy_slack): Slack 能力并轨 hook 通道 ——
  // slack-hook-server 以 bind v2 托管的 user token 调 Slack 官方 MCP,
  // 桌面侧经 tool.request 帧透传; cindy-slack 意识同日退役。
  // feishu 已于 2026-07-16 摘壳:飞书 OpenAPI 能力(44 精品 + 123 只读直通)
  // 迁入内置意识 xd-feishu,不再是 MCP 插件;2026-07-17 起授权也切到意识
  // OAuth broker(tokenBroker:'feishu'),主机 token 刷新链与 scheduler
  // registry 直调一并退役(scheduler 飞书方法改走 ghost pipe)。
  // 注意 feishu_bot(bot 出站通道)是另一套东西,不受影响、继续留任。
  // slack_bot(lizi_slack_bot 出站通道)已于 2026-07-17 随老 SlackIM relay
  // 渠道退役(apiBaseUrl 清理):Slack 能力统一走 hook-control ↔ slack-hook-server,
  // hook 会话的文件回传走 xdt-file 附件链路,不再需要 bot 推送工具。
];

/**
 * @cindy/mcps/providers.ts 里的已知 MCP provider name。
 * 每个内置 provider 都必须在 PROVIDER_NAME_TO_PLUGIN_ID 里有映射。
 */
export type KnownProviderName =
  | 'cindy_android'
  | 'cindy_ios_simulator'
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
  cindy_ios_simulator: 'ios-simulator',
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

/** 从静态 metadata 列表构造 Plugin descriptor。
 *
 * Phase 1 约束：descriptor 上的 `capabilities.mcps` 始终是 `[]`。
 * 真正的 MCP server instance 在 mcp-integrations/mcp-providers.ts 构造，
 * 再通过 maker-core 的 LiziMcpProvider interface 接进 agent。plugin descriptor
 * 只承载身份和启用策略 metadata。 */
export function createBuiltinPlugins(): Plugin[] {
  return BUILTIN_META.map((meta) => ({
    id: meta.id,
    name: meta.name,
    description: meta.description,
    version: '1.0.0',
    source: 'builtin' as const,
    essential: ESSENTIAL_PLUGIN_IDS.has(meta.id),
    capabilities: {
      mcps: [],
    },
  }));
}

/**
 * plugin id → LiziMcpId 的显式映射，用于 createLiziMcpProviders 的 `enabled` 数组。
 * 单独维护表，而不是用 `as LiziMcpId` 强转，这样非 MCP plugin id 会在运行时被过滤，
 * 不会静默生成非法 LiziMcpId。
 *
 * 后续如果把 PluginId 收窄成 literal union，这张表也能得到编译期穷尽检查。
 */
const PLUGIN_ID_TO_MCP_ID: Record<PluginId, LiziMcpId | undefined> = {
  android: 'android',
  'ios-simulator': 'ios_simulator',
  browser: 'browser',
  computer: 'computer',
  feishu_bot: 'cindy_feishu_bot',
  wechat: 'cindy_wechat',
  slack: 'cindy_slack',
  scheduler: 'cindy_scheduler',
  ssh: 'cindy_ssh',
  memory: 'cindy_memory',
  contacts: 'cindy_contacts',
  docs: 'cindy_docs',
  xdt_helper: 'cindy_helper',
  collab: 'cindy_orca',
  lsp: 'cindy_lsp',
};

/** createLiziMcpProviders `enabled` 数组使用的有序 LiziMcpId。模块加载时计算一次，运行期不变。 */
export const BUILTIN_LIZI_MCP_IDS: readonly LiziMcpId[] = BUILTIN_META
  .map((m) => PLUGIN_ID_TO_MCP_ID[m.id])
  .filter((id): id is LiziMcpId => id !== undefined);
