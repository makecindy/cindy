import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

// Dialog fields are opened from this section; search must land on its real anchor.
export const mcpFields = defineSettings({
  name: { id: 'mcp.name', tab: 'builtin-tools', targetId: 'settings-mcp-servers', sectionKey: 'settings.mcp.title', titleKey: 'settings.mcp.fields.name', },
  transport: { id: 'mcp.transport', tab: 'builtin-tools', targetId: 'settings-mcp-servers', sectionKey: 'settings.mcp.title', titleKey: 'settings.mcp.fields.transport', },
  url: { id: 'mcp.url', tab: 'builtin-tools', targetId: 'settings-mcp-servers', sectionKey: 'settings.mcp.title', titleKey: 'settings.mcp.fields.url', },
  token: { id: 'mcp.token', tab: 'builtin-tools', targetId: 'settings-mcp-servers', sectionKey: 'settings.mcp.title', titleKey: 'settings.mcp.fields.token',
    descriptionKey: 'settings.mcp.fields.tokenHelp', },
  headerName: { id: 'mcp.headerName', tab: 'builtin-tools', targetId: 'settings-mcp-servers', sectionKey: 'settings.mcp.title', titleKey: 'settings.mcp.fields.headerNamePlaceholder', },
  headerValue: { id: 'mcp.headerValue', tab: 'builtin-tools', targetId: 'settings-mcp-servers', sectionKey: 'settings.mcp.title', titleKey: 'settings.mcp.fields.headerValuePlaceholder', },
  localConfig: { id: 'mcp.localConfig', tab: 'builtin-tools', targetId: 'settings-mcp-servers', sectionKey: 'settings.mcp.title', titleKey: 'settings.mcp.fields.localConfig',
    descriptionKey: 'settings.mcp.fields.localHelp', },
});

export default { id: 'custom-mcp-fields', order: 9, entries: Object.values(mcpFields) } satisfies SettingsSearchModule;
