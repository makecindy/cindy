// @vitest-environment jsdom
/**
 * Plugin engines in the model picker (docs/plans/acp-plugin-bridge.md).
 *
 * 测试价值
 * - 生产入口与可观察结果：真实的 ModelSelectorContent / ModelSelector 与草稿层的
 *   resolveActivePluginEngine + pluginEngineSessionCreateFields；用户看到的分组、禁用行与提示、
 *   trigger 上的引擎名，以及交给 local-db sessions:create 的引擎字段。
 * - 规则依据：acp-plugin-bridge 设计「模型选择器」与「硬约束：不影响内置 Agent」；未装插件时选择器不变。
 * - 现有覆盖缺口：PluginModelsSection / unifiedModelPanelRendering 只覆盖插件模型与内置目录，
 *   没有引擎分组、不可用引擎与 'acp' 任务的 trigger。
 * - 最小失败输入：不传 pluginEngines 仍出现分组；不可用引擎可选；选中后不是 agentKind 'acp' 或
 *   没有已知模型时不是 'default'；'acp' 任务的 trigger 写成内置 Harness 名。
 * - 2026-11-19 补：插件引擎的思考深度(行尾档位、配置浮层滑杆、建任务带档、任务内换档)；最小失败输入：
 *   行尾不显示档位、滑杆改档不回调、建任务丢档或带上模型不提供的档。
 * - PR #11549：同名引擎装在不同电脑，各自使用各自的模型目录；退出账号后旧回包不更新当前选择器。
 * - 2026-11-20 补(第三期：自己其他电脑上开了「允许被远程调用」的引擎)：同一个插件装在两台电脑时引擎标识相同，
 *   靠所在电脑区分。最小失败输入：选了另一台的引擎却点亮／解析成本机同名引擎；建任务时丢了那台电脑；
 *   那台没开开关或报告不可用的引擎仍被列出。
 * - tier：unit(jsdom，渲染真实组件，外部 hook 用内存替身)。
 */
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/contexts/AuthContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/contexts/AuthContext')>()),
  useOptionalAuthUser: () => null,
  useOptionalAuthDeviceId: () => null,
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    i18n: { language: 'en', resolvedLanguage: 'en' },
    t: (key: string, options?: Record<string, string | number>) => {
      const o = options ?? {};
      const table: Record<string, string> = {
        'newChat.modelSelector.modelListAria': 'Models',
        'newChat.modelSelector.search.placeholderAll': 'Search models',
        'newChat.modelSelector.unified.railAll': 'All',
        'newChat.modelSelector.unified.railRemoteProvider': `${o.provider} · ${o.device}`,
        'newChat.modelSelector.trigger.aria': `Select model. Current: ${o.model}`,
        'newChat.modelSelector.trigger.agent.claudeCode': 'Claude Code',
        'newChat.modelSelector.trigger.unresolved': 'Model details unavailable',
        'newChat.pluginEngines.group': 'Plugin engines',
        'newChat.pluginEngines.genericName': 'Plugin engine',
        'newChat.pluginEngines.defaultModel': 'Default model',
        'newChat.pluginEngines.defaultModelHint': 'Uses the engine’s own default',
        'newChat.pluginEngines.unavailable': 'Unavailable',
        'newChat.pluginEngines.engineMissing': 'The plugin that provides this engine is turned off or uninstalled.',
      };
      return table[key] ?? (o.defaultValue as string | undefined) ?? key;
    },
  }),
}));

vi.mock('@/lib/scrollbarAutoHide', () => ({ flashScrollbar: vi.fn() }));
vi.mock('@/hooks/useAgentCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAgentCapabilities')>()),
  evictDeviceCapabilities: vi.fn(),
  prefetchDeviceCapabilities: vi.fn(async () => {}),
  useAgentCapabilities: () => ({
    capabilities: { hasFastMode: false, effortLevels: [], availableModels: [] },
    loading: false,
    error: null,
  }),
}));
vi.mock('@/hooks/useApiKey', () => ({ useApiKey: () => ({ hasSavedKey: true }) }));
vi.mock('@/hooks/useConnectedSource', () => ({
  useConnectedSource: () => ({ hasConnectedSource: true, loading: false }),
}));
vi.mock('@/hooks/useModelPricing', () => ({
  useGatewayModelPricing: () => null,
  useReferenceModelPricing: () => null,
}));
const catalog = vi.hoisted(() => [{
  id: 'anthropic',
  name: 'Anthropic',
  source: 'builtin',
  agents: ['claude-code'],
  auth: { method: 'oauth' },
  routing: { 'claude-code': {} },
  connected: true,
  models: {
    'claude-code': [{ id: 'claude-opus-5', name: 'Opus 5', contextWindow: 200000, efforts: ['high'], defaultEffort: 'high' }],
  },
}]);
vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: catalog, providerOrder: [] }),
}));
vi.mock('@/hooks/useDeviceProviders', () => ({
  evictDeviceProviders: vi.fn(),
  prefetchDeviceProviders: vi.fn(async () => {}),
  useDeviceProviders: () => ({ providers: [], loading: false, error: null, unsupported: false }),
}));
vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: () => true,
  useModelVisibilityVersion: () => 0,
}));
vi.mock('@/state/deviceLinkModelMirror', () => ({ useDeviceLinkModelMirrorVersion: () => 0 }));
vi.mock('@/hooks/useDevicesProviders', () => {
  const directories = new Map();
  return { useDevicesProviders: () => directories };
});

