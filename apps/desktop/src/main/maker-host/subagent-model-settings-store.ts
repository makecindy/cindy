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
  const claudeCode = normalizeSubagentModelId(input.claudeCode);
  const codex = normalizeSubagentModelId(input.codex);
  return {
    claudeCode,
    // 磁盘直读同样执行配对不变量:模型未指定时来源无所依附,外部手改文件留下的
    // 孤儿 providerId 会让 isCustomized 误报「已自定义」却显示「不指定」(codex review)。
    claudeCodeProviderId:
      claudeCode === null ? null : normalizeSubagentModelId(input.claudeCodeProviderId),
    codex,
    codexProviderId: codex === null ? null : normalizeSubagentModelId(input.codexProviderId),
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
