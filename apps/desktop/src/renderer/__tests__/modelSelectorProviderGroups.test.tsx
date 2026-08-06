// @vitest-environment jsdom

/**
 * modelSelectorProviderGroups.test.tsx
 * ---------------------------------------------------------------------------
 * 验证模型选择器按供应商分组渲染:
 *   1. 两个供应商分别显示自己的分组标题
 *   2. 每个模型出现在正确的供应商下
 *   3. flat 模式(不传 onProviderChange)不显示供应商标题
 *   4. 分割线只出现在组间,不出现在第一组之前
 *   5. 长供应商名称不撑破弹层(truncate)
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      const translations: Record<string, string> = {
        'settings.providers.anthropic.title': 'Anthropic',
        'settings.providers.xd.title': 'Cindy AI',
        'newChat.modelSelector.trigger.placeholder': '选择模型',
        'newChat.modelSelector.trigger.aria': `Select model. Current: ${options?.model ?? ''}`,
        'newChat.modelSelector.trigger.ariaWithEffort': `Select model. Current: ${options?.model ?? ''}, effort: ${options?.effort ?? ''}`,
        'newChat.modelSelector.search.noResults': '无匹配模型',
        'newChat.modelSelector.pricing.free': '限时免费',
        'newChat.modelSelector.source.disconnected': '已断开',
      };
      return translations[key] ?? options?.defaultValue ?? key;
    },
  }),
}));

vi.mock('@/components/ui/popover', async () => {
  const React = await import('react');
  const OpenContext = React.createContext<{
    open: boolean;
    onOpenChange?: (open: boolean) => void;
  }>({ open: true });
  return {
    Popover: ({
      children,
      open,
      onOpenChange,
    }: {
      children: React.ReactNode;
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
    }) =>
      React.createElement(
        OpenContext.Provider,
        { value: { open: open ?? true, onOpenChange } },
        children,
      ),
    PopoverTrigger: ({ children }: { children: React.ReactNode }) => {
      const state = React.useContext(OpenContext);
      const child = children as React.ReactElement<{ onClick?: React.MouseEventHandler }>;
      return React.cloneElement(child, {
        onClick: (event: React.MouseEvent) => {
          child.props.onClick?.(event);
          state.onOpenChange?.(!state.open);
        },
      });
    },
    PopoverAnchor: ({ children }: { children: React.ReactNode }) => children,
    PopoverContent: ({ children }: { children: React.ReactNode }) => {
      const state = React.useContext(OpenContext);
      return state.open
        ? React.createElement('div', { 'data-testid': 'model-options-popover' }, children)
        : null;
    },
  };
});

vi.mock('@/lib/scrollbarAutoHide', () => ({ flashScrollbar: vi.fn() }));

vi.mock('@/hooks/useAgentCapabilities', () => ({
  evictDeviceCapabilities: vi.fn(),
  prefetchDeviceCapabilities: vi.fn(async () => {}),
  useAgentCapabilities: () => ({ capabilities: null, loading: false, error: null }),
}));

vi.mock('@/hooks/useApiKey', () => ({
  useApiKey: () => ({ hasSavedKey: true }),
}));

vi.mock('@/hooks/useConnectedSource', () => ({
  useConnectedSource: () => ({ hasConnectedSource: true, loading: false }),
}));

vi.mock('@/hooks/useModelPricing', () => ({
  useGatewayModelPricing: () => ({}),
  useReferenceModelPricing: () => ({}),
}));

const providersRef = vi.hoisted(() => {
  const DEFAULT_PROVIDERS = [
    {
      id: 'anthropic',
      name: 'Anthropic',
      source: 'builtin',
      agents: ['claude-code'],
      auth: { method: 'oauth' },
      routing: { 'claude-code': {} },
      connected: true,
      models: {
        'claude-code': [
          {
            id: 'claude-opus-4-8',
            name: 'Opus 4.8',
            contextWindow: 200000,
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'high',
          },
          {
            id: 'claude-sonnet-4-6',
            name: 'Sonnet 4.6',
            contextWindow: 200000,
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'medium',
          },
        ],
      },
    },
    {
      id: 'custom-dashscope',
      name: '阿里云百炼',
      source: 'user',
      agents: ['claude-code'],
      auth: { method: 'api-key' },
      routing: { 'claude-code': {} },
      connected: true,
      models: {
        'claude-code': [
          {
            id: 'qwen3.7-plus',
            name: 'qwen3.7-plus',
            contextWindow: 131072,
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'medium',
          },
        ],
      },
    },
  ] as unknown[];
  return { DEFAULT_PROVIDERS, providers: DEFAULT_PROVIDERS };
});
vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: providersRef.providers, providerOrder: [] }),
}));

vi.mock('@/hooks/useDeviceProviders', () => ({
  evictDeviceProviders: vi.fn(),
  prefetchDeviceProviders: vi.fn(async () => {}),
  useDeviceProviders: () => ({
    providers: [],
    loading: false,
    error: null,
    unsupported: false,
  }),
}));

vi.mock('@/lib/providerModels', () => ({
  providerMonogram: (name: string) => name.slice(0, 1).toUpperCase(),
  isChatBridgedCodexProvider: () => false,
  filterChatBridgedCodexProviders: (providers: unknown[]) => providers,
  resolveVisibleModelAgentKind: ({ agentKind }: { agentKind: string | null }) =>
    agentKind ?? 'claude-code',
  selectVisibleModels: () => [],
}));

vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: () => true,
  useModelVisibilityVersion: () => 0,
}));

vi.mock('@/state/providerModelMemory', () => ({
  useProviderModelMemoryVersion: () => 0,
}));

vi.mock('@/state/deviceLinkModelMirror', () => ({
  useDeviceLinkModelMirrorVersion: () => 0,
}));

import { ModelSelector } from '@/components/new-chat/ModelSelector';

const requestProviderModelsAutoRefresh = vi.fn(async () => ({ ok: true as const }));

beforeEach(() => {
  requestProviderModelsAutoRefresh.mockClear();
  providersRef.providers = providersRef.DEFAULT_PROVIDERS;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: { requestProviderModelsAutoRefresh },
  };
});

function renderSelector(props: Partial<React.ComponentProps<typeof ModelSelector>> = {}) {
  return render(
    React.createElement(ModelSelector, {
      modelId: 'claude-opus-4-8',
      effort: 'high',
      onModelChange: vi.fn(),
      onEffortChange: vi.fn(),
      vendorKey: 'cc',
      currentProviderId: 'anthropic',
      onProviderChange: vi.fn(),
      ...props,
    }),
  );
}

async function openDropdown(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Select model/ }));
  });
}

describe('ModelSelector provider groups', () => {
  it('renders a group heading for each provider', async () => {
    renderSelector();
    await openDropdown();
    const popover = screen.getByTestId('model-options-popover');
    const groups = within(popover).getAllByRole('group');
    expect(groups).toHaveLength(2);
    expect(within(groups[0]).getByText('Anthropic')).toBeTruthy();
    expect(within(groups[1]).getByText('阿里云百炼')).toBeTruthy();
  });

  it('places each model under the correct provider group', async () => {
    renderSelector();
    await openDropdown();
    const popover = screen.getByTestId('model-options-popover');
    const groups = within(popover).getAllByRole('group');
    const anthropicGroup = groups[0];
    const dashscopeGroup = groups[1];
    expect(within(anthropicGroup).getByText('Opus 4.8')).toBeTruthy();
    expect(within(anthropicGroup).getByText('Sonnet 4.6')).toBeTruthy();
    expect(within(dashscopeGroup).getByText('qwen3.7-plus')).toBeTruthy();
    expect(within(dashscopeGroup).queryByText('Opus 4.8')).toBeNull();
  });

  it('reselects the connected fallback source when the stored source is disconnected', async () => {
    const modelId = 'claude-fable-5';
    const model = {
      id: modelId,
      name: 'Fable 5',
      contextWindow: 200000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
    };
    providersRef.providers = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        source: 'builtin',
        agents: ['claude-code'],
        auth: { method: 'oauth' },
        routing: { 'claude-code': {} },
        connected: false,
        models: { 'claude-code': [model] },
      },
      {
        id: 'xd',
        name: 'Cindy AI',
        source: 'builtin',
        agents: ['claude-code'],
        auth: { method: 'api-key' },
        routing: { 'claude-code': {} },
        connected: true,
        models: { 'claude-code': [model] },
      },
    ] as unknown[];
    const onProviderChange = vi.fn();

    renderSelector({
      modelId,
      effort: 'high',
      currentProviderId: 'anthropic',
      sourceDisconnected: true,
      reselectEmitsChange: true,
      selectedRowClickOpensConfiguration: true,
      onProviderChange,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /已断开/ }));
    });

    const popover = screen.getByTestId('model-options-popover');
    const xdGroup = within(popover).getByRole('group', { name: 'Cindy AI' });
    const fallbackRow = within(xdGroup).getByRole('option', { name: /Fable 5/ });
    expect(fallbackRow.getAttribute('aria-selected')).toBe('true');

    fireEvent.click(fallbackRow);
    expect(onProviderChange).toHaveBeenCalledWith('xd', modelId, undefined);
    expect(screen.getByRole('group', { name: /Fable 5/ })).toBeTruthy();
  });

  it('opens a selected provider configuration without persisting its derived effort', async () => {
    const onProviderChange = vi.fn();
    renderSelector({
      reselectEmitsChange: true,
      selectedRowClickOpensConfiguration: true,
      onProviderChange,
    });
    await openDropdown();

    fireEvent.click(screen.getByRole('option', { name: /Opus 4\.8/ }));

    expect(onProviderChange).not.toHaveBeenCalled();
    expect(screen.getByRole('group', { name: /Opus 4\.8/ })).toBeTruthy();
  });

  it('returns the target provider effort for the same model id', async () => {
    const modelId = 'shared-model';
    const anthropicModel = {
      id: modelId,
      name: 'Shared Model',
      contextWindow: 200000,
      efforts: ['low', 'high'],
      defaultEffort: 'high',
    };
    const xdModel = {
      ...anthropicModel,
      efforts: ['low'],
      defaultEffort: 'low',
    };
    providersRef.providers = [
      {
        ...(providersRef.DEFAULT_PROVIDERS[0] as Record<string, unknown>),
        models: { 'claude-code': [anthropicModel] },
      },
      {
        id: 'xd',
        name: 'Cindy AI',
        source: 'builtin',
        agents: ['claude-code'],
        auth: { method: 'api-key' },
        routing: { 'claude-code': {} },
        connected: true,
        models: { 'claude-code': [xdModel] },
      },
    ] as unknown[];
    const onProviderChange = vi.fn();

    try {
      renderSelector({ modelId, effort: 'high', currentProviderId: 'anthropic', onProviderChange });
      await openDropdown();
      const xdGroup = within(screen.getByTestId('model-options-popover')).getByRole('group', {
        name: 'Cindy AI',
      });
      fireEvent.click(within(xdGroup).getByRole('option', { name: /Shared Model/ }));
      expect(onProviderChange).toHaveBeenCalledWith('xd', modelId, 'low');
    } finally {
      providersRef.providers = providersRef.DEFAULT_PROVIDERS;
    }
  });

  it('does not render group headings in flat mode (no onProviderChange)', async () => {
    renderSelector({ currentProviderId: undefined, onProviderChange: undefined });
    await openDropdown();
    const popover = screen.getByTestId('model-options-popover');
    expect(within(popover).queryAllByRole('group')).toHaveLength(0);
  });

  it('renders separator between groups but not before the first', async () => {
    renderSelector();
    await openDropdown();
    const popover = screen.getByTestId('model-options-popover');
    const groups = within(popover).getAllByRole('group');
    expect(groups).toHaveLength(2);
    const firstGroupSeparators = groups[0].querySelectorAll('[class*="h-px"]');
    expect(firstGroupSeparators).toHaveLength(0);
  });

  it('truncates long provider names', async () => {
    providersRef.providers = [
      {
        id: 'long-name-provider',
        name: 'A Very Long Provider Name That Should Definitely Be Truncated In The Dropdown',
        source: 'user',
        agents: ['claude-code'],
        auth: { method: 'api-key' },
        routing: { 'claude-code': {} },
        connected: true,
        models: {
          'claude-code': [
            {
              id: 'some-model',
              name: 'Some Model',
              contextWindow: 100000,
              efforts: [],
              defaultEffort: null,
            },
          ],
        },
      },
    ] as unknown[];
    renderSelector({ modelId: 'some-model', currentProviderId: 'long-name-provider' });
    await openDropdown();
    const popover = screen.getByTestId('model-options-popover');
    const heading = within(popover).getByText(/A Very Long Provider Name/);
    expect(heading.className).toContain('truncate');
  });
});
