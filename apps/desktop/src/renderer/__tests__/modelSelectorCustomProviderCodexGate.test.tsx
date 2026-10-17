// @vitest-environment jsdom

/**
 * modelSelectorCustomProviderCodexGate.test.tsx
 * ---------------------------------------------------------------------------
 * #1568 回归:未登录(hasSavedKey=false)时,codex/ 前缀的本机 key gate 只应作用于
 * XD 网关折扣路由;自定义(user)供应商目录里的同前缀模型按其供应商自身状态判定,
 * 不得因缺少 Cindy AI 网关 key 被置灰。
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
  isLocalOnlyProviderForAgent: () => false,
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
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';

const requestProviderModelsAutoRefresh = vi.fn(async () => ({ ok: true as const }));

beforeEach(() => {
  requestProviderModelsAutoRefresh.mockClear();
  providersRef.providers = providersRef.DEFAULT_PROVIDERS;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: { requestProviderModelsAutoRefresh },
  };
});

function renderSelector(
  props: Partial<React.ComponentProps<typeof ModelSelector>> = {},
  withConfirmDialog = false,
) {
  const selector = React.createElement(ModelSelector, {
    modelId: 'codex/gpt-5.5',
    effort: 'high',
    onModelChange: vi.fn(),
    onEffortChange: vi.fn(),
    vendorKey: 'codex',
    currentProviderId: 'xd',
    onProviderChange: vi.fn(),
    ...props,
  });
  return render(
    withConfirmDialog ? <ConfirmDialogProvider>{selector}</ConfirmDialogProvider> : selector,
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

// Production entry/result: a real ModelSelector and ConfirmDialogProvider route
// a requires_payment row to billing only after the user's confirmation.
// Historical bug: modelSelectorPaymentNavigation used to guard the HashRouter
// boundary: pushState(pathname) does not make the Desktop hash router navigate.
// Coverage gap: UnifiedModelPanel tests stop at onPaymentRequired; the removed
// source test never clicked the confirmation or observed the resulting URL.
// Minimal input: one paid model, cancel once, then accept; tier: unit (jsdom).
// Reuse this file's real selector harness; no new environment or real waits.
// Standalone (2026-10-16): 3 passed; pnpm exec vitest run <this file>
// --maxWorkers=1: 5.93s process wall, 4.92s Vitest (3.64s collect, 474ms tests).
// This existing selector harness's module collection dominates the 5s target;
// the new case shares those imports and uses fake time for the provider queue.
it('keeps a paid-model cancellation on the current route, then confirms the billing hash route', async () => {
  const originalHref = window.location.href;
  const originalHistoryState = window.history.state;
  vi.useFakeTimers();
  window.location.hash = '#/model-selector';
  const onModelChange = vi.fn();
  const onProviderChange = vi.fn();
  providersRef.providers = [{
    ...(providersRef.DEFAULT_PROVIDERS[1] as Record<string, unknown>),
    models: {
      codex: [{
        id: 'codex/gpt-paid',
        name: 'Paid model',
        contextWindow: 200000,
        efforts: ['high'],
        defaultEffort: 'high',
        availability: 'requires_payment',
      }],
    },
  }];

  try {
    renderSelector({ onModelChange, onProviderChange }, true);
    await openDropdown();
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /Paid model/ }));
    });
    expect(window.location.hash).toBe('#/model-selector');
    await act(async () => {
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'commonUi.confirmDialog.cancel',
      }));
    });
    expect(window.location.hash).toBe('#/model-selector');
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // The real provider drains its dismissed-dialog queue after 200ms.
    await act(async () => { vi.advanceTimersByTime(200); });
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /Paid model/ }));
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'newChat.modelSelector.paymentRequired.action',
      }));
    });
    expect(window.location.hash).toBe('#/settings?tab=billing');
    expect(onModelChange).not.toHaveBeenCalled();
    expect(onProviderChange).not.toHaveBeenCalled();
  } finally {
    cleanup();
    vi.useRealTimers();
    window.history.replaceState(originalHistoryState, '', originalHref);
  }
});
