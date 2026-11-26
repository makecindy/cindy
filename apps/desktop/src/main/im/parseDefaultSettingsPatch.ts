/**
 * IM 默认设置写入 patch 的 IPC 入参解析(白名单)。
 *
 * 从 bootstrap-electron 的 handler 里提出来独立成模块, 只为一件事: 这层白名单
 * **漏一个字段就等于设置项静默失效** —— renderer 乐观改了本地 state, 这里把该键
 * 丢掉, handler 回读存储再把旧值发回去, UI 闪一下又弹回原档, 用户看到的现象是
 * "开关切了没反应", 日志里也不会有任何错误。历史上已经中过两次:
 *   - `agents.pi` 漏解析 → IM 设置页切 Pi 后改模型静默丢弃;
 *   - 群聊权限档(旧名 `groupCtrPermissionMode`)漏解析(#56099425e 只加了
 *     UI + store)→ 飞书「群聊新建任务权限档」切换无效。
 * 所以配套的 parseDefaultSettingsPatch.test.ts 有一条**字段全覆盖**守卫:
 * ImDefaultSettings 新增顶层键而这里没解析时,单测直接红。
 */

import {
  DEFAULT_ACP_IM_AGENT_SETTINGS,
  IM_DEFAULT_SETTINGS,
  isImDefaultAgentKind,
  isImDefaultEffortForAgent,
  isImDefaultPermissionMode,
  type ImDefaultAgentKind,
  type ImDefaultAgentSettings,
  type ImDefaultSettingsPatch,
} from '../../shared/imDefaultSettings.js';
import { pluginEngineKeyFromProviderId } from '../../shared/pluginEngines.js';
import { throwIpcError } from '../utils/ipcValidate.js';

export function parseImDefaultSettingsPatch(raw: unknown): ImDefaultSettingsPatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throwIpcError('INVALID_PARAMS', 'im default settings patch required (object)');
  }
  const input = raw as Record<string, unknown>;
  const patch: ImDefaultSettingsPatch = {};
  if ('agentKind' in input) {
    if (!isImDefaultAgentKind(input.agentKind)) {
      throwIpcError('INVALID_PARAMS', 'im default agentKind invalid');
    }
    patch.agentKind = input.agentKind;
  }
  if ('permissionMode' in input) {
    if (!isImDefaultPermissionMode(input.permissionMode)) {
      throwIpcError('INVALID_PARAMS', 'im default permissionMode invalid');
    }
    patch.permissionMode = input.permissionMode;
  }
  // 飞书「群聊新建任务权限档」(群里新建的会话统一用它)。与 permissionMode 同为
  // 顶层标量键, 必须各自解析 —— 两者语义不同(群 / 私聊), 不能互相顶替。
  if ('groupPermissionMode' in input) {
    if (!isImDefaultPermissionMode(input.groupPermissionMode)) {
      throwIpcError('INVALID_PARAMS', 'im default groupPermissionMode invalid');
    }
    patch.groupPermissionMode = input.groupPermissionMode;
  }
  if ('agents' in input) {
    if (!input.agents || typeof input.agents !== 'object' || Array.isArray(input.agents)) {
      throwIpcError('INVALID_PARAMS', 'im default agents must be object');
    }
    const agentInput = input.agents as Record<string, unknown>;
    const agentsPatch: NonNullable<ImDefaultSettingsPatch['agents']> = {};
    // 所有引擎(含插件引擎 acp)必须对称解析；漏掉任一项会让 IM 设置页改模型静默丢弃。
    for (const kind of ['claude-code', 'codex', 'pi', 'acp'] as const) {
      if (kind in agentInput) {
        agentsPatch[kind] = parseImDefaultAgentSettings(kind, agentInput[kind]);
      }
    }
    patch.agents = agentsPatch;
  }
  if ('providerId' in input || 'model' in input || 'effort' in input) {
    const legacyAgentKind = patch.agentKind ?? IM_DEFAULT_SETTINGS.agentKind;
    patch.agents = {
      ...patch.agents,
      [legacyAgentKind]: parseImDefaultAgentSettings(legacyAgentKind, input),
    };
  }
  return patch;
}

function parseImDefaultAgentSettings(
  agentKind: ImDefaultAgentKind,
  raw: unknown,
): ImDefaultAgentSettings {
  const defaults = agentKind === 'acp' ? DEFAULT_ACP_IM_AGENT_SETTINGS : IM_DEFAULT_SETTINGS.agents[agentKind];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...defaults };
  }
  const input = raw as Record<string, unknown>;
  let providerId = defaults.providerId;
  let agentDeviceId: string | null = null;
  if ('agentDeviceId' in input && input.agentDeviceId !== null) {
    if (typeof input.agentDeviceId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.agentDeviceId)) {
      throwIpcError('INVALID_PARAMS', 'im default agentDeviceId invalid');
    }
    agentDeviceId = input.agentDeviceId.trim();
  }
  let model = defaults.model;
  let effort = defaults.effort;
  if ('providerId' in input) {
    if (input.providerId !== null && typeof input.providerId !== 'string') {
      throwIpcError('INVALID_PARAMS', 'im default providerId must be string or null');
    }
    providerId =
      typeof input.providerId === 'string' && input.providerId.trim()
        ? input.providerId.trim()
        : null;
  }
  if ('model' in input) {
    if (typeof input.model !== 'string' || (input.model.length > 0 && !input.model.trim())) {
      throwIpcError('INVALID_PARAMS', 'im default model required (string)');
    }
    model = input.model.trim();
  }
  if ('effort' in input) {
    if (!isImDefaultEffortForAgent(agentKind, input.effort)) {
      throwIpcError('INVALID_PARAMS', 'im default effort invalid');
    }
    effort = input.effort;
  }
  if (agentKind === 'acp' && (providerId || model)) {
    if (!pluginEngineKeyFromProviderId(providerId)) {
      throwIpcError('INVALID_PARAMS', 'im default plugin engine providerId invalid');
    }
    if (!model) {
      throwIpcError('INVALID_PARAMS', 'im default plugin engine model required');
    }
  }
  if (agentDeviceId && !providerId) throwIpcError('INVALID_PARAMS', 'remote providerId required');
  if (agentDeviceId && !model) throwIpcError('INVALID_PARAMS', 'remote model required');
  return { providerId, model, effort, ...(agentDeviceId ? { agentDeviceId } : {}) };
}
