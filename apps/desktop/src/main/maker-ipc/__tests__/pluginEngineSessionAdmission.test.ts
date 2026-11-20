/**
 * Opening a task on a plugin engine (docs/plans/acp-plugin-bridge.md).
 *
 * 测试价值
 * - 生产入口与可观察结果：Desktop 的任务开启准入(register.ts 的 setSessionOpeningModelAdmission)对
 *   `agent_kind = 'acp'` 调用的 admitPluginEngineSession；看准入后写进任务行的字段与拒绝原因。
 * - 规则依据：设计「任务记录」「第一期明确不支持」与「第三期：自己的其他电脑使用」：引擎是本机此刻提供的，
 *   或自己账号另一台电脑上的；SSH 与别人分享的供应商不行；不回落到内置引擎。
 * - 现有覆盖缺口：2026-11-18 实机新建插件引擎任务被内置模型目录拒绝(「Agent acp 当前不可用」)，
 *   此前没有任何测试走到这一步。
 * - 最小失败输入：可用引擎 + model 'default' 被拒；不可用 / 已卸载 / 指向另一台电脑的引擎被放行。
 * - tier：unit(纯函数，引擎列表由调用方传入)。
 */
import { describe, expect, it } from 'vitest';
import type { PluginHarness } from '../../cindy-brain/pluginHarnesses.js';
import type { SessionOpenBody } from '../../localDb/sessionOpening.js';
import { admitPluginEngineSession as admitWith, admitPluginEngineSwitchTarget } from '../pluginEngineSessionAdmission.js';
import type { PluginEngineModel, PluginEngineView } from '../../../shared/pluginEngines.js';

