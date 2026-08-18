import {
  isCodexSubagentDefaultPatchSupported,
  isCodexSubagentEffort,
  isValidCodexSubagentConcurrencyInput,
  isValidSubagentModelIdInput,
  normalizeSubagentModelId,
  type SubagentModelSettingsPatch,
} from '../../shared/subagentModelSettings.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** 解析 Subagent 设置 patch（白名单键，逐字段校验；非法抛 INVALID_PARAMS）。 */
export function parseSubagentModelSettingsPatch(raw: unknown): SubagentModelSettingsPatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throwIpcError('INVALID_PARAMS', 'subagent model settings patch required (object)');
  }
  const input = raw as Record<string, unknown>;
  const patch: SubagentModelSettingsPatch = {};
  // providerId 与 model id 同约束（短标识串），共用同一套校验/归一化。
  for (const key of ['claudeCode', 'claudeCodeProviderId', 'codex', 'codexProviderId'] as const) {
    if (!(key in input)) continue;
    const value = input[key];
    if (!isValidSubagentModelIdInput(value)) {
      throwIpcError('INVALID_PARAMS', `subagent model ${key} must be a valid string or null`);
    }
    patch[key] = normalizeSubagentModelId(value);
  }
  // 护栏/effort 字段类型各异（enum / boolean / number|null），逐字段分支校验。
  if ('codexEffort' in input) {
    if (input.codexEffort !== null && !isCodexSubagentEffort(input.codexEffort)) {
      throwIpcError('INVALID_PARAMS', 'subagent codexEffort must be a known effort or null');
    }
    patch.codexEffort = input.codexEffort as SubagentModelSettingsPatch['codexEffort'];
  }
  if ('codexSubagentsEnabled' in input) {
    if (typeof input.codexSubagentsEnabled !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'subagent codexSubagentsEnabled must be boolean');
    }
    patch.codexSubagentsEnabled = input.codexSubagentsEnabled;
  }
  if ('codexUseCindySubagentPolicy' in input) {
    if (typeof input.codexUseCindySubagentPolicy !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'subagent codexUseCindySubagentPolicy must be boolean');
    }
    patch.codexUseCindySubagentPolicy = input.codexUseCindySubagentPolicy;
  }
  if ('codexMaxConcurrentSubagents' in input) {
    if (!isValidCodexSubagentConcurrencyInput(input.codexMaxConcurrentSubagents)) {
      throwIpcError(
        'INVALID_PARAMS',
        'subagent codexMaxConcurrentSubagents must be an integer in range or null',
      );
    }
    patch.codexMaxConcurrentSubagents = input.codexMaxConcurrentSubagents;
  }
  if ('codexAllowNestedSubagents' in input) {
    if (typeof input.codexAllowNestedSubagents !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'subagent codexAllowNestedSubagents must be boolean');
    }
    patch.codexAllowNestedSubagents = input.codexAllowNestedSubagents;
  }
  if (!isCodexSubagentDefaultPatchSupported(patch)) {
    throwIpcError(
      'INVALID_PARAMS',
      'explicit Codex subagent defaults are unavailable; use null to follow Codex native selection',
    );
  }
  return patch;
}
