import path from 'node:path';
import { ipcMain } from 'electron';

import {
  MAX_CLAUDE_CODE_CUSTOM_PATH_LENGTH,
  normalizeClaudeCodeRuntimeSettings,
  type ClaudeCodeRuntimeSettings,
  type ClaudeCodeRuntimeSettingsState,
} from '../../shared/claudeCodeRuntimeSettings.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import { getClaudeCodeRuntimeDecision } from '../agent-binaries/index.js';
import { resolveSystemClaudeCode } from '../agent-binaries/system-claude-code.js';
import {
  readClaudeCodeRuntimeSettingsState,
  resetClaudeCodeRuntimeSettings,
  writeClaudeCodeRuntimeSettings,
} from '../claude-code-runtime-settings-store.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireEnum, requireObject, throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';

const log = createLogger('maker-ipc:claude-code-runtime-settings');

function parseSettings(raw: unknown): ClaudeCodeRuntimeSettings {
  const input = requireObject(raw);
  const source = requireEnum(input.source, ['managed', 'system'] as const, 'source');
  if (typeof input.customPath !== 'string') {
    throwIpcError('INVALID_PARAMS', 'customPath must be a string');
  }
  const customPath = input.customPath.trim();
  if (customPath.length > MAX_CLAUDE_CODE_CUSTOM_PATH_LENGTH) {
    throwIpcError('INVALID_PARAMS', 'customPath is too long');
  }
  if (customPath && !path.isAbsolute(customPath)) {
    throwIpcError('INVALID_PARAMS', 'customPath must be absolute');
  }
  return normalizeClaudeCodeRuntimeSettings({ source, customPath });
}

function settingsWire(): ClaudeCodeRuntimeSettingsState {
  const state = readClaudeCodeRuntimeSettingsState();
  const decision = getClaudeCodeRuntimeDecision();
  const selectedPath =
    state.value.source === 'system' && state.value.customPath
      ? path.resolve(state.value.customPath)
      : null;
  const requestedPathChanged =
    decision?.requestedSource === 'system' && selectedPath !== decision.requestedPath;
  return {
    value: state.value,
    isCustomized: state.isCustomized,
    decision,
    restartRequired: Boolean(
      decision && (decision.requestedSource !== state.value.source || requestedPathChanged),
    ),
  };
}

export function registerClaudeCodeRuntimeSettingsIpc(): void {
  ipcMain.handle(MAKER_INVOKE.CLAUDE_CODE_RUNTIME_SETTINGS_GET, (event) => {
    assertTrustedAppRendererEvent(event);
    return settingsWire();
  });

  ipcMain.handle(MAKER_INVOKE.CLAUDE_CODE_RUNTIME_SETTINGS_SET, async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    try {
      await writeClaudeCodeRuntimeSettings(parseSettings(raw));
      return settingsWire();
    } catch (error) {
      if (isIpcError(error)) throw error;
      log.warn('failed to save Claude Code runtime settings');
      throwIpcError('INTERNAL', 'Failed to save Claude Code runtime settings');
    }
  });

  ipcMain.handle(MAKER_INVOKE.CLAUDE_CODE_RUNTIME_SETTINGS_RESET, async (event) => {
    assertTrustedAppRendererEvent(event);
    try {
      await resetClaudeCodeRuntimeSettings();
      return settingsWire();
    } catch {
      log.warn('failed to reset Claude Code runtime settings');
      throwIpcError('INTERNAL', 'Failed to reset Claude Code runtime settings');
    }
  });

  ipcMain.handle(MAKER_INVOKE.CLAUDE_CODE_RUNTIME_PROBE, async (event, rawPath: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof rawPath !== 'string') {
      throwIpcError('INVALID_PARAMS', 'customPath must be a string');
    }
    const customPath = rawPath.trim();
    if (customPath.length > MAX_CLAUDE_CODE_CUSTOM_PATH_LENGTH) {
      throwIpcError('INVALID_PARAMS', 'customPath is too long');
    }
    if (customPath && !path.isAbsolute(customPath)) {
      throwIpcError('INVALID_PARAMS', 'customPath must be absolute');
    }
    return resolveSystemClaudeCode(customPath);
  });
}
