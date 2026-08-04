// @vitest-environment jsdom

/**
 * Subagent 设置必须开满标准模型选择面板(2026-07 用户定稿基准:全软件一个模型
 * 选择面板,处处同行为),且 Codex 行/护栏卡按契约装配。
 *
 * 回归目标:
 *   1. 供应商分段开启(onProviderChange 已装配)且 currentProviderId 回显已存来源;
 *   2. Claude 分段行选择把 (model, providerId) 一次 patch 原子落库;Codex 分段行
 *      选择把 (model, providerId, effort) 三元组原子落库;
 *   3. 显式来源未连接/不提供该模型时收窄为 null,不存「选 A 落 B」的不可能组合;
 *   4. 「不指定」同时清除该行全部键(Codex 含 effort,不留孤儿);
 *   5. 护栏三行写对 patch key;总开关关闭时其余护栏行禁用(值保留);
 *   6. codexRestartDeferred=true 时提示延迟生效;
 *   7. 两张卡的 DefaultOverrideControls 按各自键组判 isCustomized、恢复只写本卡键。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubagentModelSettingsState } from '../../../../shared/subagentModelSettings';
import { SubagentModelSection } from '../SubagentModelSection';

// jsdom 没有 ResizeObserver;Radix Slider 的 useSize 挂载时需要它(与
// TerminalShellSection 测试 stub scrollIntoView 同理)。
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// 只覆写 useNavigate,保留真实导出(与 CreateWorkerPopover 测试同规则)。
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));

const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

// 恒 false = 模拟用户把全部模型用可见性开关隐藏。组件的 CTA 判据是**目录口径**,
// 不得消费可见性(「全部隐藏」是被尊重的偏好,不是需要「连接来源」抢救的故障态,
// codex review)——若未来改回可见并集口径,下方多数 CTA 断言会在这里翻红。
vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: () => false,
}));

// 已连接 anthropic(claude)与 openai(codex);ghost-provider 不存在。
const providersMock = vi.hoisted(() => ({
  loading: false,
  // 可按用例清空:provider 连接着但动态模型发现为空清单的场景。
  claudeModels: [{ id: 'claude-opus-5' }, { id: 'claude-haiku-4-5' }] as Array<{
    id: string;
    mode?: string;
  }>,
  codexModels: [{ id: 'gpt-5.6-terra' }, { id: 'gpt-5.5' }] as Array<{
    id: string;
    mode?: string;
  }>,
}));
vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({
    providers: [
      {
        id: 'anthropic',
        name: 'Anthropic',
        connected: true,
        agents: ['claude-code'],
        routing: { 'claude-code': {} },
        models: {
          'claude-code': providersMock.claudeModels,
          codex: [],
        },
      },
      {
        id: 'openai',
        name: 'OpenAI',
        connected: true,
        agents: ['codex'],
        routing: { codex: {} },
        models: {
          'claude-code': [],
          codex: providersMock.codexModels,
        },
      },
    ],
    loading: providersMock.loading,
  }),
}));

// codex effort 解析走能力目录:providers 派生 mock 成空,统一从 capabilities 读,
// 便于给每个模型declare efforts/defaultEffort。
vi.mock('@/lib/providerModels', () => ({
  deriveModelsFromProviders: () => [],
}));
vi.mock('@/hooks/useAgentCapabilities', () => ({
  useAgentCapabilities: () => ({
    capabilities: {
      availableModels: [
        { id: 'gpt-5.6-terra', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
        { id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'high' },
      ],
    },
  }),
}));

// 两卡各一个恢复入口:按卡片键组判 isCustomized,恢复只写本卡键。
vi.mock('../DefaultOverrideControls', () => ({
  DefaultOverrideControls: (props: { isCustomized: boolean; onReset: () => void }) => (
    <button
      type="button"
      data-testid="override-reset"
      data-customized={String(props.isCustomized)}
      onClick={props.onReset}
    />
  ),
}));

// 标准面板只验「装配了、参数对」,面板内部行为由 ModelSelector 自己的测试负责。
// 两个实例按 vendorKey 区分 testid 与模拟点击的候选。
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: (props: {
    modelId: string;
    effort?: string;
    vendorKey?: string;
    currentProviderId?: string | null;
    sourceDisconnected?: boolean;
    reselectEmitsChange?: boolean;
    onNavigateToProviders?: () => void;
    onProviderChange?: (providerId: string | null, modelId?: string) => void;
    onModelChange: (modelId: string) => void;
    onEffortChange?: (effort: string) => void;
    configurationEnabled?: boolean;
    disabled?: boolean;
    excludeChatBridgedCodex?: boolean;
    unknownModelLabel?: (modelId: string) => string;
    fallbackOption?: { active: boolean; label: string; onSelect: () => void };
  }) => {
    const vendor = props.vendorKey ?? 'cc';
    const providerId = vendor === 'codex' ? 'openai' : 'anthropic';
    const modelId = vendor === 'codex' ? 'gpt-5.6-terra' : 'claude-opus-5';
    const flatModelId = vendor === 'codex' ? 'gpt-5.5' : 'claude-haiku-4-5';
    return (
      <div
        data-testid={`model-selector-${vendor}`}
        data-model={props.modelId}
        data-effort={props.effort ?? ''}
        data-current-provider={props.currentProviderId ?? ''}
        data-source-disconnected={String(props.sourceDisconnected === true)}
        data-reselect-emits={String(props.reselectEmitsChange === true)}
        data-connect-cta={String(props.onNavigateToProviders !== undefined)}
        // onProviderChange 是「供应商分段模式」的开关(ModelSelector 内部
        // sourcesEnabled = !!onProviderChange),这里暴露出来供断言。
        data-sources-enabled={String(props.onProviderChange !== undefined)}
        data-configuration-enabled={String(props.configurationEnabled !== false)}
        data-disabled={String(props.disabled === true)}
        data-exclude-bridged={String(props.excludeChatBridgedCodex === true)}
        data-unknown-label={props.unknownModelLabel?.('ghost-model-1') ?? ''}
      >
        <button
          type="button"
          data-testid={`${vendor}:pick-provider-row`}
          onClick={() => props.onProviderChange?.(providerId, modelId)}
        />
        <button
          type="button"
          data-testid={`${vendor}:pick-stale-provider-row`}
          onClick={() => props.onProviderChange?.('ghost-provider', modelId)}
        />
        <button
          type="button"
          data-testid={`${vendor}:pick-unspecified`}
          onClick={() => props.fallbackOption?.onSelect()}
        />
        <button
          type="button"
          data-testid={`${vendor}:reselect-current-row`}
          onClick={() => props.onProviderChange?.(props.currentProviderId ?? null, undefined)}
        />
        <button
          type="button"
          data-testid={`${vendor}:pick-model-flat`}
          onClick={() => props.onModelChange(flatModelId)}
        />
        <button
          type="button"
          data-testid={`${vendor}:pick-effort-high`}
          onClick={() => props.onEffortChange?.('high')}
        />
      </div>
    );
  },
}));

const DEFAULTS = {
  claudeCode: null,
  claudeCodeProviderId: null,
  codex: null,
  codexProviderId: null,
  codexEffort: null,
  codexSubagentsEnabled: true,
  codexMaxConcurrentSubagents: null,
  codexAllowNestedSubagents: false,
} as const;

function makeState(
  overrides: Partial<SubagentModelSettingsState> = {},
): SubagentModelSettingsState {
  return {
    ...DEFAULTS,
    isCustomized: false,
    customizedKeys: [],
    defaults: { ...DEFAULTS },
    ...overrides,
  };
}

const settingsGet = vi.fn();
const settingsSet = vi.fn();
const settingsReset = vi.fn();

beforeEach(() => {
  settingsGet.mockResolvedValue(makeState());
  settingsSet.mockImplementation(async (patch: Record<string, unknown>) => ({
    ...makeState({ isCustomized: true }),
    ...patch,
    codexRestartDeferred: false,
  }));
  settingsReset.mockResolvedValue({ ...makeState(), codexRestartDeferred: false });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      subagentModelSettingsGet: settingsGet,
      subagentModelSettingsSet: settingsSet,
      subagentModelSettingsReset: settingsReset,
    },
  };
});

afterEach(() => {
  cleanup();
  providersMock.loading = false;
  providersMock.claudeModels = [{ id: 'claude-opus-5' }, { id: 'claude-haiku-4-5' }];
  providersMock.codexModels = [{ id: 'gpt-5.6-terra' }, { id: 'gpt-5.5' }];
  vi.clearAllMocks();
});

describe('SubagentModelSection standard panel contract (Claude row)', () => {
  it('mounts the standard selector with provider sections enabled', async () => {
    render(<SubagentModelSection />);
    const selector = await screen.findByTestId('model-selector-cc');
    expect(selector.dataset.sourcesEnabled).toBe('true');
    // effort/Fast 配置列保持关闭:CLAUDE_CODE_SUBAGENT_MODEL 没有 effort/Fast 派发维度。
    expect(selector.dataset.configurationEnabled).toBe('false');
    // 已存模型脱离可见清单时 trigger 显示裸 id,不显示「选择模型」占位符。
    expect(selector.dataset.unknownLabel).toBe('ghost-model-1');
  });

  it('echoes the persisted provider back into the panel', async () => {
    settingsGet.mockResolvedValue(
      makeState({ claudeCode: 'claude-opus-5', claudeCodeProviderId: 'anthropic' }),
    );
    render(<SubagentModelSection />);
    const selector = await screen.findByTestId('model-selector-cc');
    expect(selector.dataset.currentProvider).toBe('anthropic');
    expect(selector.dataset.model).toBe('claude-opus-5');
  });

  it('persists (model, providerId) atomically in one patch', async () => {
    render(<SubagentModelSection />);
    fireEvent.click(await screen.findByTestId('cc:pick-provider-row'));
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    expect(settingsSet).toHaveBeenCalledWith({
      claudeCode: 'claude-opus-5',
      claudeCodeProviderId: 'anthropic',
    });
  });

  it('narrows an unavailable explicit provider to null instead of persisting it', async () => {
    render(<SubagentModelSection />);
    fireEvent.click(await screen.findByTestId('cc:pick-stale-provider-row'));
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    expect(settingsSet).toHaveBeenCalledWith({
      claudeCode: 'claude-opus-5',
      claudeCodeProviderId: null,
    });
  });

  it('narrows to null when the picked provider only offers a non-chat copy of the model id (issue #882 第 3 点, 2026-07 review 第 18 轮)', async () => {
    // 只查 id 存在(旧 providerOffersModel)会误放行:anthropic 上的 claude-opus-5
    // 这份具体条目已经是非聊天类型,不能落成子代理模型的显式来源。
    providersMock.claudeModels = [
      { id: 'claude-opus-5', mode: 'embedding' },
      { id: 'claude-haiku-4-5' },
    ];
    render(<SubagentModelSection />);
    fireEvent.click(await screen.findByTestId('cc:pick-provider-row'));
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    expect(settingsSet).toHaveBeenCalledWith({
      claudeCode: 'claude-opus-5',
      claudeCodeProviderId: null,
    });
  });

  it('flags a connected provider as disconnected when its model entry is non-chat (issue #882 第 3 点, 2026-07 review 第 18 轮)', async () => {
    providersMock.claudeModels = [{ id: 'claude-opus-5', mode: 'embedding' }];
    settingsGet.mockResolvedValue(
      makeState({ claudeCode: 'claude-opus-5', claudeCodeProviderId: 'anthropic' }),
    );
    render(<SubagentModelSection />);
    const selector = await screen.findByTestId('model-selector-cc');
    expect(selector.dataset.sourceDisconnected).toBe('true');
  });

  it('clears both model and providerId when returning to unspecified', async () => {
    settingsGet.mockResolvedValue(
      makeState({ claudeCode: 'claude-opus-5', claudeCodeProviderId: 'anthropic' }),
    );
    render(<SubagentModelSection />);
    fireEvent.click(await screen.findByTestId('cc:pick-unspecified'));
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    expect(settingsSet).toHaveBeenCalledWith({
      claudeCode: null,
      claudeCodeProviderId: null,
    });
  });

  it('disables the selector while the provider catalog is loading', async () => {
    // 目录未就绪时无法判定「来源是否提供该模型」,必须整行禁用而不是放行写入
    // 绕过收窄(greptile review 的加载窗口用例)。
    providersMock.loading = true;
    render(<SubagentModelSection />);
    const selector = await screen.findByTestId('model-selector-cc');
    expect(selector.dataset.disabled).toBe('true');
    // loading 中 providers 空不算「零来源」:CTA 不得提前接线(copilot review)。
    expect(selector.dataset.connectCta).toBe('false');
  });

  it('flags a connected provider that dropped the stored model as disconnected', async () => {
    // 来源还连着但目录已不含已存模型:只查 id 会静默换显示;必须同样标断开态。
    settingsGet.mockResolvedValue(
      makeState({ claudeCode: 'claude-ghost-model', claudeCodeProviderId: 'anthropic' }),
    );
    render(<SubagentModelSection />);
    const selector = await screen.findByTestId('model-selector-cc');
    expect(selector.dataset.sourceDisconnected).toBe('true');
  });

  it('flags the stored provider as disconnected instead of silently falling back', async () => {
    // 已存来源断开时 trigger 必须显示真实存储来源 + 断开态;静默回落默认图标会让
    // 显示与存储分叉,重连后旧来源静默复活(codex review)。
    settingsGet.mockResolvedValue(
      makeState({ claudeCode: 'claude-opus-5', claudeCodeProviderId: 'ghost-provider' }),
    );
    render(<SubagentModelSection />);
    const selector = await screen.findByTestId('model-selector-cc');
    expect(selector.dataset.sourceDisconnected).toBe('true');
    // 点面板高亮的回退行必须能把显示来源钉回存储(reselectEmitsChange 开启)。
    expect(selector.dataset.reselectEmits).toBe('true');
  });

  it('skips the write when reselecting the exact persisted (model, provider) pair', async () => {
    settingsGet.mockResolvedValue(
      makeState({ claudeCode: 'claude-opus-5', claudeCodeProviderId: 'anthropic' }),
    );
    render(<SubagentModelSection />);
    fireEvent.click(await screen.findByTestId('cc:reselect-current-row'));
    await waitFor(() => expect(settingsSet).not.toHaveBeenCalled());
  });

  it('keeps the stored provider untouched when only the model changes', async () => {
    // 换模型路径携带的是已存来源而非新选择:旧目录缓存滞后窗口里做收窄会把
    // 暂时不可见的有效订阅来源写成 null(真实丢数据,greptile 3/5 blocker);
    // 保留原值无路由危害(子代理派发只带模型 id),组合失配由断开态可见。
    settingsGet.mockResolvedValue(
      makeState({ claudeCode: 'claude-opus-5', claudeCodeProviderId: 'stale-cache-provider' }),
    );
    render(<SubagentModelSection />);
    fireEvent.click(await screen.findByTestId('cc:pick-model-flat'));
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    expect(settingsSet).toHaveBeenCalledWith({
      claudeCode: 'claude-haiku-4-5',
      claudeCodeProviderId: 'stale-cache-provider',
    });
  });

  it('keeps the connect CTA off while any source is connected, preserving stale diagnostics', async () => {
    // 面板 noSource 是 per-model 判定:存的模型 stale 而 agent 仍有来源时,接 CTA 会把
    // trigger 换成「连接来源」,盖掉裸 id + 断开态诊断(codex review)。mock 目录里有
    // anthropic 已连接 → CTA 必须不接线。
    settingsGet.mockResolvedValue(
      makeState({ claudeCode: 'claude-ghost-model', claudeCodeProviderId: 'anthropic' }),
    );
    render(<SubagentModelSection />);
    const selector = await screen.findByTestId('model-selector-cc');
    expect(selector.dataset.connectCta).toBe('false');
    expect(selector.dataset.sourceDisconnected).toBe('true');
  });

  it('never advertises an effort dimension on the Claude trigger', async () => {
    // Claude 子代理派发通道没有 effort 维度:effort 必须传空串,否则 trigger 会在
    // 命中模型 efforts 时展示档位文案,承诺不存在的能力(copilot review)。
    render(<SubagentModelSection />);
    const selector = await screen.findByTestId('model-selector-cc');
    expect(selector.dataset.effort).toBe('');
  });

  it('wires the connect CTA when connected providers expose zero selectable models', async () => {
    // 来源连接着但动态模型发现为空:面板是零分段 no-results,CTA 判据必须按
    // 「目录模型并集」而非 provider 连接标志(codex review)。
    providersMock.claudeModels = [];
    render(<SubagentModelSection />);
    const selector = await screen.findByTestId('model-selector-cc');
    expect(selector.dataset.connectCta).toBe('true');
  });

  it('keeps the connect CTA off when all catalog models are hidden by visibility prefs', async () => {
    // 文件顶部把 isModelEnabled mock 成恒 false = 用户把全部模型隐藏:这是被尊重的
    // 显式偏好,不是断连故障。CTA 判据必须按目录口径不受可见性影响,否则该状态下
    // stale 模型的裸 id + 断开态诊断会被误导的「连接来源」trigger 覆盖 —— 来源明明
    // 连接着(codex review);恢复入口在可见性设置,与 composer 同口径。
    settingsGet.mockResolvedValue(
      makeState({ claudeCode: 'claude-ghost-model', claudeCodeProviderId: 'anthropic' }),
    );
    render(<SubagentModelSection />);
    const selector = await screen.findByTestId('model-selector-cc');
    expect(selector.dataset.connectCta).toBe('false');
    expect(selector.dataset.sourceDisconnected).toBe('true');
  });
});

describe('SubagentModelSection Codex row', () => {
  it('mounts the codex selector with sections and effort configuration enabled', async () => {
    settingsGet.mockResolvedValue(
      makeState({ codex: 'gpt-5.6-terra', codexProviderId: 'openai', codexEffort: 'high' }),
    );
    render(<SubagentModelSection />);
    const selector = await screen.findByTestId('model-selector-codex');
    expect(selector.dataset.sourcesEnabled).toBe('true');
    // Codex 派发通道有 effort 维度(agents.default_subagent_reasoning_effort):
    // 配置列必须开启,effort 回显已存档位。
    expect(selector.dataset.configurationEnabled).toBe('true');
    expect(selector.dataset.effort).toBe('high');
    expect(selector.dataset.currentProvider).toBe('openai');
    expect(selector.dataset.model).toBe('gpt-5.6-terra');
    // Chat 桥接的 Codex 供应商模型必须隐藏:原生 spawn 按 Codex 自身目录解析,
    // 桥接模型必被拒(greptile review P1)。Claude 行不受此约束。
    expect(selector.dataset.excludeBridged).toBe('true');
    const claudeSelector = screen.getByTestId('model-selector-cc');
    expect(claudeSelector.dataset.excludeBridged).toBe('false');
  });

  it('persists the (model, providerId, effort) triple atomically in one patch', async () => {
    // 上游只设 default_subagent_model 时子代理 effort 会被重置为目标模型目录默认档,
    // 所以选模型必须成对写 effort:未存档位时解析为目录 defaultEffort。
    render(<SubagentModelSection />);
    fireEvent.click(await screen.findByTestId('codex:pick-provider-row'));
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    expect(settingsSet).toHaveBeenCalledWith({
      codex: 'gpt-5.6-terra',
      codexProviderId: 'openai',
      codexEffort: 'medium',
    });
  });

  it('keeps a still-valid stored effort when switching models', async () => {
    settingsGet.mockResolvedValue(
      makeState({ codex: 'gpt-5.6-terra', codexProviderId: 'openai', codexEffort: 'high' }),
    );
    render(<SubagentModelSection />);
    fireEvent.click(await screen.findByTestId('codex:pick-model-flat'));
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    expect(settingsSet).toHaveBeenCalledWith({
      codex: 'gpt-5.5',
      codexProviderId: 'openai',
      codexEffort: 'high',
    });
  });

  it('narrows an unavailable codex provider to null instead of persisting it', async () => {
    render(<SubagentModelSection />);
    fireEvent.click(await screen.findByTestId('codex:pick-stale-provider-row'));
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    expect(settingsSet).toHaveBeenCalledWith({
      codex: 'gpt-5.6-terra',
      codexProviderId: null,
      codexEffort: 'medium',
    });
  });

  it('clears model, providerId and effort together when returning to unspecified', async () => {
    // IPC 层有意不把 effort 绑进配对清理(effort-only 是合法上游配置):UI 必须在
    // 「不指定」时原子清三键,不留孤儿。
    settingsGet.mockResolvedValue(
      makeState({ codex: 'gpt-5.6-terra', codexProviderId: 'openai', codexEffort: 'high' }),
    );
    render(<SubagentModelSection />);
    fireEvent.click(await screen.findByTestId('codex:pick-unspecified'));
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    expect(settingsSet).toHaveBeenCalledWith({
      codex: null,
      codexProviderId: null,
      codexEffort: null,
    });
  });

  it('persists an effort-only change for the stored model', async () => {
    settingsGet.mockResolvedValue(
      makeState({ codex: 'gpt-5.6-terra', codexProviderId: 'openai', codexEffort: 'medium' }),
    );
    render(<SubagentModelSection />);
    fireEvent.click(await screen.findByTestId('codex:pick-effort-high'));
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    expect(settingsSet).toHaveBeenCalledWith({ codexEffort: 'high' });
  });

  it('ignores effort changes while no codex model is stored', async () => {
    render(<SubagentModelSection />);
    fireEvent.click(await screen.findByTestId('codex:pick-effort-high'));
    await waitFor(() => expect(settingsSet).not.toHaveBeenCalled());
  });
});

describe('SubagentModelSection guardrails card', () => {
  it('toggles the master switch with a single-key patch', async () => {
    render(<SubagentModelSection />);
    const master = await screen.findByRole('switch', {
      name: 'settings.subagentModels.guardrails.enableAria',
    });
    fireEvent.click(master);
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    expect(settingsSet).toHaveBeenCalledWith({ codexSubagentsEnabled: false });
  });

  it('toggles nested subagents with a single-key patch', async () => {
    render(<SubagentModelSection />);
    const nested = await screen.findByRole('switch', {
      name: 'settings.subagentModels.guardrails.nestedAria',
    });
    fireEvent.click(nested);
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    expect(settingsSet).toHaveBeenCalledWith({ codexAllowNestedSubagents: true });
  });

  it('writes the initial concurrency value when customization turns on, null when off', async () => {
    render(<SubagentModelSection />);
    const custom = await screen.findByRole('switch', {
      name: 'settings.subagentModels.guardrails.concurrencyCustomAria',
    });
    fireEvent.click(custom);
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    expect(settingsSet).toHaveBeenCalledWith({ codexMaxConcurrentSubagents: 3 });

    cleanup();
    settingsGet.mockResolvedValue(makeState({ codexMaxConcurrentSubagents: 5 }));
    settingsSet.mockClear();
    render(<SubagentModelSection />);
    const customOn = await screen.findByRole('switch', {
      name: 'settings.subagentModels.guardrails.concurrencyCustomAria',
    });
    fireEvent.click(customOn);
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    expect(settingsSet).toHaveBeenCalledWith({ codexMaxConcurrentSubagents: null });
  });

  it('shows the follow-default copy while concurrency is not customized', async () => {
    render(<SubagentModelSection />);
    expect(
      await screen.findByText('settings.subagentModels.guardrails.concurrencyFollowDefault'),
    ).toBeTruthy();
    // 未自定义时不渲染滑杆:上游默认按后端分叉(V1=6 / V2=3),没有单一数值可显示。
    expect(screen.queryByRole('slider')).toBeNull();
  });

  it('renders the slider with the stored value once customized', async () => {
    settingsGet.mockResolvedValue(makeState({ codexMaxConcurrentSubagents: 5 }));
    render(<SubagentModelSection />);
    await waitFor(() => expect(screen.queryByRole('slider')).not.toBeNull());
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('commits the value as soon as the slider interaction ends (onValueCommit)', async () => {
    settingsGet.mockResolvedValue(makeState({ codexMaxConcurrentSubagents: 3 }));
    render(<SubagentModelSection />);
    await waitFor(() => expect(screen.queryByRole('slider')).not.toBeNull());
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' }); // 3 → 4
    // 键盘交互每次落定即 commit,不等 300ms debounce 到点。
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    expect(settingsSet).toHaveBeenCalledWith({ codexMaxConcurrentSubagents: 4 });
  });

  it('sequential keyboard presses settle on the final value (mutex re-schedule)', async () => {
    settingsGet.mockResolvedValue(makeState({ codexMaxConcurrentSubagents: 3 }));
    render(<SubagentModelSection />);
    await waitFor(() => expect(screen.queryByRole('slider')).not.toBeNull());
    const thumb = screen.getByRole('slider');
    fireEvent.keyDown(thumb, { key: 'ArrowRight' }); // 3 → 4
    fireEvent.keyDown(thumb, { key: 'ArrowRight' }); // 4 → 5
    // 第二次 commit 撞上首个在飞写入时由 commitConcurrency 重排,终值不丢。
    await waitFor(
      () => expect(settingsSet).toHaveBeenLastCalledWith({ codexMaxConcurrentSubagents: 5 }),
      { timeout: 2000 },
    );
  });

  it('rolls the draft back to the stored value when the commit write fails', async () => {
    // 保存失败时滑杆不得停留在未落盘的新值:交互已结束,没有定时器会再重试,
    // 停留会让用户误以为失败的值仍然有效(codex review P2 第 3 轮)。
    settingsGet.mockResolvedValue(makeState({ codexMaxConcurrentSubagents: 3 }));
    settingsSet.mockRejectedValueOnce(new Error('disk write failed'));
    render(<SubagentModelSection />);
    await waitFor(() => expect(screen.queryByRole('slider')).not.toBeNull());
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' }); // 3 → 4(乐观)
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    // 草稿回滚:数值 pill 回落到已存的 3。
    await waitFor(() => expect(screen.getByText('3')).toBeTruthy());
    expect(screen.queryByText('4')).toBeNull();
  });

  it('never writes detached after unmount (owner-boundary safety)', async () => {
    // 卸载后不允许任何 detached 写入:main 侧按请求时刻解析 owner-scoped 路径,
    // 账号切换触发的卸载若再写会落进错误命名空间(codex review P1)。onValueCommit
    // 已保证交互结束即提交,卸载只取消未到点的 debounce。
    settingsGet.mockResolvedValue(makeState({ codexMaxConcurrentSubagents: 3 }));
    const { unmount } = render(<SubagentModelSection />);
    await waitFor(() => expect(screen.queryByRole('slider')).not.toBeNull());
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' }); // 3 → 4,commit 即时发生
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(settingsSet).toHaveBeenCalledTimes(1);
  });

  it('disables the other guardrail rows while the master switch is off (values preserved)', async () => {
    settingsGet.mockResolvedValue(
      makeState({
        codexSubagentsEnabled: false,
        codexMaxConcurrentSubagents: 4,
        codexAllowNestedSubagents: true,
      }),
    );
    render(<SubagentModelSection />);
    const nested = (await screen.findByRole('switch', {
      name: 'settings.subagentModels.guardrails.nestedAria',
    })) as HTMLButtonElement;
    const custom = (await screen.findByRole('switch', {
      name: 'settings.subagentModels.guardrails.concurrencyCustomAria',
    })) as HTMLButtonElement;
    expect(nested.disabled).toBe(true);
    expect(custom.disabled).toBe(true);
    // 值保留:嵌套开关仍显示 on(重开总开关即恢复,不清值)。
    expect(nested.getAttribute('aria-checked')).toBe('true');
  });

  it('appends the deferred suffix when the write returns codexRestartDeferred', async () => {
    settingsSet.mockImplementation(async (patch: Record<string, unknown>) => ({
      ...makeState({ isCustomized: true }),
      ...patch,
      codexRestartDeferred: true,
    }));
    render(<SubagentModelSection />);
    const master = await screen.findByRole('switch', {
      name: 'settings.subagentModels.guardrails.enableAria',
    });
    fireEvent.click(master);
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1));
    expect(toastMock.success).toHaveBeenCalledWith(
      'settings.subagentModels.toast.saved' + 'settings.subagentModels.toast.deferredSuffix',
    );
  });
});

describe('SubagentModelSection per-card override controls', () => {
  it('scopes isCustomized per card key group', async () => {
    settingsGet.mockResolvedValue(
      makeState({
        codexSubagentsEnabled: false,
        customizedKeys: ['codexSubagentsEnabled'],
        isCustomized: true,
      }),
    );
    render(<SubagentModelSection />);
    const controls = await screen.findAllByTestId('override-reset');
    expect(controls).toHaveLength(2);
    // 第一个在模型卡(Claude 行),第二个在护栏卡头部。
    expect(controls[0]?.dataset.customized).toBe('false');
    expect(controls[1]?.dataset.customized).toBe('true');
  });

  it('restores only the model-card keys from its own reset control', async () => {
    settingsGet.mockResolvedValue(
      makeState({
        codex: 'gpt-5.6-terra',
        codexEffort: 'high',
        customizedKeys: ['codex', 'codexEffort'],
        isCustomized: true,
      }),
    );
    render(<SubagentModelSection />);
    const controls = await screen.findAllByTestId('override-reset');
    fireEvent.click(controls[0] as HTMLElement);
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    expect(settingsSet).toHaveBeenCalledWith({
      claudeCode: null,
      claudeCodeProviderId: null,
      codex: null,
      codexProviderId: null,
      codexEffort: null,
    });
  });

  it('restores only the guardrail keys from its own reset control', async () => {
    settingsGet.mockResolvedValue(
      makeState({
        codexSubagentsEnabled: false,
        codexMaxConcurrentSubagents: 4,
        customizedKeys: ['codexSubagentsEnabled', 'codexMaxConcurrentSubagents'],
        isCustomized: true,
      }),
    );
    render(<SubagentModelSection />);
    const controls = await screen.findAllByTestId('override-reset');
    fireEvent.click(controls[1] as HTMLElement);
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    expect(settingsSet).toHaveBeenCalledWith({
      codexSubagentsEnabled: true,
      codexMaxConcurrentSubagents: null,
      codexAllowNestedSubagents: false,
    });
  });
});
