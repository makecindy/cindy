// @vitest-environment jsdom

/**
 * 子代理模型设置必须开满标准模型选择面板(2026-07 用户定稿基准:全软件一个模型
 * 选择面板,处处同行为)。
 *
 * 回归目标: 该入口曾以「三件套不传」的阉割装配退化成单栏 flat 列表 —— 无供应商
 * 分段、来源无处落库。这里锁四件事:
 *   1. 供应商分段开启(onProviderChange 已装配)且 currentProviderId 回显已存来源;
 *   2. 分段行选择把 (model, providerId) 一次 patch 原子落库;
 *   3. 显式来源未连接/不提供该模型时收窄为 null,不存「选 A 落 B」的不可能组合;
 *   4. 「不指定」同时清除 model 与 providerId。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SubagentModelSettingsState } from '../../../../shared/subagentModelSettings';
import { SubagentModelSection } from '../SubagentModelSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// 已连接 anthropic(提供 claude-opus-5 / claude-haiku-4-5);ghost-provider 不存在。
const providersMock = vi.hoisted(() => ({ loading: false }));
vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({
    providers: [
      {
        id: 'anthropic',
        name: 'Anthropic',
        connected: true,
        agents: ['claude-code'],
        models: {
          'claude-code': [{ id: 'claude-opus-5' }, { id: 'claude-haiku-4-5' }],
          codex: [],
        },
      },
    ],
    loading: providersMock.loading,
  }),
}));

// 标准面板只验「装配了、参数对」,面板内部行为由 ModelSelector 自己的测试负责。
vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelector: (props: {
    modelId: string;
    currentProviderId?: string | null;
    onProviderChange?: (providerId: string | null, modelId?: string) => void;
    onModelChange: (modelId: string) => void;
    configurationEnabled?: boolean;
    disabled?: boolean;
    unknownModelLabel?: (modelId: string) => string;
    fallbackOption?: { active: boolean; label: string; onSelect: () => void };
  }) => (
    <div
      data-testid="model-selector"
      data-model={props.modelId}
      data-current-provider={props.currentProviderId ?? ''}
      // onProviderChange 是「供应商分段模式」的开关(ModelSelector 内部
      // sourcesEnabled = !!onProviderChange),这里暴露出来供断言。
      data-sources-enabled={String(props.onProviderChange !== undefined)}
      data-configuration-enabled={String(props.configurationEnabled !== false)}
      data-disabled={String(props.disabled === true)}
      data-unknown-label={props.unknownModelLabel?.('ghost-model-1') ?? ''}
    >
      <button
        type="button"
        data-testid="pick-provider-row"
        onClick={() => props.onProviderChange?.('anthropic', 'claude-opus-5')}
      />
      <button
        type="button"
        data-testid="pick-stale-provider-row"
        onClick={() => props.onProviderChange?.('ghost-provider', 'claude-opus-5')}
      />
      <button
        type="button"
        data-testid="pick-unspecified"
        onClick={() => props.fallbackOption?.onSelect()}
      />
    </div>
  ),
}));

function makeState(
  overrides: Partial<SubagentModelSettingsState> = {},
): SubagentModelSettingsState {
  return {
    claudeCode: null,
    claudeCodeProviderId: null,
    codex: null,
    codexProviderId: null,
    isCustomized: false,
    customizedKeys: [],
    defaults: {
      claudeCode: null,
      claudeCodeProviderId: null,
      codex: null,
      codexProviderId: null,
    },
    ...overrides,
  };
}

const settingsGet = vi.fn();
const settingsSet = vi.fn();
const settingsReset = vi.fn();

beforeEach(() => {
  settingsGet.mockResolvedValue(makeState());
  settingsSet.mockImplementation(async (patch: Record<string, string | null>) =>
    makeState({
      claudeCode: patch.claudeCode ?? null,
      claudeCodeProviderId: patch.claudeCodeProviderId ?? null,
      isCustomized: true,
    }),
  );
  settingsReset.mockResolvedValue(makeState());
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
  vi.clearAllMocks();
});

describe('SubagentModelSection standard panel contract', () => {
  it('mounts the standard selector with provider sections enabled', async () => {
    render(<SubagentModelSection />);
    const selector = await screen.findByTestId('model-selector');
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
    const selector = await screen.findByTestId('model-selector');
    expect(selector.dataset.currentProvider).toBe('anthropic');
    expect(selector.dataset.model).toBe('claude-opus-5');
  });

  it('persists (model, providerId) atomically in one patch', async () => {
    render(<SubagentModelSection />);
    fireEvent.click(await screen.findByTestId('pick-provider-row'));
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    expect(settingsSet).toHaveBeenCalledWith({
      claudeCode: 'claude-opus-5',
      claudeCodeProviderId: 'anthropic',
    });
  });

  it('narrows an unavailable explicit provider to null instead of persisting it', async () => {
    render(<SubagentModelSection />);
    fireEvent.click(await screen.findByTestId('pick-stale-provider-row'));
    await waitFor(() => expect(settingsSet).toHaveBeenCalledTimes(1));
    expect(settingsSet).toHaveBeenCalledWith({
      claudeCode: 'claude-opus-5',
      claudeCodeProviderId: null,
    });
  });

  it('clears both model and providerId when returning to unspecified', async () => {
    settingsGet.mockResolvedValue(
      makeState({ claudeCode: 'claude-opus-5', claudeCodeProviderId: 'anthropic' }),
    );
    render(<SubagentModelSection />);
    fireEvent.click(await screen.findByTestId('pick-unspecified'));
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
    const selector = await screen.findByTestId('model-selector');
    expect(selector.dataset.disabled).toBe('true');
  });
});
