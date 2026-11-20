/**
 * 手机选择 / 使用被控电脑上的插件引擎(Desktop docs/plans/acp-plugin-bridge.md，第二期第二项)。
 *
 * 测试价值
 * - 生产入口与可观察结果：transport 的 listPluginEngines(经 device-link invoke)、sessions:patched 意图
 *   拆分(sessionAgentSwitchIntentPatch，store 入口同一函数)、新建任务的 create-session 参数
 *   (buildRemoteCreateSessionOptions + applyPluginEnginePick)、插件引擎任务的能力视图与选择器分组；
 *   看发出的参数、写进会话的字段与选择器行。
 * - 规则依据：2026-11-19 用户要求手机能正确选到插件引擎；协议兼容规则要求新手机连旧电脑时入口隐藏、
 *   不发 'acp'，旧意图链路看不到 'acp'。
 * - 现有覆盖缺口：手机此前不认识插件引擎：没有引擎列表读取，'acp' 意图被当成 Claude Code 展示，
 *   新建只能发三种内置引擎。
 * - 最小失败输入：旧电脑回 CHANNEL_NOT_ALLOWED 时列表不为空 / 抛错；不带引擎标识的 'acp' 意图被接受；
 *   插件引擎任务的 create 参数仍带内置 agentKind、Fast 或另一台电脑的位置；能力视图带 Fast / 计划模式；
 *   不可用的引擎能被选中。
 * - tier：unit(纯函数与注入 invoke 的 transport，无原生依赖)。
 */
import { describe, expect, it, vi } from 'vitest';

