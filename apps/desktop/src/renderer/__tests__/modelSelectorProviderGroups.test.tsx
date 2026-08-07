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

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const floatingUiMocks = vi.hoisted(() => {
  const limitShiftResult = { fn: () => ({ x: 0, y: 0 }), options: {} };
  return {
    autoUpdate: vi.fn(() => () => {}),
    flip: vi.fn((options: unknown) => ({ name: 'flip', options })),
    limitShift: vi.fn(() => limitShiftResult),
    limitShiftResult,
    offset: vi.fn((options: unknown) => ({ name: 'offset', options })),
    shift: vi.fn((options: unknown) => ({ name: 'shift', options })),
    size: vi.fn((options: unknown) => ({ name: 'size', options })),
    useFloating: vi.fn(),
  };
});

vi.mock('@floating-ui/react-dom', () => ({
  autoUpdate: floatingUiMocks.autoUpdate,
  flip: floatingUiMocks.flip,
  limitShift: floatingUiMocks.limitShift,
  offset: floatingUiMocks.offset,
  shift: floatingUiMocks.shift,
  size: floatingUiMocks.size,
  useFloating: (options: unknown) => {
    floatingUiMocks.useFloating(options);
    return {
      refs: { setFloating: () => {} },
      floatingStyles: { position: 'fixed', left: 120, top: 24 },
      isPositioned: true,
      placement: 'left',
    };
  },
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
    PopoverContent: React.forwardRef<
      HTMLDivElement,
      {
        children: React.ReactNode;
        className?: string;
        collisionPadding?:
          | number
          | {
              top?: number;
              right?: number;
              bottom?: number;
              left?: number;
            };
      }
    >(({ children, className, collisionPadding }, ref) => {
      const state = React.useContext(OpenContext);
      const collisionPaddingTop =
        typeof collisionPadding === 'number' ? collisionPadding : collisionPadding?.top;
      return state.open
        ? React.createElement(
            'div',
            {
              ref,
              'data-testid': 'model-options-popover',
              'data-collision-padding-top': collisionPaddingTop,
              className,
            },
            children,
          )
        : null;
    }),
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
  floatingUiMocks.autoUpdate.mockClear();
  floatingUiMocks.flip.mockClear();
  floatingUiMocks.limitShift.mockClear();
  floatingUiMocks.offset.mockClear();
  floatingUiMocks.shift.mockClear();
  floatingUiMocks.size.mockClear();
  floatingUiMocks.useFloating.mockClear();
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

type FloatingOptions = {
  strategy: string;
  placement: string;
  transform: boolean;
  open: boolean;
  elements: { reference: HTMLElement };
  whileElementsMounted: (
    reference: HTMLElement,
    floating: HTMLElement,
    update: () => void,
  ) => () => void;
};

function floatingOptionsForReference(reference: HTMLElement): FloatingOptions {
  // React/Floating UI 可能因并发重渲染产生多次调用；按「当前连接锚点 + open」取值，
  // 守护实际生效的浮层，而不是把调用顺序误当成契约。
  const options = floatingUiMocks.useFloating.mock.calls
    .map(([call]) => call as FloatingOptions)
    .findLast((call) => call.open && call.elements?.reference === reference);
  expect(options).toBeDefined();
  if (!options) throw new Error('Floating UI options for the active model row were not found');
  return options;
}

function sizeOptionsForFloatingPanel(): {
  apply: (args: { elements: { floating: HTMLElement }; availableHeight: number }) => void;
} {
  // size middleware 的行为由其稳定参数和 apply 回调表达；匹配参数可避开其它渲染留下的调用。
  const options = floatingUiMocks.size.mock.calls
    .map(
      ([call]) =>
        call as {
          padding?: number;
          boundary?: Element[];
          altBoundary?: boolean;
          apply?: (args: { elements: { floating: HTMLElement }; availableHeight: number }) => void;
        },
    )
    .findLast(
      (call) =>
        call.padding === 8 &&
        Array.isArray(call.boundary) &&
        call.boundary.length === 0 &&
        call.altBoundary === false &&
        typeof call.apply === 'function',
    );
  expect(options).toBeDefined();
  if (!options?.apply) throw new Error('Floating UI size middleware was not configured');
  return { apply: options.apply };
}

async function openModelOptionsPanel(row: HTMLElement): Promise<void> {
  await act(async () => {
    // ArrowLeft 是模型行公开支持的配置入口；调用前由用例等待 MorphPopover 的 settle 焦点，
    // 避免把异步焦点交接顺序误当成浮层锚点契约。
    fireEvent.keyDown(row, { key: 'ArrowLeft' });
  });
}

async function waitForSearchInputFocus(): Promise<HTMLElement> {
  const searchInput = screen.getByRole('textbox');
  // MorphPopover settle 后才把焦点交给搜索框；先等这个最终状态，避免后续 ArrowLeft
  // reveal 与尚未完成的焦点交接竞态。
  await waitFor(() => expect(document.activeElement).toBe(searchInput));
  return searchInput;
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

  it('keeps the create-agent secondary panel at the original left/center position with layout coordinates', async () => {
    renderSelector({ visualVariant: 'create-agent', useMorphPopover: true });
    await openDropdown();
    await waitForSearchInputFocus();

    const modelList = screen.getByRole('listbox', { name: 'Model list' });
    const row = within(modelList).getByRole('option', { name: /Opus 4\.8/ });
    await openModelOptionsPanel(row);

    const secondaryPanel = await screen.findByTestId('model-options-floating-panel');
    const positioner = secondaryPanel.closest<HTMLElement>('[data-radix-popper-content-wrapper]');
    expect(positioner).not.toBeNull();
    expect(positioner?.parentElement).toBe(document.body);
    expect(positioner?.style.position).toBe('fixed');
    expect(positioner?.style.left).toBe('120px');
    expect(positioner?.style.top).toBe('24px');
    // Electron app-region 依赖布局矩形，定位层不能通过 translate 重新定位；这里只守护
    // no-translate 行为，不锁定 jsdom 对空 transform 的具体序列化。
    expect(positioner?.style.transform ?? '').not.toMatch(/translate/);
    expect(
      (positioner?.style as CSSStyleDeclaration & { WebkitAppRegion: string }).WebkitAppRegion,
    ).toBe('no-drag');
    expect(secondaryPanel.className).toContain('overflow-hidden');
    expect(secondaryPanel.className).not.toContain('max-h-[');
    expect(secondaryPanel.className).not.toContain('overflow-y-auto');

    const floatingOptions = floatingOptionsForReference(row);
    expect(floatingOptions).toMatchObject({
      strategy: 'fixed',
      placement: 'left',
      transform: false,
      open: true,
    });
    expect(floatingOptions.elements.reference).toBe(row);
    const floatingElement = document.createElement('div');
    const cleanup = floatingOptions.whileElementsMounted(row, floatingElement, vi.fn());
    // autoUpdate 必须绑定当前行与浮层元素；按参数匹配，避免其它重渲染的调用顺序影响断言。
    const autoUpdateCall = floatingUiMocks.autoUpdate.mock.calls.findLast(
      (call: unknown[]) => call[0] === row && call[1] === floatingElement,
    );
    expect(autoUpdateCall).toEqual([
      row,
      floatingElement,
      expect.any(Function),
      { animationFrame: false },
    ]);
    cleanup();

    // middleware 参数保留左侧贴边、碰撞留白和可用高度回归；按参数匹配而非取最后调用，
    // 避免 React 并发重渲染改变 mock 调用顺序。
    const offsetOptions = floatingUiMocks.offset.mock.calls
      .map(([call]) => call)
      .findLast(
        (call) =>
          (call as { mainAxis?: number; alignmentAxis?: number })?.mainAxis === 8 &&
          (call as { mainAxis?: number; alignmentAxis?: number })?.alignmentAxis === 0,
      );
    expect(offsetOptions).toEqual({ mainAxis: 8, alignmentAxis: 0 });
    const shiftOptions = floatingUiMocks.shift.mock.calls
      .map(([call]) => call)
      .findLast(
        (call) =>
          (call as { mainAxis?: boolean; crossAxis?: boolean; padding?: number })?.mainAxis ===
            true &&
          (call as { mainAxis?: boolean; crossAxis?: boolean; padding?: number })?.crossAxis ===
            false &&
          (call as { mainAxis?: boolean; crossAxis?: boolean; padding?: number })?.padding === 8,
      );
    expect(shiftOptions).toEqual(
      expect.objectContaining({
        mainAxis: true,
        crossAxis: false,
        limiter: floatingUiMocks.limitShiftResult,
        padding: 8,
        boundary: [],
        altBoundary: false,
      }),
    );
    const flipOptions = floatingUiMocks.flip.mock.calls
      .map(([call]) => call)
      .findLast(
        (call) =>
          (call as { padding?: number; boundary?: Element[]; altBoundary?: boolean })?.padding ===
            8 &&
          Array.isArray(
            (call as { padding?: number; boundary?: Element[]; altBoundary?: boolean })?.boundary,
          ) &&
          (call as { padding?: number; boundary?: Element[]; altBoundary?: boolean })?.boundary
            ?.length === 0 &&
          (call as { padding?: number; boundary?: Element[]; altBoundary?: boolean })
            ?.altBoundary === false,
      );
    expect(flipOptions).toEqual({ padding: 8, boundary: [], altBoundary: false });
    const sizeOptions = sizeOptionsForFloatingPanel();
    sizeOptions.apply({ elements: { floating: floatingElement }, availableHeight: 180 });
    expect(floatingElement.style.getPropertyValue('--radix-popover-content-available-height')).toBe(
      '180px',
    );

    const panelOptions = within(secondaryPanel).getAllByRole('option');
    const firstPanelOption = panelOptions[0];
    const lastPanelOption = panelOptions.at(-1);
    expect(lastPanelOption).toBeDefined();
    lastPanelOption?.focus();
    fireEvent.keyDown(lastPanelOption as HTMLElement, { key: 'Tab' });
    expect(document.activeElement).toBe(firstPanelOption);
    fireEvent.keyDown(firstPanelOption, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(lastPanelOption);

    fireEvent.keyDown(row, { key: 'Escape' });
    // Escape 关闭的是行级浮层，一级模型列表仍保持打开；等待两个最终 DOM 状态而非依赖
    // keydown 后 React 同步 flush 的具体顺序。
    await waitFor(() => {
      expect(screen.queryByTestId('model-options-floating-panel')).toBeNull();
      expect(screen.getByRole('listbox', { name: 'Model list' })).toBeTruthy();
    });
  });

  it('refreshes the create-agent floating anchor after search remounts the active model row', async () => {
    renderSelector({ visualVariant: 'create-agent', useMorphPopover: true });
    await openDropdown();

    const searchInput = await waitForSearchInputFocus();

    const modelList = screen.getByRole('listbox', { name: 'Model list' });
    const originalRow = within(modelList).getByRole('option', { name: /Opus 4\.8/ });
    await openModelOptionsPanel(originalRow);
    await screen.findByTestId('model-options-floating-panel');

    const originalFloatingOptions = floatingOptionsForReference(originalRow);
    expect(originalFloatingOptions.elements.reference).toBe(originalRow);

    await act(async () => {
      fireEvent.change(searchInput, { target: { value: 'qwen' } });
    });
    // 搜索过滤会卸载旧行，行级浮层必须随之关闭，不能继续引用 detached DOM；这是行为契约，
    // 不依赖 useFloating 的渲染/调用次数。
    await waitFor(() => {
      expect(originalRow.isConnected).toBe(false);
      expect(screen.queryByTestId('model-options-floating-panel')).toBeNull();
    });

    await act(async () => {
      fireEvent.change(searchInput, { target: { value: '' } });
    });
    // 清空搜索会重新挂载新行，但旧 editing 状态不能让浮层自动复活或把新行误标 active。
    await waitFor(() => {
      const restoredRow = within(modelList).getByRole('option', { name: /Opus 4\.8/ });
      expect(restoredRow).not.toBe(originalRow);
      expect(restoredRow.getAttribute('data-model-options-active')).toBeNull();
      expect(screen.queryByTestId('model-options-floating-panel')).toBeNull();
    });
    const restoredRow = within(modelList).getByRole('option', { name: /Opus 4\.8/ });

    await openModelOptionsPanel(restoredRow);
    await screen.findByTestId('model-options-floating-panel');

    const restoredFloatingOptions = floatingOptionsForReference(restoredRow);
    expect(restoredFloatingOptions.elements.reference).toBe(restoredRow);
    expect(restoredFloatingOptions.elements.reference.isConnected).toBe(true);
  });

  it('keeps the existing Radix secondary popover outside the create-agent variant', async () => {
    renderSelector();
    await openDropdown();

    const popover = screen.getByTestId('model-options-popover');
    const row = within(popover).getByRole('option', { name: /Opus 4\.8/ });
    await act(async () => {
      fireEvent.pointerEnter(row);
    });

    const details = screen.getByRole('group', { name: /Opus 4\.8/ });
    const secondaryPanel = details.closest('[data-testid="model-options-popover"]');
    expect(secondaryPanel?.getAttribute('data-collision-padding-top')).toBe('8');
    expect(screen.queryByTestId('model-options-floating-panel')).toBeNull();
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
