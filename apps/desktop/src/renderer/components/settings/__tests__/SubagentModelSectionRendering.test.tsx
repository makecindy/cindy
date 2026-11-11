// @vitest-environment jsdom

/**
 * Subagent 设置必须开满标准模型选择面板(2026-07 用户定稿基准:全软件一个模型
 * 选择面板,处处同行为),且 Codex 只暴露一枚智能调配开关。
 *
 * 回归目标:
 *   1. 供应商分段开启(onProviderChange 已装配)且 currentProviderId 回显已存来源;
 *   2. Claude 分段行选择把 (model, providerId) 一次 patch 原子落库;
 *   3. 显式来源未连接/不提供该模型时收窄为 null,不存「选 A 落 B」的不可能组合;
 *   4. 「不指定」同时清除该行全部键(Codex 含 effort,不留孤儿);
 *   5. Codex 默认保持原生调配，只有用户打开智能调配才写入布尔开关;
 *   6. Claude 与 Codex 智能调配各自恢复自己的设置键。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubagentModelSettingsState } from '../../../../shared/subagentModelSettings';
import { SubagentModelSection } from '../SubagentModelSection';

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

// 已连接 anthropic；ghost-provider 不存在。
const providersMock = vi.hoisted(() => ({
  loading: false,
  // 可按用例清空:provider 连接着但动态模型发现为空清单的场景。
  claudeModels: [{ id: 'claude-opus-5' }, { id: 'claude-haiku-4-5' }] as Array<{
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
    ],
    loading: providersMock.loading,
  }),
}));

// Claude 模型行与 Codex 智能调配各一个恢复入口。
vi.mock('../DefaultOverrideControls', () => ({
  DefaultOverrideControls: (props: {
    isCustomized: boolean;
    disabled?: boolean;
    alwaysVisible?: boolean;
    onReset: () => void;
  }) => (
    <button
      type="button"
      data-testid="override-reset"
      data-customized={String(props.isCustomized)}
      data-always-visible={String(props.alwaysVisible === true)}
      disabled={props.disabled || !props.isCustomized}
      onClick={props.onReset}
    />
  ),
}));

// 标准面板只验「装配了、参数对」,面板内部行为由 ModelSelector 自己的测试负责。
// 这里只渲染 Claude Code 实例；Codex 不再挂固定模型选择器。
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: (props: {
    modelId: string;
    effort?: string;
    vendorKey?: string;
    currentProviderId?: string | null;
    sourceDisconnected?: boolean;
    reselectEmitsChange?: boolean;
    onNavigateToProviders?: () => void;
    onProviderChange?: (providerId: string | null, modelId?: string, effort?: string) => void;
    onModelChange: (modelId: string) => void;
    onEffortChange?: (effort: string) => void;
    modelMemory?: {
      getEffort: (agent: string, providerId: string, modelId: string) => string | undefined;
      setEffort: (agent: string, providerId: string, modelId: string, effort: string) => void;
    };
    configurationEnabled?: boolean;
    disabled?: boolean;
    excludeChatBridgedCodex?: boolean;
    unknownModelLabel?: (modelId: string) => string;
    fallbackOption?: { active: boolean; label: string; onSelect: () => void };
  }) => {
    const vendor = props.vendorKey ?? 'cc';
    const providerId = 'anthropic';
    const modelId = 'claude-opus-5';
    const flatModelId = 'claude-haiku-4-5';
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
        data-model-memory={String(props.modelMemory !== undefined)}
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
      </div>
    );
  },
}));

const DEFAULTS = {
  claudeCode: null,
  claudeCodeProviderId: null,
  codexSmartSubagentRouting: false,
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

describe('SubagentModelSection Codex smart routing', () => {
  it('shows one smart-routing switch and no fixed Codex model selector', async () => {
    render(<SubagentModelSection />);
    const toggle = await screen.findByRole('switch', {
      name: 'settings.subagentModels.smartRouting.aria',
    });
    expect(toggle.getAttribute('data-state')).toBe('unchecked');
    expect(screen.queryByTestId('model-selector-codex')).toBeNull();
    expect(screen.getByText('settings.subagentModels.smartRouting.nativeHint')).toBeTruthy();
  });

  it('persists only the smart-routing boolean', async () => {
    render(<SubagentModelSection />);
    fireEvent.click(
      await screen.findByRole('switch', {
        name: 'settings.subagentModels.smartRouting.aria',
      }),
    );
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith({
        codexSmartSubagentRouting: true,
      }),
    );
  });

  it('restores only the smart-routing key', async () => {
    settingsGet.mockResolvedValue(
      makeState({
        codexSmartSubagentRouting: true,
        customizedKeys: ['codexSmartSubagentRouting'],
        isCustomized: true,
      }),
    );
    render(<SubagentModelSection />);
    const controls = await screen.findAllByTestId('override-reset');
    fireEvent.click(controls[1] as HTMLElement);
    await waitFor(() =>
      expect(settingsSet).toHaveBeenCalledWith({
        codexSmartSubagentRouting: false,
      }),
    );
  });
});
