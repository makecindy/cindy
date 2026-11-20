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

import { ModelSelector, ModelSelectorContent } from '../ModelSelector';
import { PermissionSelector } from '../PermissionSelector';
import {
  PLUGIN_ENGINE_DEFAULT_MODEL,
  pluginEnginePermissionMode,
  pluginEngineSessionCreateFields,
  remotePluginEngineChoices,
  resolveActivePluginEngine,
} from '@/lib/pluginEngineSelection';
import { engineIconKindOf } from '@/components/sidebar/VendorIcon';
import { getDataOwnerGeneration, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { findPluginEngine, resetPluginEnginesStoreForTests, useRemotePluginEngines } from '@/hooks/usePluginEngines';
import { PLUGIN_ENGINES_INVOKE, type PluginEngineView } from '../../../../shared/pluginEngines';

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

describe('plugin engines in the new-task picker', () => {
  it.each([
    ['no engine installed', undefined, false],
    ['engines installed', [dsh, gemini, known], true],
  ] as const)('shows the 「插件引擎」 group and one rail tab per engine only when engines exist (%s)', (_label, engines, shown) => {
    renderDraftPicker(engines ? { engines, active: null, onSelect: vi.fn() } : undefined);
    expect(screen.getByText('Opus 5')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Plugin engines' }) !== null).toBe(shown);
    for (const name of ['DeepSeek Harness', 'Gemini CLI', 'OpenCode']) {
      expect(screen.queryByRole('button', { name }) !== null).toBe(shown);
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

  it('lists engines by name, keeps an unavailable one disabled with its hint, and selects the engine default', () => {
    const onSelect = vi.fn();
    renderDraftPicker({ engines: [dsh, gemini, known], active: null, onSelect });
    const group = screen.getByRole('group', { name: 'Plugin engines' });

    // Unavailable: visible, not selectable, with the plugin's own install hint.
    const geminiGroup = within(group).getByRole('group', { name: 'Gemini CLI' });
    expect(within(geminiGroup).getByText('Install with npm i -g gemini-cli')).toBeTruthy();
    const geminiRow = within(geminiGroup).getByRole('option');
    expect(geminiRow.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(geminiRow);
    expect(onSelect).not.toHaveBeenCalled();

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

  it('starts a task on another computer’s engine with that computer, and never falls back to this computer’s engine', () => {
    const offered = { supported: true, enabled: true };
    const choices = remotePluginEngineChoices(
      [{ deviceId: 'computer-b', name: 'Studio Mac' }, { deviceId: 'computer-c', name: null }],
      new Map<string, readonly PluginEngineView[] | null>([
        ['computer-b', [
          { ...dsh, remoteUse: offered },
          // Not opened for remote use, plugin without the mode, reported unavailable, an older Cindy: none is offered.
          { ...known, remoteUse: { supported: true, enabled: false } },
          { ...agy, remoteUse: { supported: false, enabled: false } },
          { ...gemini, remoteUse: offered },
          engine('old-plugin:old', 'Older Cindy'),
        ]],
        // Not answered yet: offers nothing for now.
        ['computer-c', null],
      ]),
      (deviceId, name) => name ?? deviceId,
    );
    expect(choices.map((choice) => [choice.providerId, choice.deviceId, choice.deviceName])).toEqual([
      [dsh.providerId, 'computer-b', 'Studio Mac'],
    ]);

    const remote = resolveActivePluginEngine([dsh, ...choices], { providerId: dsh.providerId, deviceId: 'computer-b', modelId: 'default' });
    expect(pluginEngineSessionCreateFields(remote!)).toEqual({
      agentKind: 'acp', providerId: dsh.providerId, model: 'default', effort: '', agentDeviceId: 'computer-b',
    });
    // The computer stopped offering it: the draft reads as "no engine chosen", not as this computer's engine.
    expect(resolveActivePluginEngine([dsh], { providerId: dsh.providerId, deviceId: 'computer-b', modelId: 'default' })).toBeNull();
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
