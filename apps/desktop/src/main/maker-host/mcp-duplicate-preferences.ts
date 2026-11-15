
// The preferences themselves live in mcpDuplicatePreferencesCore.ts (shared with the Node Host).
// This module builds the single Desktop instance; its ports resolve Electron and the Desktop MCP
// registry when called, never when this module loads.
import { createMcpDuplicatePreferences } from './mcpDuplicatePreferencesCore.js';
import { app } from 'electron';
import { readCustomMcpToken } from '../secrets/providerSecretStore.js';
import { getBuiltinMcpServerNames, listRegistrableCustomMcpServers } from '../mcp-integrations/custom-mcp-registry.desktop.js';

const desktopMcpDuplicatePreferences = createMcpDuplicatePreferences({
  app: { get isPackaged() { return app.isPackaged; }, getPath: (name) => app.getPath(name) },
  readCustomMcpToken: (...args) => readCustomMcpToken(...args),
  getBuiltinMcpServerNames: (...args) => getBuiltinMcpServerNames(...args),
  listRegistrableCustomMcpServers: (...args) => listRegistrableCustomMcpServers(...args),
});
type Instance = typeof desktopMcpDuplicatePreferences;

export function listMcpDuplicates(...args: Parameters<Instance['listMcpDuplicates']>): ReturnType<Instance['listMcpDuplicates']> {
  return desktopMcpDuplicatePreferences.listMcpDuplicates(...args);
}

export function saveMcpDuplicateChoice(...args: Parameters<Instance['saveMcpDuplicateChoice']>): ReturnType<Instance['saveMcpDuplicateChoice']> {
  return desktopMcpDuplicatePreferences.saveMcpDuplicateChoice(...args);
}

export function resolveLocalMcpDuplicateChoices(...args: Parameters<Instance['resolveLocalMcpDuplicateChoices']>): ReturnType<Instance['resolveLocalMcpDuplicateChoices']> {
  return desktopMcpDuplicatePreferences.resolveLocalMcpDuplicateChoices(...args);
}
