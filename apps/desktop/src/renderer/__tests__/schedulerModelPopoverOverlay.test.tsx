// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/components/ui/popover', () => {
  const PopoverState = React.createContext<{
    open: boolean;
    onOpenChange?: (open: boolean) => void;
  }>({ open: false });
  return {
    Popover: ({
      children,
      open = false,
      onOpenChange,
    }: {
      children: React.ReactNode;
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
    }) => (
      <PopoverState.Provider value={{ open, onOpenChange }}>
        {children}
      </PopoverState.Provider>
    ),
    PopoverTrigger: ({ children }: { children: React.ReactNode }) => {
      const state = React.useContext(PopoverState);
      const child = children as React.ReactElement<{ onClick?: React.MouseEventHandler }>;
      return React.cloneElement(child, {
        onClick: (event) => {
          child.props.onClick?.(event);
          state.onOpenChange?.(!state.open);
        },
      });
    },
    PopoverContent: ({
      children,
      className,
      onWheel,
    }: {
      children: React.ReactNode;
      className?: string;
      onWheel?: React.WheelEventHandler<HTMLDivElement>;
    }) => (
      <div data-testid="model-popover" className={className} onWheel={onWheel}>
        {children}
      </div>
    ),
  };
});

vi.mock('@/components/new-chat/ModelSelector', () => ({
  ModelSelectorContent: ({ overlayContentClassName }: { overlayContentClassName?: string }) => (
    <div data-testid="model-selector-content" data-overlay-class={overlayContentClassName} />
  ),
  ModelIconMark: () => null,
}));

vi.mock('@/hooks/useAgentCapabilities', () => ({
  getCachedCapabilities: () => null,
  useAgentCapabilities: () => ({
    capabilities: {
      availableModels: [
        {
          id: 'claude-opus-4-8',
          displayName: 'Opus 4.8',
          efforts: ['high'],
          defaultEffort: 'high',
        },
      ],
    },
  }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: [] }),
}));

import { ModelEffortChip } from '@/features/scheduler/components/ScheduleChips';

const requestProviderModelsAutoRefresh = vi.fn(async () => ({ ok: true as const }));

beforeEach(() => {
  requestProviderModelsAutoRefresh.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: { requestProviderModelsAutoRefresh },
  };
});

describe('scheduler model popover overlay behavior', () => {
  it('keeps wheel events inside the model popover and raises nested model options above it', () => {
    const onOuterWheel = vi.fn();

    render(
      <div onWheel={onOuterWheel}>
        <ModelEffortChip
          agentKind="claude-code"
          modelValue="claude-opus-4-8"
          onChangeModel={vi.fn()}
          effortValue="high"
          onChangeEffort={vi.fn()}
          providerId=""
          onChangeProviderId={vi.fn()}
        />
      </div>,
    );

    fireEvent.wheel(screen.getByTestId('model-selector-content'), { deltaY: 120 });

    expect(onOuterWheel).not.toHaveBeenCalled();
    expect(screen.getByTestId('model-selector-content').getAttribute('data-overlay-class')).toBe(
      'z-[10020]',
    );
  });

  it('requests a silent refresh when the scheduler model selector opens', async () => {
    render(
      <ModelEffortChip
        agentKind="claude-code"
        modelValue="claude-opus-4-8"
        onChangeModel={vi.fn()}
        effortValue="high"
        onChangeEffort={vi.fn()}
        providerId=""
        onChangeProviderId={vi.fn()}
      />,
    );

    // 打开既发起刷新、又把「发现在途」状态推给下拉内容(见 useModelDiscoveryPending):
    // 那次刷新 resolve 后还有一次 setPending(false) 落在微任务里,所以要走 act。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Opus 4\.8/ }));
    });
    expect(requestProviderModelsAutoRefresh).toHaveBeenCalledWith('model-selector-open');
  });
});