import { ModelSelector, ModelSelectorContent } from '../ModelSelector';
import { PermissionSelector } from '../PermissionSelector';
import {
  PLUGIN_ENGINE_DEFAULT_MODEL,
  controlledPluginEngineSources,
  pluginEnginePermissionMode,
  pluginEngineSessionCreateFields,
  remotePluginEngineChoices,
  resolveActivePluginEngine,
  resolvePluginEngineSessionSwitchEffort,
} from '@/lib/pluginEngineSelection';
import { engineIconKindOf } from '@/components/sidebar/VendorIcon';
import { getDataOwnerGeneration, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import {
  DEVICE_PLUGIN_ENGINES_REFRESH_MS,
  DEVICE_PLUGIN_ENGINES_REFRESH_REREAD_MS,
  DEVICE_PLUGIN_ENGINES_REREAD_MS,
  findPluginEngine,
  hasRemotePluginEngineSubscribers,
  markRemotePluginEnginesStale,
  resetPluginEnginesStoreForTests,
  useDevicesPluginEngines,
  usePluginEngineIdentity,
  useRemotePluginEngines,
} from '@/hooks/usePluginEngines';
import { PLUGIN_ENGINES_INVOKE, type PluginEngineView } from '../../../../shared/pluginEngines';
import { createIpcError } from '../../../../shared/ipc-errors';

const modes: PluginEngineView['permissionModes'] = [
  { id: 'ask', displayName: 'Ask' },
  { id: 'bypassPermissions', displayName: 'Allow all' },
];
const engine = (key: string, name: string, extra: Partial<PluginEngineView> = {}): PluginEngineView => ({
  key,
  providerId: `acp-plugin:${key}`,
  ghostId: key.split(':')[0]!,
  harnessId: key.split(':')[1]!,
  name,
  availability: { state: 'available' },
  models: [],
  permissionModes: modes,
  defaultPermissionMode: 'ask',
  ...extra,
});
const DSH_ICON = 'data:image/png;base64,iVBORw0KGgo=';
const dsh = engine('dsh-plugin:dsh', 'DeepSeek Harness', { iconDataUrl: DSH_ICON });
const gemini = engine('gemini-plugin:gemini', 'Gemini CLI', {
  availability: { state: 'unavailable', reason: 'not-installed', message: 'Install with npm i -g gemini-cli' },
});
const known = engine('oc-plugin:opencode', 'OpenCode', {
  availability: { state: 'unknown' },
  models: [{ id: 'oc-large', displayName: 'OC Large' }, { id: 'oc-small', displayName: 'OC Small' }],
});
// DSH 2026-11-19 实测的 reasoning_effort 是 off / low / high / max；插件只上报 Cindy 认得的档位。
const leveled = engine('dsh-plugin:dsh', 'DeepSeek Harness', {
  models: [
    { id: 'pro', displayName: 'Pro', efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
    { id: 'flash', displayName: 'Flash', efforts: ['low', 'high'], defaultEffort: 'low' },
    { id: 'plain', displayName: 'Plain' },
  ],
});
// Antigravity(agy 1.5.12)公布 default / accept-edits / auto / plan；main 的引擎视图按 Agent 的顺序列出，末尾是「全部允许」。
const agy = engine('agy-plugin:agy', 'Antigravity', {
  permissionModes: [
    { id: 'default', displayName: 'Default' }, { id: 'acceptEdits', displayName: 'Accept edits' },
    { id: 'auto', displayName: 'Auto' }, { id: 'plan', displayName: 'Plan' },
    { id: 'bypassPermissions', displayName: 'Full access' },
  ],
  defaultPermissionMode: 'default',
});
const levelOf = (row: HTMLElement) => row.querySelector('[data-plugin-engine-effort]')?.getAttribute('data-plugin-engine-effort') ?? null;

function renderDraftPicker(pluginEngines?: React.ComponentProps<typeof ModelSelectorContent>['pluginEngines']) {
  return render(
    React.createElement(ModelSelectorContent, {
      modelId: 'claude-opus-5',
      effort: 'high',
      onModelChange: vi.fn(),
      onEffortChange: vi.fn(),
      currentProviderId: 'anthropic',
      onProviderChange: vi.fn(),
      onUnifiedSelect: vi.fn(),
      vendorKey: 'cc',
      remoteAgent: undefined,
      ...(pluginEngines ? { pluginEngines } : {}),
    }),
  );
}

afterEach(() => {
  cleanup();
});

it('reads the selected computer once and discards a former account’s directory reply', async () => {
  const before = getDataOwnerGeneration();
  const onFirstComputer = { ...leveled, models: [{ id: 'first', displayName: 'First computer model' }] };
  const onSecondComputer = { ...leveled, models: [{ id: 'second', displayName: 'Second computer model' }] };
  const onCurrentAccount = { ...leveled, models: [{ id: 'current', displayName: 'Current account model' }] };
  let deliverOldReply!: (result: PluginEngineView[]) => void;
  const delayedReply = new Promise<PluginEngineView[]>((resolve) => { deliverOldReply = resolve; });
  const invoke = vi.fn()
    .mockResolvedValueOnce([onFirstComputer])
    .mockReturnValueOnce(delayedReply)
    .mockResolvedValueOnce([onCurrentAccount]);
  const listPluginEngines = vi.fn(async () => [leveled]);
  vi.stubGlobal('electronAPI', { deviceLink: { invoke }, maker: { listPluginEngines } });
  setDataOwnerGeneration('account-a');
  try {
    const picker = renderHook(({ deviceId }) => {
      const catalogue = useRemotePluginEngines(deviceId, true);
      return {
        read: catalogue.read,
        engine: findPluginEngine(catalogue.engines ?? [], leveled.providerId),
      };
    }, { initialProps: { deviceId: 'computer-a' } });
    await act(async () => { picker.result.current.read(); });
    expect(picker.result.current.engine).toEqual(onFirstComputer);
    expect(invoke.mock.calls).toEqual([['computer-a', PLUGIN_ENGINES_INVOKE.LIST, []]]);
    expect(listPluginEngines).not.toHaveBeenCalled();

    picker.rerender({ deviceId: 'computer-b' });
    await act(async () => { picker.result.current.read(); });
    expect(picker.result.current.engine).toBeNull();
    expect(invoke).toHaveBeenNthCalledWith(2, 'computer-b', PLUGIN_ENGINES_INVOKE.LIST, []);

    setDataOwnerGeneration('account-b');
    picker.rerender({ deviceId: 'computer-b' });
    await act(async () => { deliverOldReply([onSecondComputer]); });
    expect(picker.result.current.engine).toEqual(onCurrentAccount);
    expect(invoke).toHaveBeenCalledTimes(3);
  } finally {
    cleanup();
    vi.unstubAllGlobals();
    setDataOwnerGeneration(before.dataOwnerId, before.generation);
    resetPluginEnginesStoreForTests();
  }
});

// 生产入口与可观察结果：useRemotePluginEngines(deviceId, 'once') 与 refresh()；被控电脑草稿／会话先加载一次引擎目录，
// 打开模型选择器时经 maker:refresh-plugin-engines 请被控电脑插件重报模型，并在 2.5s 后复读出完整模型列表。
// 规则依据：acp-plugin-bridge 远程控制电脑模型刷新(对端 plugin-engines-changed 只推本机窗口，控制端须触发 refresh 后复读)
// 与 server-channel-review 冷却门禁(60s 内重复开面板不连发 refresh；断线重连 markStale 后允许立即重刷)。
// 覆盖缺口：此前 Desktop 控制端从未调用 maker:refresh-plugin-engines，被控电脑未在本机打开过面板时永远只有「默认模型」。
// 最小失败输入与 tier：unit；被控电脑初始 models=[]，打开面板调用 refresh() 后不触发 REFRESH 或 2.5s 后仍为空模型列表。
it('asks the controlled computer to republish plugin engine models on picker refresh and re-reads once after cooldown', async () => {
  vi.useFakeTimers();
  const initialDsh = engine('dsh-plugin:dsh', 'DeepSeek Harness', { models: [] });
  const publishedDsh = engine('dsh-plugin:dsh', 'DeepSeek Harness', {
    models: [{ id: 'deepseek-v4', displayName: 'DeepSeek V4', efforts: ['low', 'high'], defaultEffort: 'high' }],
  });
  let remoteModelsPublished = false;
  const invoke = vi.fn(async (_deviceId: string, channel: string) => {
    if (channel === PLUGIN_ENGINES_INVOKE.REFRESH) {
      remoteModelsPublished = true;
      return undefined;
    }
    if (channel === PLUGIN_ENGINES_INVOKE.LIST) {
      return [remoteModelsPublished ? publishedDsh : initialDsh];
    }
    return undefined;
  });
  vi.stubGlobal('electronAPI', { deviceLink: { invoke } });
  try {
    const first = renderHook(() => useRemotePluginEngines('computer-b', 'once'));
    await act(async () => { await Promise.resolve(); });
    expect(first.result.current.engines).toEqual([initialDsh]);
    expect(invoke.mock.calls).toEqual([['computer-b', PLUGIN_ENGINES_INVOKE.LIST, []]]);

    // Entering a second task on the same controlled computer reuses the loaded catalogue.
    const second = renderHook(() => useRemotePluginEngines('computer-b', 'once'));
    await act(async () => { await Promise.resolve(); });
    expect(second.result.current.engines).toEqual([initialDsh]);
    expect(invoke).toHaveBeenCalledTimes(1);

    // Opening the model picker reuses the fresh snapshot (<15s), triggers REFRESH once,
    // and re-reads published models once at 2.5s.
    await act(async () => {
      first.result.current.refresh();
      await Promise.resolve();
    });
    expect(invoke.mock.calls).toEqual([
      ['computer-b', PLUGIN_ENGINES_INVOKE.LIST, []],
      ['computer-b', PLUGIN_ENGINES_INVOKE.REFRESH, []],
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEVICE_PLUGIN_ENGINES_REFRESH_REREAD_MS);
    });
    expect(first.result.current.engines).toEqual([publishedDsh]);
    expect(invoke).toHaveBeenCalledTimes(3);

    // Re-opening immediately within the 15s read window and 60s refresh cooldown makes zero extra calls.
    await act(async () => {
      first.result.current.refresh();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(DEVICE_PLUGIN_ENGINES_REFRESH_REREAD_MS);
    });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls.filter((call) => call[1] === PLUGIN_ENGINES_INVOKE.REFRESH)).toHaveLength(1);

    // After the controlled computer reconnects (markStale), refresh re-reads LIST and asks REFRESH again.
    markRemotePluginEnginesStale('computer-b');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEVICE_PLUGIN_ENGINES_REFRESH_MS);
      first.result.current.refresh();
      await Promise.resolve();
    });
    expect(invoke.mock.calls.filter((call) => call[1] === PLUGIN_ENGINES_INVOKE.REFRESH)).toHaveLength(2);

    // Leaving or hiding the picker view cancels the pending 2.5s re-read even while sidebar rows remain mounted.
    const sidebarRow = renderHook(() => usePluginEngineIdentity(publishedDsh.providerId, 'computer-b'));
    const callsBeforeLeave = invoke.mock.calls.length;
    first.unmount();
    second.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEVICE_PLUGIN_ENGINES_REFRESH_REREAD_MS);
    });
    expect(invoke.mock.calls).toHaveLength(callsBeforeLeave);
    sidebarRow.unmount();
  } finally {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetPluginEnginesStoreForTests();
  }
});

