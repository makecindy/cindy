// @vitest-environment jsdom

/**
 * modelSelectorCustomProviderCodexGate.test.tsx
 * ---------------------------------------------------------------------------
 * #1568 回归:未登录(hasSavedKey=false)时,codex/ 前缀的本机 key gate 只应作用于
 * XD 网关折扣路由;自定义(user)供应商目录里的同前缀模型按其供应商自身状态判定,
 * 不得因缺少 Cindy AI 网关 key 被置灰。
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      const translations: Record<string, string> = {
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

// 未登录:本机没有 Cindy AI/XD 网关 key。
vi.mock('@/hooks/useApiKey', () => ({
  useApiKey: () => ({ hasSavedKey: false }),
}));

vi.mock('@/hooks/useConnectedSource', () => ({
  useConnectedSource: () => ({ hasConnectedSource: true, loading: false }),
}));

vi.mock('@/hooks/useModelPricing', () => ({
  useGatewayModelPricing: () => ({}),
  useReferenceModelPricing: () => ({}),
}));

const providersRef = vi.hoisted(() => {
  const codexModel = (id: string, name: string) => ({
    id,
    name,
    contextWindow: 200000,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
  });
  const DEFAULT_PROVIDERS = [
    {
      id: 'xd',
      name: 'Cindy AI',
      source: 'builtin',
      agents: ['codex'],
      auth: { method: 'api-key' },
      routing: { codex: {} },
      connected: true,
      models: { codex: [codexModel('codex/gpt-5.5', 'GPT-5.5')] },
    },
    {
      id: 'custom-litellm',
      name: '自建 LiteLLM',
      source: 'user',
      agents: ['codex'],
      auth: { method: 'api-key' },
      routing: { codex: {} },
      connected: true,
      models: { codex: [codexModel('codex/gpt-5.6-sol', 'codex/gpt-5.6-sol')] },
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
    agentKind ?? 'codex',
  selectVisibleModels: () => [],
}));

vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: () => true,
  useModelVisibilityVersion: () => 0,
}));

vi.mock('@/state/providerModelMemory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/state/providerModelMemory')>()),
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
      modelId: 'codex/gpt-5.5',
      effort: 'high',
      onModelChange: vi.fn(),
      onEffortChange: vi.fn(),
      vendorKey: 'codex',
      currentProviderId: 'xd',
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

describe('ModelSelector codex/ key gate scope (#1568)', () => {
  it('keeps custom-provider codex/ models selectable without a saved gateway key', async () => {
    renderSelector();
    await openDropdown();
    const popover = screen.getByTestId('model-options-popover');
    const options = within(popover).getAllByRole('option');
    const customRow = options.find((row) =>
      within(row).queryByText('codex/gpt-5.6-sol'),
    );
    expect(customRow).toBeTruthy();
    expect(customRow?.hasAttribute('aria-disabled')).toBe(false);
  });

  it('still disables XD gateway codex/ models without a saved gateway key', async () => {
    renderSelector();
    await openDropdown();
    const popover = screen.getByTestId('model-options-popover');
    const options = within(popover).getAllByRole('option');
    const gatewayRow = options.find((row) => within(row).queryByText('GPT-5.5'));
    expect(gatewayRow).toBeTruthy();
    expect(gatewayRow?.getAttribute('aria-disabled')).toBe('true');
  });
});
