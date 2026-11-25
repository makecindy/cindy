/**
 * 测试价值
 * - 生产入口与可观察结果：pluginEngineLearnSessionOptions(learn-host/index.ts 为插件引擎任务的 /learn
 *   建蒸馏会话时调用)；用户看到蒸馏任务跑在同一个插件引擎上、权限不超过 acceptEdits，引擎不可用时
 *   本次 /learn 明确失败。
 * - 依据：docs/plans/acp-plugin-bridge.md「/learn、目标模式与溢出续接」(2026-11-25 用户决定)；此前插件
 *   引擎任务的 /learn 一律以 PluginEngineUnsupportedError 失败。
 * - 现有覆盖缺口：controller.test.ts 用假 createSession，index.ts 的会话装配无测试。新模块，单独成文件。
 * - 最小失败输入：来源为插件引擎、来源记录或实时 store 带 acp-plugin 来源的任务。
 * - tier：unit(纯函数 + 真实准入函数，无 I/O)。
 */
import { describe, expect, it } from 'vitest';

import type { PluginEngineView } from '../../../shared/pluginEngines.js';
import { pluginEngineLearnSessionOptions } from '../pluginEngineLearnSession.js';

const PROVIDER = 'acp-plugin:_ns__local__dsh-acp:dsh';
const engine = (availability: PluginEngineView['availability']): PluginEngineView => ({
  key: '_ns__local__dsh-acp:dsh', providerId: PROVIDER, ghostId: '_ns__local__dsh-acp', harnessId: 'dsh',
  name: 'DeepSeek Harness', availability,
  models: [{ id: 'deepseek-v4', displayName: 'DeepSeek-V4-Pro', efforts: ['low', 'high', 'max'], defaultEffort: 'high' }],
  permissionModes: [{ id: 'default', displayName: 'Default' }, { id: 'bypassPermissions', displayName: 'Allow all' }],
  defaultPermissionMode: 'default',
});
const base = { id: 'learn-1', workingDir: '/staging', title: 'Learn: release notes' };

describe('/learn on a plugin engine task', () => {
  it('distils on the same engine with the admitted model, never above acceptEdits', () => {
    expect(pluginEngineLearnSessionOptions({
      ...base,
      origin: { model: 'deepseek-v4', effort: 'max', providerId: PROVIDER },
      inheritedProviderId: null,
      engines: [engine({ state: 'available' })],
    })).toEqual({
      ...base, agentKind: 'acp', providerId: PROVIDER, model: 'deepseek-v4', effort: 'max', permissionMode: 'acceptEdits',
    });
  });

  it.each([
    ['the engine is turned off or removed', { origin: { model: 'deepseek-v4', providerId: PROVIDER }, engines: [] }, '已停用或卸载'],
    ['the engine is unavailable', { origin: { model: 'deepseek-v4', providerId: PROVIDER },
      engines: [engine({ state: 'unavailable', message: 'Install dsh' })] }, '当前不可用'],
    ['the engine runs on another computer', { origin: { model: 'deepseek-v4', providerId: PROVIDER, agentDeviceId: 'device-b' },
      engines: [engine({ state: 'available' })] }, 'not available for tasks running on a plugin engine'],
  ] as const)('fails this /learn, with no built-in fallback, when %s', (_case, input, message) => {
    expect(() => pluginEngineLearnSessionOptions({ ...base, inheritedProviderId: null, ...input })).toThrow(message);
  });
});
