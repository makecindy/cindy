/**
 * MCP duplicate preferences (a native Claude connection that duplicates a Cindy one), shared by
 * Desktop and the Node Host. Moved verbatim from mcp-duplicate-preferences.ts, which now builds
 * the Desktop instance. Electron's app (only the settings UI mock fixture reads it), the custom MCP
 * registry and the custom MCP token reader arrive as ports; every other import is unchanged.
 * Each launcher creates one instance holding the former module state (the preferences file store).
 */

import os from 'node:os';
import path from 'node:path';
import { workspaceSettingsFiles } from '@cindy/maker-core';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { isUiMockDataEnabled } from '../localDb/uiMockSeed.js';
import { groupMcpDuplicateConnections, type McpDuplicateChoice } from '../../shared/customMcp.js';
import { createOverrideSettingsFile } from './override-settings-file.js';
import { detectMcpDuplicates, readMcpJson, resolveMcpDuplicateChoices } from './mcp-duplicate-detection.js';

/** The Desktop-only reads, resolved by each launcher. */
export interface McpDuplicatePreferencesPorts {
  app: { readonly isPackaged: boolean; getPath(name: 'userData'): string };
  readCustomMcpToken: (mcpId: string) => string | null;
  getBuiltinMcpServerNames: () => string[];
  listRegistrableCustomMcpServers: ReturnType<typeof import('../mcp-integrations/custom-mcp-registry.js').createCustomMcpRegistry>['listRegistrableCustomMcpServers'];
}

/** One instance per launcher; the former module state lives in it. */
export function createMcpDuplicatePreferences(ports: McpDuplicatePreferencesPorts) {
const { app, readCustomMcpToken, getBuiltinMcpServerNames, listRegistrableCustomMcpServers } = ports;


const store = createOverrideSettingsFile<{ choices: Record<string, McpDuplicateChoice> }>({
  filePath: () => path.join(ownerScopedUserDataPath(), 'mcp-duplicate-preferences.json'),
  defaults: { choices: {} },
  normalize: raw => {
    const choices = (raw as { choices?: unknown } | null)?.choices;
    return { choices: Object.fromEntries(Object.entries(choices && typeof choices === 'object' ? choices : {})
      .filter(([key, value]) => /^[a-f0-9]{64}$/.test(key) && ['cindy', 'claude', 'both'].includes(value))) };
  },
  scopeKey: activeOwnerScopeKey,
  log: createLogger('mcp-duplicate-preferences'),
  label: 'MCP duplicate preferences',
  preserveUnreadableFile: true,
  logLoadedValue: false,
  logReadErrorDetails: false,
  maxBytes: 1024 * 1024,
});

function listMcpDuplicates(input?: { env: NodeJS.ProcessEnv; workingDir?: string }) {
  // Settings-only fixture: --mock must not inspect the person's native config.
  // Runtime resolution always passes an explicit environment and never uses this file.
  const mock = !input && !app.isPackaged && isUiMockDataEnabled() && process.env.XDT_ISOLATED === '1';
  const context = input ?? { env: mock
    ? { CLAUDE_CONFIG_DIR: path.join(app.getPath('userData'), 'ui-mock', 'claude') }
    : process.env };
  return detectMcpDuplicates({
    home: os.homedir(), readJson: readMcpJson, listCustom: listRegistrableCustomMcpServers, readToken: readCustomMcpToken,
    workspaceSettingsFiles,
    builtinNames: getBuiltinMcpServerNames,
    readChoices: () => { store.invalidateIfChanged(); return store.read().choices; },
  }, context);
}

async function saveMcpDuplicateChoice(id: string, choice: McpDuplicateChoice | null): Promise<boolean> {
  const owner = activeOwnerScopeKey();
  const report = await listMcpDuplicates();
  const selected = report.connections.find(pair => pair.id === id);
  if (!report.complete || !selected || owner !== activeOwnerScopeKey()) return false;
  // One native connection can overlap multiple Cindy entries (and vice versa).
  // A connected group shares one choice so a second click cannot disable both sides.
  const related = groupMcpDuplicateConnections(report.connections)
    .find(group => group.some(pair => pair.id === id))!;
  await store.updateAtomic(current => {
    if (owner !== activeOwnerScopeKey()) throw new Error('MCP preference owner changed');
    const choices = { ...current.value.choices };
    for (const pair of related) {
      if (choice === null) delete choices[pair.id]; else choices[pair.id] = choice;
    }
    return { choices };
  });
  return true;
}

async function resolveLocalMcpDuplicateChoices(input: { env: NodeJS.ProcessEnv; workingDir: string }) {
  const owner = activeOwnerScopeKey();
  const report = await listMcpDuplicates(input);
  if (owner !== activeOwnerScopeKey()) return { skipHostServers: [], denyNativeServers: [] };
  const choices = resolveMcpDuplicateChoices(report);
  return { ...choices, nativeServersToKeep: [...new Set(report.connections
    .filter(pair => choices.skipHostServers.includes(pair.cindyId)).map(pair => pair.claudeName))] };
}

return { listMcpDuplicates, saveMcpDuplicateChoice, resolveLocalMcpDuplicateChoices };
}
