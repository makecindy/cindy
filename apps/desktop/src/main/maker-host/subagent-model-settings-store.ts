/**
 * Claude / Codex 子代理模型覆盖的 main 进程事实源。
 *
 * 文件：<userData>/subagent-model-settings.json。默认值为 null，表示完全沿用 agent 原生逻辑。
 */

import {
  SUBAGENT_MODEL_SETTINGS_DEFAULTS,
  normalizeSubagentModelId,
  type SubagentModelSettings,
  type SubagentModelSettingsPatch,
} from '../../shared/subagentModelSettings.js';
import { desktopMakerLogger } from './logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from './override-settings-file.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';

const log = desktopMakerLogger.child('subagent-model-settings-store');

function settingsFilePath(): string {
  return ownerScopedUserDataPath('subagent-model-settings.json');
}

function normalize(raw: unknown): SubagentModelSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...SUBAGENT_MODEL_SETTINGS_DEFAULTS };
  }
  const input = raw as Record<string, unknown>;
  return {
    claudeCode: normalizeSubagentModelId(input.claudeCode),
    claudeCodeProviderId: normalizeSubagentModelId(input.claudeCodeProviderId),
    codex: normalizeSubagentModelId(input.codex),
    codexProviderId: normalizeSubagentModelId(input.codexProviderId),
  };
}

const store = createOverrideSettingsFile<SubagentModelSettings>({
  filePath: settingsFilePath,
  defaults: SUBAGENT_MODEL_SETTINGS_DEFAULTS,
  normalize,
  log,
  label: 'subagent model',
});

/** 每次新建 agent 会话时读取；外部手改设置文件也能在下一会话生效。 */
export function readSubagentModelSettings(): SubagentModelSettings {
  store.invalidateIfChanged();
  return store.read();
}

export function readSubagentModelSettingsState(): OverrideSettingsState<SubagentModelSettings> {
  store.invalidateIfChanged();
  return store.readState();
}

export function writeSubagentModelSettingsPatch(patch: SubagentModelSettingsPatch): void {
  store.writePatch(patch);
  log.info('subagent model settings written', {
    customizedKeys: store.readState().customizedKeys,
  });
}

export function resetSubagentModelSettings(): SubagentModelSettings {
  return store.reset();
}

export const __testing = { normalize };
