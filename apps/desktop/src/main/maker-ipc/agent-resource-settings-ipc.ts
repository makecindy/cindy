/**
 * agent-resource-settings IPC 业务体 —— 与 ipcMain adapter 分离,依赖可注入,
 * 免 Electron 直测三类路径:sender 可信校验、逐 key 运行时校验、存储失败转
 * INTERNAL(engineering-conventions §3:main 侧业务逻辑默认带测试)。
 *
 * register.ts 只做 adapter:ipcMain.handle(channel, (e, body) => ipc.xxx(e, body))。
 */

import {
  MAX_CONCURRENT_COMMANDS_CAP,
  type AgentResourceSettings,
} from '../maker-host/agent-resource-settings-store.js';
import type { OverrideSettingsState } from '../maker-host/override-settings-file.js';
import { throwIpcError } from '../utils/ipcValidate.js';

const AGENT_RESOURCE_SETTING_KEYS = [
  'maxConcurrentCommands',
  'processPriority',
  'capToolchainThreads',
] as const;
export type AgentResourceSettingKey = (typeof AGENT_RESOURCE_SETTING_KEYS)[number];
const AGENT_RESOURCE_PRIORITIES = ['normal', 'low', 'lowest'] as const;

export interface AgentResourceSettingsIpcDeps {
  /** 校验事件来自可信应用 renderer;不可信时抛错。写路径会持久改变 agent 行为,属特权 IPC。 */
  assertTrustedSender: (event: unknown) => void;
  readState: () => OverrideSettingsState<AgentResourceSettings>;
  write: (
    key: keyof AgentResourceSettings,
    value: AgentResourceSettings[keyof AgentResourceSettings],
  ) => void;
  reset: () => AgentResourceSettings;
}

function isAgentResourceSettingKey(key: unknown): key is AgentResourceSettingKey {
  return typeof key === 'string'
    && (AGENT_RESOURCE_SETTING_KEYS as readonly string[]).includes(key);
}

/** store 层 clamp 容错读盘;IPC 写路径按惯例硬拒非法值(INVALID_PARAMS)。 */
function validateAgentResourceSettingValue(
  key: AgentResourceSettingKey,
  value: unknown,
): AgentResourceSettings[AgentResourceSettingKey] {
  if (key === 'maxConcurrentCommands') {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      throwIpcError('INVALID_PARAMS', `${key} must be an integer`);
    }
    if (value < 0) throwIpcError('INVALID_PARAMS', `${key} must be >= 0`);
    if (value > MAX_CONCURRENT_COMMANDS_CAP) {
      throwIpcError('INVALID_PARAMS', `${key} must be <= ${MAX_CONCURRENT_COMMANDS_CAP}`);
    }
    return value;
  }
  if (key === 'processPriority') {
    if (typeof value !== 'string'
      || !(AGENT_RESOURCE_PRIORITIES as readonly string[]).includes(value)) {
      throwIpcError('INVALID_PARAMS', `${key} must be one of ${AGENT_RESOURCE_PRIORITIES.join('/')}`);
    }
    return value as AgentResourceSettings['processPriority'];
  }
  if (typeof value !== 'boolean') {
    throwIpcError('INVALID_PARAMS', `${key} must be a boolean`);
  }
  return value;
}

export function createAgentResourceSettingsIpc(deps: AgentResourceSettingsIpcDeps) {
  const wire = () => {
    const state = deps.readState();
    return {
      ...state.value,
      isCustomized: state.isCustomized,
      customizedKeys: state.customizedKeys,
      defaults: state.defaults,
    };
  };

  return {
    get(event: unknown) {
      deps.assertTrustedSender(event);
      return wire();
    },

    set(event: unknown, body: unknown) {
      deps.assertTrustedSender(event);
      const b = body as Record<string, unknown> | null | undefined;
      if (!b || typeof b.key !== 'string') throwIpcError('INVALID_PARAMS', 'key required');
      if (!isAgentResourceSettingKey(b.key)) {
        throwIpcError('INVALID_PARAMS', `unknown key: ${b.key}`);
      }
      const value = validateAgentResourceSettingValue(b.key, b.value);
      try {
        deps.write(b.key, value);
      } catch {
        // 落盘失败(只读目录/磁盘满等):按 IPC 错误协议包装,不把原始 fs 异常
        // (含内部绝对路径)透给 renderer。
        throwIpcError('INTERNAL', 'agent resource settings write failed');
      }
      return wire();
    },

    reset(event: unknown) {
      deps.assertTrustedSender(event);
      try {
        deps.reset();
      } catch {
        throwIpcError('INTERNAL', 'agent resource settings reset failed');
      }
      return wire();
    },
  };
}