// 生产入口与可观察结果：useRemotePluginEngines 空初始目录复读 + resolvePluginEngineSessionSwitchEffort；
// 被控电脑初始无引擎时后续重开面板仍可发现新装插件，跨插件引擎切换模型使用目标模型默认档位而非旧引擎档位。
// 规则依据：server-channel-review(15s 冷却后可重新读取空目录、离开页面后在途 refresh 不再安排定时器)与模型选择器行展示一致性。
// 覆盖缺口：此前空目录未保留远程读取或离开后在途 refresh 仍挂定时器，且跨插件引擎切换误带入旧引擎的 high 档位。
// 最小失败输入与 tier：unit；在途 refresh 返回前卸载视图仍触发延迟 LIST，或引擎 A(high)切到引擎 B(默认 low)提交了 high。
it('discovers newly enabled remote engines after an initially empty list, stops in-flight refresh on leave, and keeps cross-engine default effort', async () => {
  vi.useFakeTimers();
  const newlyEnabled = engine('agy-plugin:agy', 'Antigravity', { models: [] });
  const newlyPublished = engine('agy-plugin:agy', 'Antigravity', {
    models: [{ id: 'gemini-3-pro', displayName: 'Gemini 3 Pro', efforts: ['low', 'high'], defaultEffort: 'low' }],
  });
  let hasEngineOnPeer = false;
  let modelsPublishedOnPeer = false;
  let finishRefresh!: () => void;
  const invoke = vi.fn((_deviceId: string, channel: string) => {
    if (channel === PLUGIN_ENGINES_INVOKE.LIST) {
      if (!hasEngineOnPeer) return Promise.resolve([]);
      return Promise.resolve([modelsPublishedOnPeer ? newlyPublished : newlyEnabled]);
    }
    if (channel === PLUGIN_ENGINES_INVOKE.REFRESH) {
      return new Promise<void>((resolve) => {
        finishRefresh = () => {
          modelsPublishedOnPeer = true;
          resolve();
        };
      });
    }
    return Promise.resolve(undefined);
  });
  vi.stubGlobal('electronAPI', { deviceLink: { invoke } });
  try {
    const draft = renderHook(
      ({ active }) => useRemotePluginEngines('computer-b', 'once', active),
      { initialProps: { active: true } },
    );
    await act(async () => { await Promise.resolve(); });
    expect(draft.result.current.engines).toEqual([]);

    // User installs/enables a plugin on computer B and opens the picker after the 15s read cooldown.
    hasEngineOnPeer = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEVICE_PLUGIN_ENGINES_REREAD_MS);
      draft.result.current.refresh();
      await Promise.resolve();
    });
    expect(draft.result.current.engines).toEqual([newlyEnabled]);
    expect(invoke.mock.calls.filter((call) => call[1] === PLUGIN_ENGINES_INVOKE.REFRESH)).toHaveLength(1);

    // Leaving before the in-flight REFRESH resolves prevents scheduling a delayed LIST download while away.
    const callsWhenLeaving = invoke.mock.calls.length;
    draft.rerender({ active: false });
    await act(async () => {
      finishRefresh();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(DEVICE_PLUGIN_ENGINES_REFRESH_REREAD_MS);
    });
    expect(invoke.mock.calls).toHaveLength(callsWhenLeaving);

    // Returning within the 15s/60s cooldown completes the owed post-REFRESH LIST read once without re-sending REFRESH.
    draft.rerender({ active: true });
    await act(async () => { await Promise.resolve(); });
    expect(draft.result.current.engines).toEqual([newlyPublished]);
    expect(invoke.mock.calls).toHaveLength(callsWhenLeaving + 1);
    expect(invoke.mock.calls.filter((call) => call[1] === PLUGIN_ENGINES_INVOKE.REFRESH)).toHaveLength(1);

    // Same plugin engine carries over explicit 'high'; switching to a different plugin engine uses its own 'low' default.
    expect(
      resolvePluginEngineSessionSwitchEffort(
        { providerId: newlyPublished.providerId, modelId: 'gemini-3-pro' },
        newlyPublished,
        { providerId: newlyPublished.providerId, effort: 'high' },
      ),
    ).toBe('high');
    expect(
      resolvePluginEngineSessionSwitchEffort(
        { providerId: newlyPublished.providerId, modelId: 'gemini-3-pro' },
        newlyPublished,
        { providerId: 'acp-plugin:dsh-plugin:dsh', effort: 'high' },
      ),
    ).toBe('low');
  } finally {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetPluginEnginesStoreForTests();
  }
});

