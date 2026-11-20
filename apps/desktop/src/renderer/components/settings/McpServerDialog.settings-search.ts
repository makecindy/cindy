import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

// Dynamic MCP fields are configured in the existing form; search opens its owning section.
export const customMcpSettings = defineSettings({
  name: { id: 'custom-mcp.name', tab: 'builtin-tools', targetId: 'settings-custom-mcp', titleKey: 'settings.mcp.fields.name', sectionKey: 'settings.mcp.title' },
  transport: { id: 'custom-mcp.transport', tab: 'builtin-tools', targetId: 'settings-custom-mcp', titleKey: 'settings.mcp.fields.transport', sectionKey: 'settings.mcp.title', aliases: ['stdio', 'HTTP', 'SSE', 'uvx', 'Grafana'] },
  url: { id: 'custom-mcp.url', tab: 'builtin-tools', targetId: 'settings-custom-mcp', titleKey: 'settings.mcp.fields.url', sectionKey: 'settings.mcp.title' },
  token: { id: 'custom-mcp.token', tab: 'builtin-tools', targetId: 'settings-custom-mcp', titleKey: 'settings.mcp.fields.token', sectionKey: 'settings.mcp.title' },
  headers: { id: 'custom-mcp.headers', tab: 'builtin-tools', targetId: 'settings-custom-mcp', titleKey: 'settings.mcp.fields.headers', sectionKey: 'settings.mcp.title' },
  command: { id: 'custom-mcp.command', tab: 'builtin-tools', targetId: 'settings-custom-mcp', titleKey: 'settings.mcp.fields.command', sectionKey: 'settings.mcp.title', descriptionKey: 'settings.mcp.fields.commandHelp' },
  args: { id: 'custom-mcp.args', tab: 'builtin-tools', targetId: 'settings-custom-mcp', titleKey: 'settings.mcp.fields.args', sectionKey: 'settings.mcp.title', descriptionKey: 'settings.mcp.fields.argsHelp' },
  cwd: { id: 'custom-mcp.cwd', tab: 'builtin-tools', targetId: 'settings-custom-mcp', titleKey: 'settings.mcp.fields.cwd', sectionKey: 'settings.mcp.title', descriptionKey: 'settings.mcp.fields.cwdHelp' },
  env: { id: 'custom-mcp.env', tab: 'builtin-tools', targetId: 'settings-custom-mcp', titleKey: 'settings.mcp.fields.env', sectionKey: 'settings.mcp.title', descriptionKey: 'settings.mcp.fields.envHelp' },
});

export default { id: 'custom-mcp', order: 9, entries: Object.values(customMcpSettings) } satisfies SettingsSearchModule;
