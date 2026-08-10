/**
 * Plugin system types — Phase 1 interface definitions.
 *
 * Capability fields are defined once up-front (mcps / skills / hooks / uiPanels)
 * but only `mcps` is wired in Phase 1. The rest are reserved for future phases.
 *
 * ## Enable decision
 *   1. essential === true                     → always enabled
 *   2. machine-wide setting                    → OS-level tools only
 *   3. project settings (.claude/settings.json → xdtMaker.builtinTools.{id})
 *   4. user default (userData/builtin-tools-settings.json)
 *   5. product default
 */

import type { LiziMcpProvider } from '@cindy/mcps';

/** Stable plugin identifier — user-facing short name (e.g. 'feishu', 'feishu_bot').
 *  Bridged to @cindy/mcps LiziMcpId values via PLUGIN_ID_TO_MCP_ID table. */
export type PluginId = string;

export type PluginSource = 'builtin' | 'hub' | 'local';

export interface PluginCapabilities {
  /** MCP provider instances. Phase 1: always [] on the descriptor —
   *  real instances are built in mcp-integrations/mcp-providers.ts
   *  and wired through maker-core's LiziMcpProvider interface. */
  mcps?: LiziMcpProvider[];
  skills?: unknown[];
  hooks?: unknown[];
  uiPanels?: unknown[];
}

export interface Plugin {
  id: PluginId;
  name: string;
  description: string;
  version: string;
  source: PluginSource;
  /** true = infrastructure plugin, cannot be disabled. */
  essential?: boolean;
  capabilities: PluginCapabilities;
  /** Reserved — identity query hook, not wired in Phase 1. */
  getIdentity?(): Promise<string | null>;
}

/**
 * Project-level plugin config nested under .claude/settings.json → xdtMaker.builtinTools.
 * Example: { "xdtMaker": { "builtinTools": { "feishu": { "enabled": false } } } }
 */
export interface ProjectPluginSettings {
  builtinTools?: Record<PluginId, { enabled: boolean }>;
}

export interface XdtMakerSettings {
  xdtMaker?: ProjectPluginSettings;
}

/** Essential (infrastructure) plugin ids — cannot be disabled, hidden from Settings UI.
 *  `lsp` is essential here because LSP already has its own Beta toggle
 *  (Settings → Experimental → LSP Mode); exposing a second toggle in
 *  Connections would be redundant and confusing. @cindy/mcps still enforces
 *  the Beta gate via `isUserEnabled` inside the provider. */
export const ESSENTIAL_PLUGIN_IDS: ReadonlySet<string> = new Set([
  'memory',
  'xdt_helper',
  'scheduler',
  'lsp',
]);

/** Plugin ids that have a dedicated Settings home and should NOT appear in the
 *  generic「内置工具」list — but remain user-toggleable (unlike essential ids).
 *  `browser` and `computer` live under Settings →「电脑使用 / Computer Use」,
 *  which owns their enable toggles plus capability-specific guidance, so a duplicate
 *  toggle in the builtin-tools list would confuse users. */
export const HOSTED_ELSEWHERE_PLUGIN_IDS: ReadonlySet<string> = new Set([
  'android',
  'browser',
  'computer',
  // 智能通讯录的开关在 Settings → 智能通讯录 专属页(contacts-settings-store),
  // 「内置工具」列表再出现一个 toggle 会造成双开关困惑。
  'contacts',
]);

/** Builtin plugins that are intentionally opt-in by default.
 * Direct desktop control can click/type into local apps, so it must not appear
 * in new sessions until the user explicitly enables it for the project. */
export const DEFAULT_DISABLED_PLUGIN_IDS: ReadonlySet<string> = new Set([
  'android',
  'computer',
]);

/** Builtin plugins whose enablement is machine-wide, not project-scoped.
 * Direct desktop control installs a local driver and requires OS-level
 * permissions, so tying it to an arbitrary session workingDir makes the MCP
 * disappear for plain dialogue sessions. */
export const GLOBAL_PLUGIN_IDS: ReadonlySet<string> = new Set(['android', 'computer']);
