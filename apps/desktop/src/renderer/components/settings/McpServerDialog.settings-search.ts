import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

export const mcpFields = defineSettings({
  name: { id: 'mcp.name', tab: 'builtin-tools', targetId: 'settings-mcp-name',
    fallbackTargetId: 'settings-mcp-servers', sectionKey: 'settings.mcp.title', titleKey: 'settings.mcp.fields.name', },
  transport: { id: 'mcp.transport', tab: 'builtin-tools', targetId: 'settings-mcp-transport',
    fallbackTargetId: 'settings-mcp-servers', sectionKey: 'settings.mcp.title', titleKey: 'settings.mcp.fields.transport', },
  url: { id: 'mcp.url', tab: 'builtin-tools', targetId: 'settings-mcp-url',
    fallbackTargetId: 'settings-mcp-servers', sectionKey: 'settings.mcp.title', titleKey: 'settings.mcp.fields.url', },
  token: { id: 'mcp.token', tab: 'builtin-tools', targetId: 'settings-mcp-token',
    fallbackTargetId: 'settings-mcp-servers', sectionKey: 'settings.mcp.title', titleKey: 'settings.mcp.fields.token',
    descriptionKey: 'settings.mcp.fields.tokenHelp', },
  headerName: { id: 'mcp.headerName', tab: 'builtin-tools', targetId: 'settings-mcp-headerName',
    fallbackTargetId: 'settings-mcp-servers', sectionKey: 'settings.mcp.title', titleKey: 'settings.mcp.fields.headerNamePlaceholder', },
  headerValue: { id: 'mcp.headerValue', tab: 'builtin-tools', targetId: 'settings-mcp-headerValue',
    fallbackTargetId: 'settings-mcp-servers', sectionKey: 'settings.mcp.title', titleKey: 'settings.mcp.fields.headerValuePlaceholder', },
  localConfig: { id: 'mcp.localConfig', tab: 'builtin-tools', targetId: 'settings-mcp-localConfig',
    fallbackTargetId: 'settings-mcp-servers', sectionKey: 'settings.mcp.title', titleKey: 'settings.mcp.fields.localConfig',
    descriptionKey: 'settings.mcp.fields.localHelp', },
});

export default { id: 'custom-mcp-fields', order: 9, entries: Object.values(mcpFields) } satisfies SettingsSearchModule;
