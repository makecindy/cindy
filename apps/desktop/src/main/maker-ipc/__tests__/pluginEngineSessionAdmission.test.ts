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
 * - 2026-11-22 补(插件引擎进入「设置 → 模型供应商」)：用户在那里停用的引擎、关掉的模型不能再开新任务或换过去，
 *   其余模型与「默认模型」照常；规则依据 configuration-and-overrides.md「停用是准入，隐藏不是」。
 *   最小失败输入：停用后仍放行；关掉的模型仍放行；只关一个模型却把整个引擎拒掉。
 * - tier：unit(纯函数，引擎列表由调用方传入)。
 */
import { describe, expect, it } from 'vitest';
import { providerShareGuestPeer, sharedTaskGuestPeer } from '@cindy/device-link';
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
    ['a raw provider-share wire peer', body({ agentDeviceId: providerShareGuestPeer('s1', 'm1', 'd1') }), [harness({ state: 'available' })], '无效的插件引擎运行位置'],
    ['a shared-task peer', body({ agentDeviceId: sharedTaskGuestPeer('t1', 'm1', 'd1') }), [harness({ state: 'available' })], '无效的插件引擎运行位置'],
    ['an SSH host', body({ remoteHostId: 'host-1' }), [harness({ state: 'available' })], '不能在 SSH 工作区里运行'],
  ] as const)('refuses with a reason when %s', (_label, input, harnesses, message) => {
    expect(() => admitPluginEngineSession(input, harnesses)).toThrow(message);
  });

  // 引擎可以是自己账号另一台电脑上的，也可以是朋友分享过来的(`share:<id>`)；使用端免装插件，不按本机引擎列表拒绝
  // (执行电脑是否开放 remoteWorkspace / guestWorkspace 由执行电脑在任务启动时核对)。
  // 最小失败输入：本机没有任何插件引擎、agentDeviceId 指向另一台电脑或 `share:6f1c`。
  it('refuses an engine the user turned off and a model they turned off, and nothing else', () => {
    const available = [harness({ state: 'available' })];
    expect(() => admitWith(body(), available, () => models, () => ({ suspended: true })))
      .toThrow('DeepSeek Harness 已在「设置 → 模型供应商」中停用');
    const oneModelOff = () => ({ disabledModels: ['deepseek-v4'] });
    expect(() => admitWith(body({ model: 'deepseek-v4' }), available, () => models, oneModelOff))
      .toThrow('DeepSeek Harness 的这个模型已在「设置 → 模型供应商」中关闭');
    expect(() => admitWith(body({ model: 'default' }), available, () => models, oneModelOff)).toThrow('关闭');
    expect(admitWith(body({ model: 'no-levels' }), available, () => models, oneModelOff).model).toBe('no-levels');
    expect(() => admitWith(body(), available, () => models, oneModelOff)).toThrow('关闭');
    // Nothing set: the same result as before these settings existed.
    expect(admitWith(body({ model: 'deepseek-v4', effort: 'max' }), available, () => models, () => ({})))
      .toEqual(admitPluginEngineSession(body({ model: 'deepseek-v4', effort: 'max' }), available));
  });

  // A provider taken out of an engine is a provider of its own (review of #12242). Minimal input: it
  // is turned off, or one of its models is, while the engine itself is on.
  it('checks a provider taken out of an engine against its own settings', () => {
    const available = [harness({ state: 'available' })];
    const taken = 'acp-plugin:_ns__local__dsh-acp:dsh~ab12cd34';
    const own = (patch: { suspended?: boolean; disabledModels?: string[] }) =>
      (provider: { key: string }) => provider.key.endsWith('~ab12cd34') ? patch : {};
    expect(() => admitWith(body({ providerId: taken }), available, () => models, own({ suspended: true }))).toThrow('停用');
    expect(admitWith(body(), available, () => models, own({ suspended: true })).providerId).toBe('acp-plugin:_ns__local__dsh-acp:dsh');
    const modelOff = own({ disabledModels: ['deepseek-v4'] });
    expect(() => admitWith(body({ providerId: taken, model: 'deepseek-v4' }), available, () => models, modelOff)).toThrow('关闭');
    expect(admitWith(body({ model: 'deepseek-v4' }), available, () => models, modelOff).model).toBe('deepseek-v4');
  });

  it.each(['mac-mini', 'share:6f1c'])('admits an engine of %s without needing the plugin installed here', (agentDeviceId) => {
    expect(admitPluginEngineSession(body({ agentDeviceId, model: '', effort: 'high', fastMode: true }), [])).toMatchObject({
      agentKind: 'acp',
      providerId: 'acp-plugin:_ns__local__dsh-acp:dsh',
      agentDeviceId,
      model: 'default',
      effort: 'high',
      fastMode: false,
    });
    expect(admitPluginEngineSession(body({ agentDeviceId, effort: 'turbo' }), []).effort).toBe('');
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

  // The engine list main builds reports a turned-off engine as unavailable and keeps the models
  // the user turned off apart from `models` (pluginEnginesIpc); admission says which of the two it was.
  it('refuses an engine the user turned off and a model they turned off, and nothing else', () => {
    const suspended: PluginEngineView = {
      ...view({ state: 'unavailable', reason: 'suspended' }), suspended: true,
    };
    expect(() => admitPluginEngineSwitchTarget(target(), [suspended]))
      .toThrow('DeepSeek Harness 已在「设置 → 模型供应商」中停用');
    const oneModelOff: PluginEngineView = {
      ...view({ state: 'available' }), models: [models[1]!], disabledModels: [models[0]!],
    };
    expect(() => admitPluginEngineSwitchTarget(target(), [oneModelOff]))
      .toThrow('DeepSeek Harness 的这个模型已在「设置 → 模型供应商」中关闭');
    expect(admitPluginEngineSwitchTarget(target({ model: 'no-levels' }), [oneModelOff]).model).toBe('no-levels');
    expect(admitPluginEngineSwitchTarget(target({ model: 'default' }), [oneModelOff]).model).toBe('default');
  });
});