import { sharedTaskHostPeer } from '@cindy/device-link';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { createMobileMakerTransport, type RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { applyPluginEnginePick, buildRemoteCreateSessionOptions, type NewSessionDraft } from '@/session/newSession';
import {
  buildPluginEngineGroups,
  getCachedPluginEngines,
  loadPluginEngines,
  normalizePluginEngines,
  pluginEngineExecutionDeviceId,
  pluginEngineSessionCapabilities,
  setCachedPluginEngines,
  type MobilePluginEngine,
} from '@/session/pluginEngines';
import { sessionAgentSwitchIntentPatch } from '@/session/sessionAgentSwitch';

const DSH = 'acp-plugin:_ns__local__dsh-acp:dsh';
const desktopView = {
  key: '_ns__local__dsh-acp:dsh',
  providerId: DSH,
  ghostId: '_ns__local__dsh-acp',
  harnessId: 'dsh',
  name: 'DeepSeek Harness',
  iconDataUrl: 'data:image/png;base64,AAAA',
  availability: { state: 'available', version: '0.2.2' },
  models: [{ id: 'deepseek-v4', displayName: 'DeepSeek-V4-Pro', efforts: ['low', 'high', 'max'], defaultEffort: 'high' }],
  permissionModes: [
    { id: 'default', displayName: 'Default' },
    { id: 'plan', displayName: 'Plan' },
    { id: 'bypassPermissions', displayName: 'Allow all' },
  ],
  defaultPermissionMode: 'default',
};

describe('reading the engines of the controlled computer', () => {
  it('reads the list over device-link and keeps only well-formed engines', async () => {
    const invoke = vi.fn(async () => [
      desktopView,
      { ...desktopView, providerId: 'anthropic', name: 'Not an engine' },
      { providerId: 'acp-plugin:broken', name: 'No harness id' },
      'garbage',
    ]) as unknown as RemoteInvoke;
    const engines = await createMobileMakerTransport({ deviceId: 'desk', invoke }).listPluginEngines();
    expect(invoke).toHaveBeenCalledWith('desk', 'maker:list-plugin-engines', []);
    expect(engines).toEqual([expect.objectContaining({
      providerId: DSH, name: 'DeepSeek Harness', iconDataUrl: 'data:image/png;base64,AAAA',
      models: [{ id: 'deepseek-v4', displayName: 'DeepSeek-V4-Pro', efforts: ['low', 'high', 'max'], defaultEffort: 'high' }],
      defaultPermissionMode: 'default',
    })]);
  });

  it('reads usage from the named computer only and keeps it out of shared tasks', async () => {
    const data = { updatedAt: 1234, balances: [{ currency: 'USD', amount: '0' }] };
    const invoke = vi.fn(async () => ({ ...data, identity: 'private' })) as unknown as RemoteInvoke;
    const maker = createMobileMakerTransport({ deviceId: 'desk', invoke });
    expect(await maker.getPluginEngineUsage('demo:engine')).toEqual(data);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('desk', 'maker:get-plugin-engine-usage', ['demo:engine']);
    const guest = createMobileMakerTransport({ deviceId: sharedTaskHostPeer('task', 'desk'), invoke });
    expect(await guest.getPluginEngineUsage('demo:engine')).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  // Reopening a menu creates a new transport. The account, computer and engine still own
  // one request until the minute expires; expiry while hidden does not start a refresh.
  it('shares a usage read between menus and expires it without a background invoke', async () => {
    vi.useFakeTimers();
    try {
      const invoke = vi.fn(async () => ({ updatedAt: 1234, balances: [{ currency: 'USD', amount: '0' }] })) as unknown as RemoteInvoke;
      const read = (deviceId = 'menu-desk', key = 'demo:engine') =>
        createMobileMakerTransport({ deviceId, invoke }).getPluginEngineUsage(key);
      const [a, b] = await Promise.all([read(), read()]);
      expect(a).toEqual(b);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(await read()).toEqual(a);
      expect(invoke).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(await read()).toEqual(a);
      expect(invoke).toHaveBeenCalledTimes(2);
      await Promise.all([read('other-desk'), read('menu-desk', 'demo:other')]);
      expect(invoke).toHaveBeenCalledTimes(4);
      setCachedPluginEngines('menu-desk', [], false);
      await read();
      await read('other-desk');
      expect(invoke).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  // Unit, #11563: model discovery previously discarded every menu's pending balance.
  // Keep the reporting engine's reply while rejecting the other engine's old reply after regrant.
  it('preserves a pending balance only for engines that keep reporting it', async () => {
    const device = 'changing-catalogue';
    const second = { ...desktopView, providerId: 'acp-plugin:second:engine' };
    const catalogue = (reportsUsage: boolean) => normalizePluginEngines([
      { ...desktopView, reportsUsage: true }, { ...second, reportsUsage },
    ]);
    const [first, other] = catalogue(true);
    setCachedPluginEngines(device, catalogue(true), true);
    let finish!: (value: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    const invoke = vi.fn(() => pending) as unknown as RemoteInvoke;
    const maker = createMobileMakerTransport({ deviceId: device, invoke });
    const keep = maker.getPluginEngineUsage(first!.key);
    const revoke = maker.getPluginEngineUsage(other!.key);
    await Promise.resolve();
    setCachedPluginEngines(device, catalogue(false), true);
    setCachedPluginEngines(device, catalogue(true), true);
    const balance = { updatedAt: 1234, balances: [{ currency: 'USD', amount: '0' }] };
    finish(balance);
    expect(await Promise.all([keep, revoke])).toEqual([balance, null]);
    expect(await maker.getPluginEngineUsage(first!.key)).toEqual(balance);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('treats an older computer without the channel as having no engines', async () => {
    const invoke = vi.fn(async () => {
      throw Object.assign(new Error('[CHANNEL_NOT_ALLOWED] maker:list-plugin-engines'), { code: 'CHANNEL_NOT_ALLOWED' });
    }) as unknown as RemoteInvoke;
    const maker = createMobileMakerTransport({ deviceId: 'old-desk', invoke });
    await expect(maker.listPluginEngines()).resolves.toEqual([]);
    await expect(maker.refreshPluginEngines()).resolves.toBeUndefined();
    await expect(maker.getPluginEngineUsage("demo:engine")).resolves.toBeNull();
  });

  // Unit, #11563: a failed refresh used to look like a real empty catalogue,
  // hiding a working engine's quota. An actual empty reply still withdraws it.
  it('keeps the last known usage capability through a temporary connection failure', async () => {
    setMobileAuthOwner('catalogue-owner');
    const deviceId = 'interrupted-refresh';
    try {
      const invoke = vi.fn().mockResolvedValueOnce([{ ...desktopView, reportsUsage: true }])
        .mockRejectedValueOnce(new Error('connection unavailable')).mockResolvedValueOnce([]);
      const maker = createMobileMakerTransport({ deviceId, invoke });
      await loadPluginEngines(deviceId, maker);
      await loadPluginEngines(deviceId, maker);
      expect(getCachedPluginEngines(deviceId)[0]?.reportsUsage).toBe(true);
      await loadPluginEngines(deviceId, maker);
      expect(getCachedPluginEngines(deviceId)).toEqual([]);
    } finally {
      setMobileAuthOwner(null);
    }
  });

  // The catalogue may contain private model names and plugin metadata. An old account's
  // unresolved list must neither be reused nor publish into the next account's picker.
  it('discards a late engine list when the mobile account changes', async () => {
    setMobileAuthOwner('older-account');
    const [oldEngine] = normalizePluginEngines([desktopView]);
    let finishOld!: (engines: MobilePluginEngine[]) => void;
    const oldRequest = new Promise<MobilePluginEngine[]>((resolve) => { finishOld = resolve; });
    const refreshPluginEngines = vi.fn(async () => undefined);
    const deviceId = 'same-catalogue-device';
    try {
      const before = loadPluginEngines(deviceId, { listPluginEngines: () => oldRequest, refreshPluginEngines });
      setMobileAuthOwner('current-account');
      const listPluginEngines = vi.fn(async () => []);
      const after = loadPluginEngines(deviceId, { listPluginEngines, refreshPluginEngines });
      finishOld([oldEngine!]);
      await Promise.all([before, after]);
      expect(listPluginEngines).toHaveBeenCalledOnce();
      expect(getCachedPluginEngines(deviceId)).toEqual([]);
    } finally {
      setMobileAuthOwner(null);
    }
  });
});

describe('the pending engine switch the computer projects', () => {
  it('routes a plugin-engine intent to its own field and keeps built-in intents unchanged', () => {
    expect(sessionAgentSwitchIntentPatch({ targetAgentKind: 'acp', model: 'deepseek-v4', providerId: DSH, effort: 'max' }))
      .toEqual({ agentSwitchIntent: null, pluginEngineSwitchIntent: { providerId: DSH, model: 'deepseek-v4', effort: 'max' } });
    expect(sessionAgentSwitchIntentPatch({ targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null }))
      .toEqual({ agentSwitchIntent: { targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null }, pluginEngineSwitchIntent: null });
    // Without the engine identity an 'acp' intent is not an intent at all.
    expect(sessionAgentSwitchIntentPatch({ targetAgentKind: 'acp', model: 'default', providerId: 'openai' }))
      .toEqual({ agentSwitchIntent: null, pluginEngineSwitchIntent: null });
  });

  // The store receives a scoped ACP intent over the existing task patch. The picker must
  // distinguish another computer from an explicit return home or a legacy omitted device.
  it.each([
    [{ agentDeviceId: 'studio' }, 'studio'],
    [{ agentDeviceId: null }, null],
    [{}, 'original'],
  ] as const)('keeps the execution computer for %j', (location, expectedDeviceId) => {
    const { pluginEngineSwitchIntent } = sessionAgentSwitchIntentPatch({
      targetAgentKind: 'acp', model: 'deepseek-v4', providerId: DSH, ...location,
    });
    expect(pluginEngineSwitchIntent).toEqual({ providerId: DSH, model: 'deepseek-v4', ...location });
    expect(pluginEngineExecutionDeviceId('original', pluginEngineSwitchIntent)).toBe(expectedDeviceId);
  });
});

describe('creating a task on a plugin engine', () => {
  const draft: NewSessionDraft = {
    agentKind: 'claude-code', workspaceKind: 'project', workingDir: '/repo', model: 'claude-fable-5',
    providerId: 'xd', effort: 'high', permissionMode: 'bypassPermissions', fastMode: true, firstMessage: 'hi',
    agentDeviceId: 'mac-mini',
  };

  it('sends the engine fields instead of the built-in route, on this computer and without Fast', () => {
    const opts = buildRemoteCreateSessionOptions(applyPluginEnginePick(draft, {
      providerId: DSH, model: 'deepseek-v4', effort: 'max', permissionMode: 'default',
    }));
    expect(opts).toMatchObject({
      agentKind: 'acp', providerId: DSH, model: 'deepseek-v4', effort: 'max', permissionMode: 'default',
      fastMode: false, workspaceKind: 'project', workingDir: '/repo',
    });
    expect(opts).not.toHaveProperty('agentDeviceId');
  });

  it('leaves the built-in options untouched when no engine is picked', () => {
    expect(buildRemoteCreateSessionOptions(applyPluginEnginePick(draft, null))).toMatchObject({
      agentKind: 'claude-code', providerId: 'xd', model: 'claude-fable-5', fastMode: true, agentDeviceId: 'mac-mini',
    });
  });
});

describe('a task running on a plugin engine', () => {
  const [engine] = normalizePluginEngines([desktopView]) as [MobilePluginEngine];
  const labels = { defaultModel: 'Default model', effort: (id: string) => `level:${id}` };

  it('shows the engine models, levels and modes, keeps host switches and has no Fast or plan mode', () => {
    const host = {
      availableModels: [{ id: 'claude-fable-5', label: 'Fable', efforts: ['high'], effortDisplayNames: {}, defaultEffort: 'high', supportsFastMode: true }],
      effortLevels: [], permissionModes: [{ id: 'acceptEdits', label: 'Accept edits' }],
      hasFastMode: true, planModeSupported: true, supportsSessionAgentSwitch: true,
    };
    const caps = pluginEngineSessionCapabilities(host, engine, labels);
    expect(caps).toMatchObject({
      hasFastMode: false, planModeSupported: false, supportsSessionAgentSwitch: true,
      permissionModes: [{ id: 'default' }, { id: 'plan' }, { id: 'bypassPermissions' }],
    });
    expect(caps.availableModels).toEqual([expect.objectContaining({
      id: 'deepseek-v4', label: 'DeepSeek-V4-Pro', efforts: ['low', 'high', 'max'], defaultEffort: 'high', supportsFastMode: false,
    })]);
  });

  // 2026-11-20 用户反馈：只安装了插件但尚未登录/不可用(unavailable)的引擎不在模型选择器里占位；仅当前已选该引擎时保留提示。
  it('omits an unavailable engine unless it is already the active selection', () => {
    const [unavailable] = normalizePluginEngines([{ ...desktopView, providerId: 'acp-plugin:_ns__local__agy:agy',
      name: 'Antigravity', availability: { state: 'unavailable', message: 'Install agy' } }]);
    const groups = buildPluginEngineGroups({ engines: [unavailable!, engine], active: { providerId: DSH, modelId: 'deepseek-v4' } }, '', {
      ...labels,
      unavailable: (name, hint) => `${name} unavailable: ${hint}`,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.rows[0]).toMatchObject({ disabled: false, selected: true, effort: 'high', effortLabel: 'level:high' });

    const activeUnavailable = buildPluginEngineGroups(
      { engines: [unavailable!], active: { providerId: unavailable!.providerId, modelId: 'default' } },
      '',
      { ...labels, unavailable: (name, hint) => `${name} unavailable: ${hint}` },
    );
    expect(activeUnavailable[0]?.rows[0]).toMatchObject({ disabled: true, notice: 'Antigravity unavailable: Install agy', selected: true });
    expect(buildPluginEngineGroups({ engines: [engine], active: null }, 'nothing matches', {
      ...labels, unavailable: () => '',
    })).toEqual([]);
  });
});