// DSH 的 reasoning_effort 是 off / low / high / max(2026-11-19 实测)；Cindy 只认 low / high / max。
const models: PluginEngineModel[] = [
  { id: 'deepseek-v4', displayName: 'DeepSeek-V4-Pro', efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  { id: 'no-levels', displayName: 'No levels' },
];
const admitPluginEngineSession = (input: SessionOpenBody, harnesses: readonly PluginHarness[]) =>
  admitWith(input, harnesses, () => models);

const harness = (availability: PluginHarness['availability']): PluginHarness => ({
  key: '_ns__local__dsh-acp:dsh',
  ghostId: '_ns__local__dsh-acp',
  harnessId: 'dsh',
  name: 'DeepSeek Harness',
  protocol: 'acp',
  availability,
});
const body = (extra: Partial<SessionOpenBody> = {}): SessionOpenBody => ({
  // 与 createUserSession 一样：渲染端的 'acp' 经类型断言进入只列内置引擎的存储 body。
  agentKind: 'acp' as unknown as SessionOpenBody['agentKind'],
  providerId: 'acp-plugin:_ns__local__dsh-acp:dsh',
  model: 'default',
  effort: '',
  permissionMode: 'ask',
  fastMode: false,
  workspaceKind: 'dialogue',
  ...extra,
});

describe('opening a task on a plugin engine', () => {
  it.each([
    ['available', { state: 'available', version: '0.2.2-rc.1' }],
    ['never reported', { state: 'unknown' }],
  ] as const)('admits an engine this computer offers (%s) and keeps the engine’s own model', (_label, availability) => {
    expect(admitPluginEngineSession(body({ effort: 'high', fastMode: true }), [harness(availability)])).toMatchObject({
      agentKind: 'acp',
      providerId: 'acp-plugin:_ns__local__dsh-acp:dsh',
      model: 'default',
      effort: '',
      fastMode: false,
      workspaceKind: 'dialogue',
    });
    expect(admitPluginEngineSession(body({ model: ' ' }), [harness(availability)]).model).toBe('default');
    expect(admitPluginEngineSession(body({ model: 'deepseek-v4' }), [harness(availability)]).model).toBe('deepseek-v4');
    expect(admitPluginEngineSession(body({ model: ' deepseek-v4 ' }), [harness(availability)]).model).toBe(' deepseek-v4 ');
  });

  // 2026-11-19 用户要求插件引擎可选思考深度：只保留该模型列出的档位，其余交给引擎自己的默认。
  it('keeps a reasoning level only when the engine lists it for the chosen model', () => {
    const available = [harness({ state: 'available' })];
    expect(admitPluginEngineSession(body({ model: 'deepseek-v4', effort: 'max' }), available).effort).toBe('max');
    expect(admitPluginEngineSession(body({ model: 'deepseek-v4', effort: 'medium' }), available).effort).toBe('');
    expect(admitPluginEngineSession(body({ model: 'no-levels', effort: 'high' }), available).effort).toBe('');
    expect(admitPluginEngineSession(body({ model: 'default', effort: 'high' }), available).effort).toBe('');
  });

  it.each([
    ['the plugin reports it unavailable', body(), [harness({ state: 'unavailable', message: 'Run npm i -g @deepseek-ai/dsh' })],
      'DeepSeek Harness 当前不可用：Run npm i -g @deepseek-ai/dsh'],
    ['the plugin was turned off or removed', body(), [], '提供这个引擎的插件已停用或卸载'],
    ['no engine id', body({ providerId: 'anthropic' }), [harness({ state: 'available' })], '缺少引擎标识'],
    ['a provider someone shared', body({ agentDeviceId: 'share:6f1c' }), [harness({ state: 'available' })], '不提供插件引擎'],
    ['an SSH host', body({ remoteHostId: 'host-1' }), [harness({ state: 'available' })], '不能在 SSH 工作区里运行'],
  ] as const)('refuses with a reason when %s', (_label, input, harnesses, message) => {
    expect(() => admitPluginEngineSession(input, harnesses)).toThrow(message);
  });

  // 第三期(2026-11-20)：引擎可以是自己账号另一台电脑上的。这台不必装这个插件，所以不按本机的引擎列表拒绝
  // (那台是否开放它，由那台在任务启动时核对)；分享来的供应商不是自己的电脑，上面的用例仍然拒绝。
  // 最小失败输入：本机没有任何插件引擎、agentDeviceId 指向自己的另一台电脑。
  it('admits an engine of another computer of the same account without needing the plugin here', () => {
    expect(admitPluginEngineSession(body({ agentDeviceId: 'mac-mini', model: '', effort: 'high', fastMode: true }), [])).toMatchObject({
      agentKind: 'acp',
      providerId: 'acp-plugin:_ns__local__dsh-acp:dsh',
      agentDeviceId: 'mac-mini',
      model: 'default',
      effort: 'high',
      fastMode: false,
    });
    expect(admitPluginEngineSession(body({ agentDeviceId: 'mac-mini', effort: 'turbo' }), []).effort).toBe('');
  });
});

// Phase 2 (2026-11-19): an existing task switching onto the engine follows the same rules, and its
// permission mode is narrowed to what the engine offers (Full access only if the task had it).
describe('switching an existing task onto a plugin engine', () => {
  const view = (availability: PluginEngineView['availability']): PluginEngineView => ({
    key: '_ns__local__dsh-acp:dsh', providerId: 'acp-plugin:_ns__local__dsh-acp:dsh',
    ghostId: '_ns__local__dsh-acp', harnessId: 'dsh', name: 'DeepSeek Harness', availability, models,
    permissionModes: [{ id: 'default', displayName: 'Default' }, { id: 'plan', displayName: 'Plan' },
      { id: 'bypassPermissions', displayName: 'Allow all' }],
    defaultPermissionMode: 'default',
  });
  const target = (extra: Partial<Parameters<typeof admitPluginEngineSwitchTarget>[0]> = {}) => ({
    providerId: 'acp-plugin:_ns__local__dsh-acp:dsh', model: 'deepseek-v4', ...extra,
  });

  it('keeps an offered mode, else the mode a new task on the engine starts in', () => {
    const engines = [view({ state: 'available' })];
    expect(admitPluginEngineSwitchTarget(target({ permissionMode: 'bypassPermissions' }), engines).permissionMode)
      .toBe('bypassPermissions');
    expect(admitPluginEngineSwitchTarget(target({ permissionMode: 'plan' }), engines).permissionMode).toBe('plan');
    expect(admitPluginEngineSwitchTarget(target({ permissionMode: 'acceptEdits' }), engines).permissionMode).toBe('default');
    expect(admitPluginEngineSwitchTarget(target({ permissionMode: 'ask' }), engines).permissionMode).toBe('default');
  });

  it('keeps only a listed reasoning level and names the engine', () => {
    const engines = [view({ state: 'available' })];
    expect(admitPluginEngineSwitchTarget(target({ effort: 'max' }), engines)).toMatchObject({
      model: 'deepseek-v4', effort: 'max', engineName: 'DeepSeek Harness',
    });
    expect(admitPluginEngineSwitchTarget(target({ effort: 'xhigh' }), engines).effort).toBe('');
    expect(admitPluginEngineSwitchTarget(target({ model: ' ' }), engines).model).toBe('default');
    expect(admitPluginEngineSwitchTarget(target({ model: ' deepseek-v4 ' }), engines).model).toBe(' deepseek-v4 ');
  });

  it.each([
    ['turned off or removed', [], '提供这个引擎的插件已停用或卸载'],
    ['reported unavailable', [view({ state: 'unavailable', message: 'Run npm i -g @deepseek-ai/dsh' })],
      'DeepSeek Harness 当前不可用：Run npm i -g @deepseek-ai/dsh'],
  ] as const)('refuses an engine that is %s', (_label, engines, message) => {
    expect(() => admitPluginEngineSwitchTarget(target(), engines)).toThrow(message);
  });
});
