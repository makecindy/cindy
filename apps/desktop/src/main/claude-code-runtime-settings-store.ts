import path from 'node:path';
import { app } from 'electron';

import {
  DEFAULT_CLAUDE_CODE_RUNTIME_SETTINGS,
  normalizeClaudeCodeRuntimeSettings,
  type ClaudeCodeRuntimeSettings,
} from '../shared/claudeCodeRuntimeSettings.js';
import { desktopMakerLogger } from './maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './maker-host/override-settings-file.js';

const log = desktopMakerLogger.child('claude-code-runtime-settings-store');

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'claude-code-runtime-settings.json');
}

const store = createOverrideSettingsFile<ClaudeCodeRuntimeSettings>({
  filePath: settingsFilePath,
  defaults: DEFAULT_CLAUDE_CODE_RUNTIME_SETTINGS,
  normalize: normalizeClaudeCodeRuntimeSettings,
  log,
  label: 'claude-code-runtime',
  maxBytes: 16 * 1024,
  preserveUnreadableFile: true,
  logLoadedValue: false,
  logReadErrorDetails: false,
});

export function readClaudeCodeRuntimeSettings(): ClaudeCodeRuntimeSettings {
  store.invalidateIfChanged();
  return store.read();
}

export function readClaudeCodeRuntimeSettingsState(): OverrideSettingsState<ClaudeCodeRuntimeSettings> {
  store.invalidateIfChanged();
  return store.readState();
}

export async function writeClaudeCodeRuntimeSettings(
  settings: ClaudeCodeRuntimeSettings,
): Promise<ClaudeCodeRuntimeSettings> {
  await store.writePatchAtomic(settings);
  return readClaudeCodeRuntimeSettings();
}

export async function resetClaudeCodeRuntimeSettings(): Promise<ClaudeCodeRuntimeSettings> {
  return store.resetAtomic();
}

export const __testing = { settingsFilePath };
