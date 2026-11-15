import { createMcpDuplicatePreferences, type McpDuplicatePreferencesPorts } from '../../../desktop/src/main/maker-host/mcpDuplicatePreferencesCore.js';
import { getUserDataDir } from '../../../desktop/src/main/userDataPath.js';

export type HostCustomMcpReads = Pick<McpDuplicatePreferencesPorts,
  'getBuiltinMcpServerNames' | 'listRegistrableCustomMcpServers' | 'readCustomMcpToken'>;

/**
 * The desktop's MCP duplicate preferences (mcp-duplicate-preferences.ts) for the Claude constructor:
 * the same core, the owner's custom MCP registry reads from the Host plugin gateway, and the same
 * owner-scoped mcp-duplicate-preferences.json the window writes. Read-only on the Host: the choice is
 * made in the window (its IPC handler writes the file); only resolveLocalMcpDuplicateChoices is
 * returned. Electron's app is read only by the settings UI mock fixture, which runtime resolution
 * never takes; the Host answers as a packaged runtime.
 */
export function createHostMcpDuplicateChoices(customMcp: HostCustomMcpReads) {
  const preferences = createMcpDuplicatePreferences({
    app: { isPackaged: true, getPath: () => getUserDataDir() },
    getBuiltinMcpServerNames: () => customMcp.getBuiltinMcpServerNames(),
    listRegistrableCustomMcpServers: () => customMcp.listRegistrableCustomMcpServers(),
    readCustomMcpToken: (id) => customMcp.readCustomMcpToken(id),
  });
  return { resolveLocalMcpDuplicateChoices: preferences.resolveLocalMcpDuplicateChoices };
}
