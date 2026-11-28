// @vitest-environment jsdom
/**
 * ModelSelector footer compact EffortSlider tests:
 * - Shows compact EffortSlider for built-in and plugin engine models with >= 2 efforts.
 * - Hides EffortSlider when efforts <= 1, thinkingToggle is enabled, or configuration is disabled.
 * - Isolates pointer/click events so adjusting effort does not dismiss the popover.
 */
import type { ModelSelectorContentBaseProps } from '../components/new-chat/ModelSelector';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuthUser: () => null, useOptionalAuthDeviceId: () => null }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => options?.defaultValue ?? key,
  }),
}));

vi.mock('@/lib/scrollbarAutoHide', () => ({ flashScrollbar: vi.fn() }));

vi.mock('@/hooks/useAgentCapabilities', () => ({
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

const catalogs = vi.hoisted(() => ({
  providers: [
    {
      id: 'anthropic',
      name: 'Anthropic',
      source: 'builtin',
      agents: ['claude-code', 'pi'],
      auth: { method: 'api-key' },
      routing: { 'claude-code': {}, pi: {} },
      connected: true,
      models: {
        'claude-code': [
          {
            id: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            contextWindow: 200000,
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'medium',
          },
          {
            id: 'claude-haiku-single',
            name: 'Claude Haiku',
            contextWindow: 200000,
            efforts: ['low'],
            defaultEffort: 'low',
          },
        ],
        pi: [
          {
            id: 'pi-thinking-toggle',
            name: 'Pi Thinking Toggle',
            contextWindow: 200000,
            efforts: ['low', 'high'],
            defaultEffort: 'low',
            thinkingToggle: true,
          },
        ],
      },
    },
  ] as unknown[],
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: catalogs.providers, providerOrder: [] }),
}));
vi.mock('@/hooks/useDeviceProviders', () => ({
  evictDeviceProviders: vi.fn(),
  prefetchDeviceProviders: vi.fn(async () => {}),
  useDeviceProviders: () => ({ providers: [], loading: false, error: null, unsupported: false }),
}));
vi.mock('@/hooks/useDevicesProviders', () => ({
  useDevicesProviders: () => new Map(),
}));
vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: () => true,
  useModelVisibilityVersion: () => 0,
}));
vi.mock('@/state/deviceLinkModelMirror', () => ({
  useDeviceLinkModelMirrorVersion: () => 0,
}));
vi.mock('@/hooks/useRemoteDeviceUsage', () => ({
  useRemoteCodexAccountUsage: () => null,
  useRemoteXaiSubscriptionUsage: () => null,
}));
vi.mock('@/hooks/useRemoteClaudeSubscriptionUsage', () => ({
  useRemoteClaudeSubscriptionUsage: () => null,
}));

import { ModelSelectorContent } from '@/components/new-chat/ModelSelector';
import { __resetForTest as resetEnginePrefs } from '@/state/modelEnginePrefs';
import { __resetForTest as resetFavorites } from '@/state/modelFavorites';

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => true);
  Element.prototype.releasePointerCapture = vi.fn();
});

beforeEach(() => {
  vi.clearAllMocks();
  resetEnginePrefs();
  resetFavorites();
});

afterEach(() => {
  cleanup();
});

function pointer(target: Element | Document, type: string, x: number, id = 1, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, button });
  Object.defineProperty(event, 'pointerId', { value: id });
  fireEvent(target, event);
}

function renderSelector(props: Partial<ModelSelectorContentBaseProps> = {}) {
  const onEffortChange = vi.fn();
  const onDismiss = vi.fn();
  const onParentPointerDown = vi.fn();
  const onParentClick = vi.fn();
  render(
    <div onPointerDown={onParentPointerDown} onClick={onParentClick}>
      <ModelSelectorContent
        modelId="claude-sonnet-4-6"
        effort="medium"
        onModelChange={vi.fn()}
        onEffortChange={onEffortChange}
        currentProviderId="anthropic"
        onProviderChange={vi.fn()}
        vendorKey="cc"
        onNavigateToProviders={vi.fn()}
        onDismiss={onDismiss}
        remoteAgent={{ devices: [], selectedDeviceId: null }}
        {...props}
      />
    </div>,
  );
  return { onEffortChange, onDismiss, onParentPointerDown, onParentClick };
}

describe('ModelSelector footer compact EffortSlider', () => {
  it('renders slider for built-in model with >=2 efforts and isolates pointer/click events', () => {
    const { onEffortChange, onDismiss, onParentPointerDown, onParentClick } = renderSelector();
    const footerSlider = document.querySelector('[data-footer-effort-slider]');
    expect(footerSlider).toBeTruthy();

    const slider = footerSlider!.querySelector('[role="slider"]')!;
    slider.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;

    act(() => {
      pointer(slider, 'pointerdown', 100);
    });
    act(() => {
      pointer(document, 'pointerup', 100);
      fireEvent.click(slider);
    });

    expect(onEffortChange).toHaveBeenCalledWith('high');
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onParentPointerDown).not.toHaveBeenCalled();
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it('hides slider when model has <=1 effort, thinkingToggle is true, or configuration is disabled', () => {
    const single = renderSelector({ modelId: 'claude-haiku-single', effort: 'low' });
    expect(document.querySelector('[data-footer-effort-slider]')).toBeNull();
    expect(single.onEffortChange).not.toHaveBeenCalled();
    cleanup();

    renderSelector({ modelId: 'pi-thinking-toggle', vendorKey: 'pi', effort: 'low' });
    expect(document.querySelector('[data-footer-effort-slider]')).toBeNull();
    cleanup();

    renderSelector({ configurationEnabled: false });
    expect(document.querySelector('[data-footer-effort-slider]')).toBeNull();
  });

  it('renders slider for active plugin engine model with >=2 efforts and updates without dismissing', () => {
    const onSelect = vi.fn();
    const { onDismiss } = renderSelector({
      pluginEngines: {
        engines: [
          {
            key: 'antigravity:acp',
            ghostId: 'antigravity',
            harnessId: 'acp',
            providerId: 'plugin-engine:antigravity',
            name: 'Antigravity',
            availability: { state: 'available' },
            permissionModes: [{ id: 'ask', label: 'Ask' }],
            defaultPermissionMode: 'ask',
            models: [
              {
                id: 'ag-pro',
                displayName: 'Antigravity Pro',
                efforts: ['low', 'medium', 'high'],
                defaultEffort: 'medium',
              },
            ],
          },
        ],
        active: {
          providerId: 'plugin-engine:antigravity',
          modelId: 'ag-pro',
          effort: 'low',
        },
        onSelect,
      },
    });

    const footerSlider = document.querySelector('[data-footer-effort-slider]');
    expect(footerSlider).toBeTruthy();
    const slider = footerSlider!.querySelector('[role="slider"]')!;
    slider.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;

    act(() => {
      pointer(slider, 'pointerdown', 100);
    });
    act(() => {
      pointer(document, 'pointerup', 100);
    });

    expect(onSelect).toHaveBeenCalledWith({
      providerId: 'plugin-engine:antigravity',
      modelId: 'ag-pro',
      effort: 'high',
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
