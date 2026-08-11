/** Testable business logic behind the Work Louder Codex Micro settings IPC. */

import {
  isWorkLouderCodexAutoDim,
  type WorkLouderCodexSettings,
  type WorkLouderCodexSettingsPatch,
  type WorkLouderCodexState,
} from '../../shared/workLouderCodex.js';
import { throwIpcError } from '../utils/ipcValidate.js';

const SETTING_KEYS = ['lightingBrightness', 'lightingAutoDim', 'singleTapAgentKeys'] as const;

export interface WorkLouderCodexSettingsIpcDeps {
  assertTrustedSender(event: unknown): void;
  getState(): WorkLouderCodexState;
  writeSettings(patch: WorkLouderCodexSettingsPatch): WorkLouderCodexSettings;
  applySettings(settings: WorkLouderCodexSettings): void;
}

function parseSettingsPatch(value: unknown): WorkLouderCodexSettingsPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwIpcError('INVALID_PARAMS', 'Work Louder Codex settings patch required');
  }
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter(
    (key) => !(SETTING_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) {
    throwIpcError('INVALID_PARAMS', `unknown Work Louder Codex setting: ${unknownKeys[0]}`);
  }
  if (Object.keys(record).length === 0) {
    throwIpcError('INVALID_PARAMS', 'Work Louder Codex settings patch cannot be empty');
  }

  const patch: WorkLouderCodexSettingsPatch = {};
  if ('lightingBrightness' in record) {
    const brightness = record.lightingBrightness;
    if (
      typeof brightness !== 'number' ||
      !Number.isInteger(brightness) ||
      brightness < 0 ||
      brightness > 100
    ) {
      throwIpcError('INVALID_PARAMS', 'lightingBrightness must be an integer from 0 to 100');
    }
    patch.lightingBrightness = brightness;
  }
  if ('lightingAutoDim' in record) {
    if (!isWorkLouderCodexAutoDim(record.lightingAutoDim)) {
      throwIpcError('INVALID_PARAMS', 'lightingAutoDim is invalid');
    }
    patch.lightingAutoDim = record.lightingAutoDim;
  }
  if ('singleTapAgentKeys' in record) {
    if (typeof record.singleTapAgentKeys !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'singleTapAgentKeys must be a boolean');
    }
    patch.singleTapAgentKeys = record.singleTapAgentKeys;
  }
  return patch;
}

export function createWorkLouderCodexSettingsIpc(deps: WorkLouderCodexSettingsIpcDeps) {
  return {
    get(event: unknown): WorkLouderCodexState {
      deps.assertTrustedSender(event);
      return deps.getState();
    },

    set(event: unknown, value: unknown): WorkLouderCodexState {
      deps.assertTrustedSender(event);
      const patch = parseSettingsPatch(value);
      let settings: WorkLouderCodexSettings;
      try {
        settings = deps.writeSettings(patch);
      } catch {
        throwIpcError('INTERNAL', 'Work Louder Codex settings write failed');
      }
      deps.applySettings(settings);
      return deps.getState();
    },
  };
}

export const __testing = { parseSettingsPatch };