describe('plugin engines in the new-task picker', () => {
  it.each([
    ['no engine installed', undefined, []],
    ['only an unauthenticated/unavailable engine installed', [gemini], []],
    ['engines installed', [dsh, gemini, known], ['DeepSeek Harness', 'OpenCode']],
  ] as const)('shows the 「插件引擎」 group and rail tabs only for usable engines (%s)', (_label, engines, expectedNames) => {
    renderDraftPicker(engines ? { engines, active: null, onSelect: vi.fn() } : undefined);
    expect(screen.getByText('Opus 5')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Plugin engines' }) !== null).toBe(expectedNames.length > 0);
    for (const name of ['DeepSeek Harness', 'Gemini CLI', 'OpenCode']) {
      expect(screen.queryByRole('button', { name }) !== null).toBe((expectedNames as readonly string[]).includes(name));
    }
  });

  // 2026-11-18 实机：停在某个供应商格时看不到插件引擎；随后要求和供应商一样每个引擎一格、用插件图标。
  it('gives each engine its own rail tab with the plugin icon, listing only that engine', () => {
    const onSelect = vi.fn();
    renderDraftPicker({ engines: [dsh, gemini, known], active: null, onSelect });
    // 只看可见的模型列表；面板另有一份不可见的测宽副本。
    const list = () => screen.getByRole('listbox', { name: 'Models' });
    fireEvent.click(screen.getByRole('button', { name: 'Anthropic' }));
    expect(within(list()).queryByRole('group', { name: 'Plugin engines' })).toBeNull();
    expect(within(list()).getByText('Opus 5')).toBeTruthy();

    const dshTab = screen.getByRole('button', { name: 'DeepSeek Harness' });
    expect(dshTab.querySelector('img')?.getAttribute('src')).toBe(DSH_ICON);
    // An engine whose plugin has no icon keeps the generic mark.
    expect(screen.getByRole('button', { name: 'OpenCode' }).querySelector('img')).toBeNull();

    fireEvent.click(dshTab);
    expect(screen.getByRole('button', { name: 'DeepSeek Harness' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(list()).queryByText('Opus 5')).toBeNull();
    expect(within(list()).queryByRole('group', { name: 'OpenCode' })).toBeNull();
    fireEvent.click(within(within(list()).getByRole('group', { name: 'DeepSeek Harness' })).getByRole('option'));
    expect(onSelect).toHaveBeenCalledWith({ providerId: dsh.providerId, modelId: PLUGIN_ENGINE_DEFAULT_MODEL });
  });

  // 2026-11-20 实机反馈：本机只安装了插件但尚未登录(unavailable)时不应在模型列表冗余占位；仅已选中的当前任务引擎保留状态提示。
  it('hides unavailable engines from the picker unless one is already the active task choice, and selects the engine default', () => {
    const onSelect = vi.fn();
    const view = renderDraftPicker({ engines: [dsh, gemini, known], active: null, onSelect });
    const group = screen.getByRole('group', { name: 'Plugin engines' });

    // Unavailable and not active: completely omitted from both the rail and the model list.
    expect(within(group).queryByRole('group', { name: 'Gemini CLI' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Gemini CLI' })).toBeNull();

    // 'unknown' is selectable and offers its last-seen models instead of a default entry. Like a
    // built-in row, each row shows the model name and a source line (the engine).
    const ocGroup = within(group).getByRole('group', { name: 'OpenCode' });
    expect(within(ocGroup).getAllByRole('option').map((row) => row.textContent)).toEqual(['OC LargeOpenCode', 'OC SmallOpenCode']);
    // Without a plugin icon the rows keep the generic engine mark (no image).
    expect(ocGroup.querySelector('img')).toBeNull();

    // No models known yet: a single default entry, marked with the providing plugin's own icon.
    const dshGroup = within(group).getByRole('group', { name: 'DeepSeek Harness' });
    expect(dshGroup.querySelector('[role="option"] img')?.getAttribute('src')).toBe(DSH_ICON);
    fireEvent.click(within(dshGroup).getByRole('option', { name: /Default model/ }));
    expect(onSelect).toHaveBeenCalledWith({ providerId: 'acp-plugin:dsh-plugin:dsh', modelId: PLUGIN_ENGINE_DEFAULT_MODEL });

    // Already-active task engine that later became unavailable stays visible with its disabled hint.
    view.unmount();
    renderDraftPicker({
      engines: [gemini],
      active: { providerId: gemini.providerId, modelId: PLUGIN_ENGINE_DEFAULT_MODEL },
      onSelect,
    });
    const activeGeminiGroup = within(screen.getByRole('group', { name: 'Plugin engines' })).getByRole('group', { name: 'Gemini CLI' });
    expect(within(activeGeminiGroup).getByText('Install with npm i -g gemini-cli')).toBeTruthy();
    const geminiRow = within(activeGeminiGroup).getByRole('option');
    expect(geminiRow.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(geminiRow);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  // 2026-11-22(插件引擎进入「设置 → 模型供应商」)：用户在那里隐藏的引擎不在选择器里占位，已选着它的任务照常显示；
  // 另一台电脑把自己的引擎隐藏，是那台电脑选择器的事，开放给本机任务用的那一份照常列出。
  // 依据：configuration-and-overrides.md「隐藏只改陈列」。最小失败输入：隐藏的引擎仍占一格；当前任务选着的引擎被
  // 隐藏后从选择器里消失；主人隐藏后借用方也看不到。tier：unit(jsdom)。
  it('keeps an engine the user hid out of the picker, except for the task already on it or a borrowing computer', () => {
    const hiddenDsh = { ...dsh, hidden: true as const };
    const view = renderDraftPicker({ engines: [hiddenDsh, known], active: null, onSelect: vi.fn() });
    expect(screen.queryByRole('button', { name: 'DeepSeek Harness' })).toBeNull();
    expect(screen.getByRole('button', { name: 'OpenCode' })).toBeTruthy();
    view.unmount();

    const active = renderDraftPicker({
      engines: [hiddenDsh, known],
      active: { providerId: dsh.providerId, modelId: PLUGIN_ENGINE_DEFAULT_MODEL },
      onSelect: vi.fn(),
    });
    expect(screen.getByRole('button', { name: 'DeepSeek Harness' })).toBeTruthy();
    active.unmount();

    const borrowed = remotePluginEngineChoices(
      [{ deviceId: 'computer-b', name: 'Studio Mac' }],
      new Map([['computer-b', [{ ...hiddenDsh, remoteUse: { supported: true, enabled: true } }]]]),
      (id, name) => name ?? id,
    );
    expect(borrowed).toHaveLength(1);
    expect(borrowed[0]).not.toHaveProperty('hidden');
    renderDraftPicker({ engines: borrowed, active: null, onSelect: vi.fn() });
    expect(screen.getByRole('button', { name: 'DeepSeek Harness · Studio Mac' })).toBeTruthy();
  });

  // 第三期(2026-11-20)：自己另一台电脑上的引擎。同一个插件两台都装时 providerId 相同，只有所在电脑不同。
  it('lists an engine of another computer under that computer and keeps it apart from this computer’s engine of the same plugin', () => {
    const onSelect = vi.fn();
    const onStudio = { ...dsh, deviceId: 'computer-b', deviceName: 'Studio Mac', remoteUse: { supported: true, enabled: true } };
    renderDraftPicker({
      engines: [dsh, onStudio],
      active: { providerId: dsh.providerId, deviceId: 'computer-b', modelId: PLUGIN_ENGINE_DEFAULT_MODEL },
      onSelect,
    });
    const list = screen.getByRole('listbox', { name: 'Models' });
    const here = within(list).getByRole('group', { name: 'DeepSeek Harness' });
    const there = within(list).getByRole('group', { name: 'DeepSeek Harness · Studio Mac' });
    // Only the engine on the other computer is the current choice.
    expect(within(there).getByRole('option').getAttribute('aria-selected')).toBe('true');
    expect(within(here).getByRole('option').getAttribute('aria-selected')).not.toBe('true');
    // Each has its own rail tab; the other computer's one is marked as remote.
    expect(screen.getByRole('button', { name: 'DeepSeek Harness' }).querySelector('[data-remote-source-mark]')).toBeNull();
    expect(screen.getByRole('button', { name: 'DeepSeek Harness · Studio Mac' }).querySelector('[data-remote-source-mark]')).not.toBeNull();

    fireEvent.click(within(here).getByRole('option'));
    expect(onSelect).toHaveBeenLastCalledWith({ providerId: dsh.providerId, modelId: PLUGIN_ENGINE_DEFAULT_MODEL });
    fireEvent.click(within(there).getByRole('option'));
    expect(onSelect).toHaveBeenLastCalledWith({ providerId: dsh.providerId, modelId: PLUGIN_ENGINE_DEFAULT_MODEL, deviceId: 'computer-b' });
  });

  // 生产入口与可观察结果：ModelSelector 触发器展开统一模型面板时才调用 pluginEngines.readCatalogue，关闭态不预读。
  // Bug／规则依据：ModelSelector 直接渲染 ModelSelectorContentView 而跳过了 ModelSelectorContent，导致伙伴/新任务打开选择器时未触发插件重报模型与远端电脑引擎读取。
  // 现有覆盖缺口：此前单测直接裸渲染 ModelSelectorContent，未经过 ModelSelector 弹层挂载路径。
  // 最小失败输入与 tier：unit（jsdom），渲染关闭态 ModelSelector 后点击触发器打开统一面板。
  it('refreshes the plugin engine catalogue when opening ModelSelector, not while closed', async () => {
    const readCatalogue = vi.fn();
    render(
      React.createElement(ModelSelector, {
        modelId: 'claude-opus-5',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        currentProviderId: 'anthropic',
        onProviderChange: vi.fn(),
        onUnifiedSelect: vi.fn(),
        vendorKey: 'cc',
        remoteAgent: undefined,
        triggerVariant: 'settings',
        unifiedPanel: true,
        pluginEngines: { engines: [dsh], active: null, onSelect: vi.fn(), readCatalogue },
      }),
    );
    expect(readCatalogue).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(await screen.findByRole('listbox', { name: 'Models' })).toBeTruthy();
    expect(readCatalogue).toHaveBeenCalledTimes(1);
  });

  // Unified selector §1.2: clicking an offered remote engine waits for host admission before
  // closing. A slower failure leaves the same list available for a retry (jsdom unit).
  it('keeps the picker open while a remote choice is pending or fails, then closes on success', async () => {
    let finish!: (accepted: boolean) => void;
    const onSelect = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(true);
    const remote = { ...dsh, deviceId: 'studio', deviceName: 'Studio' };
    render(
      React.createElement(ModelSelector, {
        modelId: 'claude-opus-5',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        currentProviderId: 'anthropic',
        onProviderChange: vi.fn(),
        onUnifiedSelect: vi.fn(),
        vendorKey: 'cc',
        remoteAgent: undefined,
        triggerVariant: 'settings',
        unifiedPanel: true,
        pluginEngines: { engines: [remote], active: null, onSelect, readCatalogue: vi.fn() },
      }),
    );
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    const group = () => screen.getByRole('group', { name: 'DeepSeek Harness · Studio' });
    const row = () => within(group()).getByRole('option', { name: /Default model/ });
    fireEvent.click(row());
    fireEvent.click(row());
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith({ providerId: remote.providerId, modelId: 'default', deviceId: 'studio' });
    await act(async () => { finish(false); });
    expect(group()).toBeTruthy();
    await act(async () => { fireEvent.click(row()); });
    expect(screen.queryByRole('group', { name: 'DeepSeek Harness · Studio' })).toBeNull();
  });

  // The reconnect hook uses hasRemotePluginEngineSubscribers to decide whether a device needs an
  // automatic list. A mounted picker candidate reads only when opened (engineering §8.3, unit).
  it('loads remote picker candidates on demand without registering them for reconnect prefetch', async () => {
    const deviceId = 'picker-candidate';
    const invoke = vi.fn(async () => [dsh]);
    vi.stubGlobal('electronAPI', { deviceLink: { invoke } });
    try {
      const picker = renderHook(() => useDevicesPluginEngines([deviceId]));
      expect(hasRemotePluginEngineSubscribers(deviceId)).toBe(false);
      expect(invoke).not.toHaveBeenCalled();
      await act(async () => { picker.result.current.read(); });
      expect(picker.result.current.catalogues.get(deviceId)).toEqual([dsh]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // 2026-11-23 用户反馈：A 远控 B 新建任务时看不到 B 收到的插件供应商分享(内置供应商分享可以)。
  // 生产入口与可观察结果：controlledPluginEngineSources + useDevicesPluginEngines + remotePluginEngineChoices；
  // B 名单里的同账号电脑与插件供应商分享成为候选，列表经 B 的 maker:model-catalog:read 读取，选中后 Agent 在那个来源运行；
  // 内置供应商分享不列，旧版 B 拒绝代读时只是不列出。最小失败输入与 tier：unit(jsdom)，B 名单含插件分享 share:p。
  it('offers the engines of the task computer’s sources under remote control, read through that computer', async () => {
    const shared = { ...engine('dsh-acp:dsh', 'DeepSeek Harness'), remoteUse: { supported: true, shareSupported: true, enabled: true } };
    const sources = controlledPluginEngineSources('device-b', [
      { deviceId: 'device-a', name: 'Studio' },
      { deviceId: 'share:p', name: 'DSH · Magi', favoriteSource: { providerId: shared.providerId } },
      { deviceId: 'share:builtin', name: 'Anthropic · Magi', favoriteSource: { providerId: 'anthropic' } },
    ], (id) => (id === 'share:p' ? '来自 Magi 的分享' : null));
    expect(sources.map((source) => [source.deviceId, source.name])).toEqual([['device-a', 'Studio'], ['share:p', '来自 Magi 的分享']]);
    // The task computer has not listed its sources (older computer, or not read yet): nothing extra is offered.
    expect(controlledPluginEngineSources(undefined, [{ deviceId: 'device-a', name: 'Studio' }], () => null)).toEqual([]);
    const invoke = vi.fn(async (host: string, channel: string, args: unknown[]) => {
      if (host !== 'device-b' || channel !== 'maker:model-catalog:read') throw new Error('read outside the task computer');
      if ((args[0] as { agentDeviceId?: string }).agentDeviceId === 'device-a') {
        throw createIpcError('INVALID_PARAMS', 'Invalid model catalog read');
      }
      return [shared];
    });
    vi.stubGlobal('electronAPI', { deviceLink: { invoke } });
    try {
      const picker = renderHook(() => useDevicesPluginEngines(sources.map((source) => source.catalogueKey!)));
      await act(async () => { picker.result.current.read(); });
      const choices = remotePluginEngineChoices(sources, picker.result.current.catalogues, (id, name) => name ?? id);
      expect(choices.map((choice) => [choice.providerId, choice.deviceId, choice.deviceName]))
        .toEqual([[shared.providerId, 'share:p', '来自 Magi 的分享']]);
      expect(pluginEngineSessionCreateFields(resolveActivePluginEngine(choices, {
        providerId: shared.providerId, deviceId: 'share:p', modelId: PLUGIN_ENGINE_DEFAULT_MODEL,
      })!)).toMatchObject({ providerId: shared.providerId, agentDeviceId: 'share:p' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Browsing the task computer from a remote plugin engine must explicitly relocate when a
  // local built-in model is selected, even when the panel starts by showing the task computer.
  it('returns to the task computer when selecting a local model from an active remote engine', async () => {
    const onRelocate = vi.fn(async () => true);
    const remote = { ...dsh, deviceId: 'studio', deviceName: 'Studio' };
    render(
      React.createElement(ModelSelectorContent, {
        modelId: 'default',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        currentProviderId: remote.providerId,
        onProviderChange: vi.fn(),
        vendorKey: 'cc',
        actualRoute: true,
        sessionEngineFilter: { currentAgent: 'claude-code', onCrossEngineSelect: vi.fn() },
        remoteAgent: { devices: [{ deviceId: 'studio', name: 'Studio' }], selectedDeviceId: 'studio', onRelocate },
        pluginEngines: {
          engines: [remote],
          active: { providerId: remote.providerId, modelId: 'default', deviceId: 'studio' },
          onSelect: vi.fn(),
        },
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /Opus 5/ }));
    });
    expect(onRelocate).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'anthropic', modelId: 'claude-opus-5', agentDevice: null,
    }));
  });

  // 生产入口与可观察结果：remotePluginEngineChoices + ModelSelectorContent；使用端无需安装插件即可展示并选择同账号远程电脑
  // 与朋友分享(`share:<id>`)开放的插件引擎；若本机装了但未登录(unavailable)则隐藏本机置灰项、只展示远端可用项；永不回落到本机引擎。
  // 依据：2026-11-21 用户决定「同账号与朋友分享的远程插件引擎全面免装插件」。
  // 最小失败输入与 tier：unit（jsdom），本机 installedEngines=[] 时仍展示远端与分享项；远端停供时 resolveActivePluginEngine 返回 null。
  it('offers another computer’s and a friend’s shared plugin engines install-free, hides an unauthenticated local copy, and never falls back to this computer’s engine', () => {
    const offered = { supported: true, enabled: true };
    const remoteCatalogues = new Map<string, readonly PluginEngineView[] | null>([
      ['computer-b', [
        { ...engine('_root__dsh-plugin:dsh', 'DeepSeek Harness'), remoteUse: offered },
        { ...engine('cursor-plugin:cursor', 'Cursor'), remoteUse: offered },
        // Not opened for remote use, plugin without the mode, reported unavailable, an older Cindy: none is offered.
        { ...known, remoteUse: { supported: true, enabled: false } },
        { ...agy, remoteUse: { supported: false, enabled: false } },
        { ...gemini, remoteUse: offered },
        engine('old-plugin:old', 'Older Cindy'),
      ]],
      ['share:s1', [
        { ...engine('dsh-acp:dsh', 'DeepSeek Harness'), remoteUse: { supported: true, shareSupported: true, enabled: true } },
      ]],
      // Share with all models filtered out by permissions: must not synthesize a default model or appear selectable.
      ['share:empty', [
        { ...engine('agy-acp:agy', 'Antigravity'), models: [], defaultModelAllowed: false, remoteUse: { supported: true, shareSupported: true, enabled: true } },
      ]],
      // Not answered yet: offers nothing for now.
      ['computer-c', null],
    ]);
    const devices = [
      { deviceId: 'computer-b', name: 'Studio Mac' },
      { deviceId: 'share:s1', name: '来自 Magi 的分享' },
      { deviceId: 'share:empty', name: '来自 Lizi 的分享' },
      { deviceId: 'computer-c', name: null },
    ];

    // Install-free: even with zero local plugins installed, all offered remote and shared engines appear.
    const choices = remotePluginEngineChoices(devices, remoteCatalogues, (id, name) => name ?? id, []);
    expect(choices.map((choice) => [choice.providerId, choice.deviceId, choice.deviceName])).toEqual([
      ['acp-plugin:_root__dsh-plugin:dsh', 'computer-b', 'Studio Mac'],
      ['acp-plugin:cursor-plugin:cursor', 'computer-b', 'Studio Mac'],
      ['acp-plugin:dsh-acp:dsh', 'share:s1', '来自 Magi 的分享'],
    ]);

    // If a local copy is installed but unauthenticated / unavailable, the picker hides it and shows the usable remote/shared choices.
    const localUnauthenticatedDsh = engine('_ns__local__dsh-plugin:dsh', 'DeepSeek Harness', {
      availability: { state: 'unavailable', reason: 'not-signed-in', message: 'Please sign in' },
    });
    renderDraftPicker({ engines: [localUnauthenticatedDsh, ...choices], active: null, onSelect: vi.fn() });
    expect(screen.queryByRole('button', { name: 'DeepSeek Harness' })).toBeNull();
    expect(screen.getByRole('button', { name: 'DeepSeek Harness · Studio Mac' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'DeepSeek Harness · 来自 Magi 的分享' })).toBeTruthy();

    const shared = resolveActivePluginEngine([dsh, ...choices], {
      providerId: 'acp-plugin:dsh-acp:dsh', deviceId: 'share:s1', modelId: 'default',
    });
    expect(pluginEngineSessionCreateFields(shared!)).toEqual({
      agentKind: 'acp', providerId: 'acp-plugin:dsh-acp:dsh', model: 'default', effort: '', agentDeviceId: 'share:s1',
    });
    const remote = resolveActivePluginEngine([dsh, ...choices], {
      providerId: 'acp-plugin:_root__dsh-plugin:dsh', deviceId: 'computer-b', modelId: 'default',
    });
    expect(pluginEngineSessionCreateFields(remote!)).toEqual({
      agentKind: 'acp', providerId: 'acp-plugin:_root__dsh-plugin:dsh', model: 'default', effort: '', agentDeviceId: 'computer-b',
    });
    // The computer stopped offering it: the draft reads as "no engine chosen", not as this computer's engine.
    expect(resolveActivePluginEngine([dsh], {
      providerId: 'acp-plugin:_root__dsh-plugin:dsh', deviceId: 'computer-b', modelId: 'default',
    })).toBeNull();
    // This computer's engine carries no computer.
    expect(pluginEngineSessionCreateFields(resolveActivePluginEngine([dsh, ...choices], { providerId: dsh.providerId, modelId: 'default' })!))
      .not.toHaveProperty('agentDeviceId');
  });

  // 2026-11-19 用户要求插件引擎可选思考深度，展示与内置模型一致，且插件基座通用。
  it('starts the task with the chosen level where the model offers it, else the model’s own default', () => {
    const create = (modelId: string, effort?: 'max') => pluginEngineSessionCreateFields(
      resolveActivePluginEngine([leveled], { providerId: leveled.providerId, modelId, ...(effort ? { effort } : {}) })!);
    expect(create('pro', 'max').effort).toBe('max');
    expect(create('pro').effort).toBe('high');
    expect(create('flash', 'max').effort).toBe('low');
    expect(create('plain', 'max').effort).toBe('');
  });

  it('shows each model’s level like a built-in row and changes it in the row’s configuration', async () => {
    const onSelect = vi.fn();
    renderDraftPicker({ engines: [leveled], active: { providerId: leveled.providerId, modelId: 'pro', effort: 'max' }, onSelect });
    const list = screen.getByRole('listbox', { name: 'Models' });
    const rows = within(within(list).getByRole('group', { name: 'DeepSeek Harness' })).getAllByRole('option');
    // A row shows the level it would run with: the chosen one where offered, else its own default.
    expect(rows.map(levelOf)).toEqual(['max', 'low', null]);
    // No configuration for a model without levels.
    expect(rows[2]!.querySelector('[data-row-customize]')).toBeNull();

    await act(async () => {
      fireEvent.click(rows[0]!.querySelector<HTMLElement>('[data-row-customize]')!);
    });
    // The flyout is placed on the next frame (UnifiedFlyoutHost); its content exists before that.
    const slider = await screen.findByRole('slider', { hidden: true });
    expect(slider.getAttribute('aria-valuetext')).toBe('max');
    await act(async () => {
      fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    });
    expect(onSelect).toHaveBeenLastCalledWith({ providerId: leveled.providerId, modelId: 'pro', effort: 'high' });
    // Changing a level is not a pick: the picker stays open.
    expect(screen.getByRole('listbox', { name: 'Models' })).toBeTruthy();
  });

  it.each([
    ['no models known → engine default', dsh, { providerId: dsh.providerId, modelId: 'default' }, 'default'],
    ['a known model is kept', known, { providerId: known.providerId, modelId: 'oc-small' }, 'oc-small'],
    ['a model the engine dropped → engine default', known, { providerId: known.providerId, modelId: 'gone' }, 'default'],
  ] as const)('creates an acp task from the draft choice: %s', (_label, view, selection, model) => {
    const active = resolveActivePluginEngine([dsh, gemini, known], selection);
    expect(active).not.toBeNull();
    expect(pluginEngineSessionCreateFields(active!)).toEqual({ agentKind: 'acp', providerId: view.providerId, model, effort: '' });
  });

  it.each([
    ['unavailable engine', { providerId: gemini.providerId, modelId: 'default' }],
    ['plugin removed', { providerId: 'acp-plugin:gone:gone', modelId: 'default' }],
    ['not a plugin engine id', { providerId: 'anthropic', modelId: 'claude-opus-5' }],
  ] as const)('falls back to the built-in model when the remembered engine cannot run: %s', (_label, selection) => {
    expect(resolveActivePluginEngine([dsh, gemini, known], selection)).toBeNull();
  });
});

// 2026-11-19 用户决定：Agent 公布了自己的模式时，权限菜单显示这些模式并在末尾保留「全部允许」(插件基座通用)。
describe('agent working modes of a plugin engine', () => {
  it('starts in the agent’s default mode and keeps only modes the engine offers', () => {
    const start = (permissionMode?: 'plan' | 'ask' | 'bypassPermissions') =>
      resolveActivePluginEngine([agy, dsh], { providerId: agy.providerId, modelId: 'default', ...(permissionMode ? { permissionMode } : {}) })!
        .permissionMode;
    expect(start()).toBe('default');
    expect(start('plan')).toBe('plan');
    expect(start('bypassPermissions')).toBe('bypassPermissions');
    // Cindy's generic 'ask' is not one of this agent's modes: the agent's default instead.
    expect(start('ask')).toBe('default');
    // An engine without modes keeps Cindy's two; a removed engine keeps only Full access.
    expect(pluginEnginePermissionMode('plan', dsh)).toBe('ask');
    expect(pluginEnginePermissionMode('bypassPermissions', null)).toBe('bypassPermissions');
    expect(pluginEnginePermissionMode('plan', null)).toBe('ask');
  });

  it('lists the agent’s modes in its order with Full access last in the permission menu', async () => {
    const onPermissionModeChange = vi.fn();
    render(React.createElement(PermissionSelector, {
      permissionMode: 'plan', onPermissionModeChange, pluginEngineModes: agy.permissionModes, useMorphPopover: false,
    }));
    const trigger = screen.getByRole('button');
    expect(trigger.textContent).toContain('Plan');
    await act(async () => {
      fireEvent.click(trigger);
    });
    const labels = ['Default', 'Accept edits', 'Auto', 'Plan', 'Full access'];
    const options = labels.map((label) => screen.getAllByText(label).at(-1)!);
    expect(options.map((node) => labels.indexOf(node.textContent!))).toEqual([0, 1, 2, 3, 4]);
    for (let index = 1; index < options.length; index += 1) {
      expect(options[index - 1]!.compareDocumentPosition(options[index]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    await act(async () => {
      fireEvent.click(options[1]!);
    });
    expect(onPermissionModeChange).toHaveBeenCalledWith('acceptEdits');
  });
});

describe('a task running on a plugin engine', () => {
  const renderTaskTrigger = (view: PluginEngineView | null, onSelectModel = vi.fn(async () => true)) =>
    render(
      React.createElement(ModelSelector, {
        modelId: 'oc-large',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
        remoteAgent: undefined,
        actualRoute: true,
        pluginEngineSession: {
          providerId: known.providerId,
          engine: view,
          engineName: view?.name ?? 'Plugin engine',
          modelId: 'oc-large',
          onSelectModel,
        },
      }),
    );

  it('names the engine and its model on the trigger, never a built-in Harness, and switches among its models', async () => {
    const onSelectModel = vi.fn(async () => true);
    renderTaskTrigger(known, onSelectModel);
    const trigger = screen.getByRole('button', { name: 'Select model. Current: OpenCode · OC Large' });
    expect(trigger.textContent).toContain('OpenCode');
    expect(trigger.textContent).not.toMatch(/Claude|Codex|Pi\b/);
    await act(async () => {
      fireEvent.click(trigger);
    });
    const list = await screen.findByRole('listbox', { name: 'Models' });
    expect(within(list).queryByText('Opus 5')).toBeNull();
    await act(async () => {
      fireEvent.click(within(list).getByRole('option', { name: /OC Small/ }));
    });
    expect(onSelectModel).toHaveBeenCalledWith('oc-small');
  });

  it('shows the task’s level on the trigger and applies level changes and model switches to the task', async () => {
    const onSelectModel = vi.fn(async () => true);
    render(React.createElement(ModelSelector, {
      modelId: 'pro',
      effort: 'max',
      onModelChange: vi.fn(),
      onEffortChange: vi.fn(),
      vendorKey: 'cc',
      remoteAgent: undefined,
      actualRoute: true,
      pluginEngineSession: {
        providerId: leveled.providerId, engine: leveled, engineName: leveled.name, modelId: 'pro', effort: 'max', onSelectModel,
      },
    }));
    const trigger = screen.getByRole('button', { name: 'Select model. Current: DeepSeek Harness · Pro · max' });
    expect(trigger.querySelector('[data-plugin-engine-trigger-effort]')?.textContent).toBe('Max');
    await act(async () => {
      fireEvent.click(trigger);
    });
    const list = await screen.findByRole('listbox', { name: 'Models' });
    const rows = within(list).getAllByRole('option');
    expect(rows.map(levelOf)).toEqual(['max', 'low', null]);

    await act(async () => {
      fireEvent.contextMenu(rows[0]!);
    });
    await act(async () => {
      fireEvent.keyDown(await screen.findByRole('slider', { hidden: true }), { key: 'ArrowLeft' });
    });
    expect(onSelectModel).toHaveBeenLastCalledWith('pro', 'high');

    // Another model keeps the task's level where offered, else runs with its own default; none for a model without levels.
    await act(async () => {
      fireEvent.click(within(list).getByRole('option', { name: /Plain/ }));
    });
    expect(onSelectModel).toHaveBeenLastCalledWith('plain');
  });

  it('falls back to the generic engine label when the plugin is gone', () => {
    renderTaskTrigger(null);
    expect(screen.getByRole('button', { name: 'Select model. Current: Plugin engine · Model details unavailable' })).toBeTruthy();
  });

  it.each([
    ['acp', 'acp'],
    ['cc', 'cc'],
    ['codex', 'codex'],
    ['pi', 'pi'],
    [null, 'cc'],
  ] as const)('task identity icon for agent_kind %s', (kind, icon) => {
    expect(engineIconKindOf(kind)).toBe(icon);
  });
});
