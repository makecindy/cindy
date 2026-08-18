/**
 * Shared Settings tab definitions — single source of truth for tab IDs and their i18n keys.
 *
 * Used by SettingsView (sidebar labels) and HelpThreadView ("Open X tab" button label).
 *
 * `ghosts` is a real Settings tab that embeds the same plugin catalog as `/plugins`.
 * Legacy `api-keys` / `connections` ids stay on the type for old deep links.
 */

export type SettingsTab =
  | 'general'
  | 'billing'
  | 'personalization'
  | 'providers'
  | 'api-keys'
  | 'voice-input'
  | 'shortcuts'
  | 'agent-island'
  | 'import'
  | 'connections'
  | 'remote-control'
  | 'tina'
  | 'ghosts'
  | 'builtin-tools'
  | 'computer-use'
  | 'im-bot'
  | 'help'
  | 'about';

export const TAB_IDS: ReadonlyArray<SettingsTab> = [
  'general',
  'personalization',
  'providers',
  'billing',
  // 「工具密钥」(api-keys)已于 2026-07-13 下架:面板里最后一把 mivo key 随
  // XD Mivo 意识化改由意识设置页收单(官方别名映射同一存储键)。id 仍留在
  // SettingsTab 类型与 TAB_LABEL_KEY 保留,供旧深链重定向到插件分区。
  'voice-input',
  // IM 机器人紧随语音输入(Lizi 2026-07-15 拍板)。
  'im-bot',
  'shortcuts',
  'agent-island',
  'import',
  // 「第三方平台」(connections)已于 2026-07-15 下架:Slack 官方 MCP 随 cindy-slack
  // 意识化收尾(Google/Jira/GitHub/GitLab 此前已迁意识)。id 仍留在 SettingsTab
  // 类型与 TAB_LABEL_KEY 保留,供旧深链重定向到插件分区。
  'remote-control',
  'ghosts',
  'builtin-tools',
  'computer-use',
  'help',
  'about',
];

export const TAB_LABEL_KEY: Record<SettingsTab, string> = {
  general: 'settings.tabs.general',
  billing: 'settings.tabs.billing',
  personalization: 'settings.tabs.personalization',
  'api-keys': 'settings.tabs.apiKeys',
  'voice-input': 'settings.tabs.voiceInput',
  shortcuts: 'settings.tabs.shortcuts',
  'agent-island': 'settings.tabs.agentIsland',
  import: 'settings.tabs.import',
  connections: 'settings.tabs.connections',
  providers: 'settings.tabs.providers',
  'remote-control': 'settings.tabs.remoteControl',
  tina: 'settings.tabs.tina',
  ghosts: 'settings.tabs.ghosts',
  'builtin-tools': 'settings.tabs.builtinTools',
  'computer-use': 'settings.tabs.computerUse',
  'im-bot': 'settings.tabs.imBot',
  help: 'settings.tabs.help',
  about: 'settings.tabs.about',
};

// 只校验当前「可见/可路由」的 tab(即 TAB_IDS 里的项)。注意 `tina` 仍保留在
// SettingsTab 类型与 TAB_LABEL_KEY 中(供 SettingsView 的 `?tab=tina` → `im-bot`
// legacy 重定向复用),但已从 TAB_IDS 移除,因此 isSettingsTab('tina') 返回 false
// 是有意为之——tina 不再是独立可停靠的 tab,重定向在调用本守卫之前就已处理。
export function isSettingsTab(value: string | null): value is SettingsTab {
  return value !== null && (TAB_IDS as ReadonlyArray<string>).includes(value);
}
