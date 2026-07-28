// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Effort } from '@/lib/userPreferences.types';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (
      key: string,
      options?: {
        defaultValue?: string;
        input?: string;
        output?: string;
        source?: string;
        value?: string;
        model?: string;
        agent?: string;
        effort?: string;
        price?: string;
        percent?: string;
        rate?: string;
      },
    ) => {
      const translations: Record<string, string> = {
        'effortLevels.xhigh': '超高',
        'settings.providers.anthropic.title': 'Anthropic',
        'newChat.modelSelector.trigger.placeholder': '选择模型',
        'newChat.modelSelector.trigger.agent.claudeCode': 'Claude Code',
        'newChat.modelSelector.trigger.agent.codex': 'Codex',
        'newChat.modelSelector.pricing.free': '限时免费',
        'newChat.modelSelector.source.disconnected': '已断开',
      };
      if (key === 'newChat.modelSelector.priceTip') {
        return `Input ${options?.input} · Output ${options?.output} per 1M tokens`;
      }
      if (key === 'newChat.modelSelector.meta.context') {
        return `${options?.value} context`;
      }
      if (key === 'newChat.modelSelector.source.viaSource') {
        return `Source: ${options?.source}`;
      }
      if (key === 'newChat.modelSelector.trigger.aria') {
        return `Select model. Current: ${options?.model}`;
      }
      if (key === 'newChat.modelSelector.trigger.ariaWithEffort') {
        return `Select model. Current: ${options?.model}, effort: ${options?.effort}`;
      }
      if (key === 'newChat.modelSelector.trigger.agent.pending') {
        return `Next: ${options?.agent}`;
      }
      if (key === 'newChat.modelSelector.trigger.pendingAria') {
        return `Select model. Next message: ${options?.agent} · ${options?.model}`;
      }
      if (key === 'newChat.modelSelector.trigger.pendingAriaWithEffort') {
        return `Select model. Next message: ${options?.agent} · ${options?.model}, effort: ${options?.effort}`;
      }
      if (key === 'newChat.modelSelector.pricing.discount') {
        return `立省 ${options?.percent}%`;
      }
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
        onClick: (event) => {
          child.props.onClick?.(event);
          state.onOpenChange?.(!state.open);
        },
      });
    },
    PopoverAnchor: ({ children }: { children: React.ReactNode }) => children,
    PopoverContent: ({
      children,
      className,
      align,
      sideOffset,
      onPointerEnter,
      onPointerLeave,
    }: {
      children: React.ReactNode;
      className?: string;
      align?: 'start' | 'center' | 'end';
      sideOffset?: number;
      onPointerEnter?: React.PointerEventHandler<HTMLDivElement>;
      onPointerLeave?: React.PointerEventHandler<HTMLDivElement>;
    }) => {
      const state = React.useContext(OpenContext);
      return state.open
        ? React.createElement(
            'div',
            {
              className,
              'data-testid': 'model-options-popover',
              'data-align': align,
              'data-side-offset': sideOffset,
              onPointerEnter,
              onPointerLeave,
            },
            React.createElement('button', {
              hidden: true,
              type: 'button',
              'data-testid': 'mock-popover-dismiss',
              onClick: () => state.onOpenChange?.(false),
            }),
            children,
          )
        : null;
    },
  };
});

vi.mock('@/lib/scrollbarAutoHide', () => ({
  flashScrollbar: vi.fn(),
}));

const agentCapabilitiesRef = vi.hoisted(() => {
  const DEFAULT_CAPABILITIES = {
    availableModels: [
      {
        id: 'claude-opus-4-8',
        displayName: 'Opus 4.8',
        description: 'Most capable for ambitious work',
        contextWindow: 200000,
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'high',
        effortDisplayNames: {
          xhigh: 'X-High',
        },
      },
      {
        id: 'claude-sonnet-4-6',
        displayName: 'Sonnet 4.6',
        contextWindow: 200000,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
      },
      {
        id: 'claude-haiku-4-5',
        displayName: 'Haiku 4.5',
        description: 'Fastest for quick answers',
        contextWindow: 200000,
        efforts: [],
        defaultEffort: null,
      },
    ],
    effortLevels: [{ id: 'xhigh', displayName: 'X-High' }],
    hasFastMode: false,
  };
  return { DEFAULT_CAPABILITIES, capabilities: DEFAULT_CAPABILITIES as unknown };
});
vi.mock('@/hooks/useAgentCapabilities', () => ({
  useAgentCapabilities: () => ({ capabilities: agentCapabilitiesRef.capabilities }),
}));

vi.mock('@/hooks/useApiKey', () => ({
  useApiKey: () => ({ hasSavedKey: true }),
}));

vi.mock('@/hooks/useConnectedSource', () => ({
  useConnectedSource: (agent: string | null, modelId?: string) => ({
    hasConnectedSource:
      !agent ||
      !modelId ||
      (agent === 'claude-code' && modelId.startsWith('claude-')) ||
      (agent === 'codex' && modelId === 'gpt-5.5'),
    loading: false,
  }),
}));

const pricingRef = vi.hoisted(() => {
  const DEFAULT_PRICING = {
    anthropic: {
      'claude-opus-4-8': {
        providerId: 'anthropic',
        modelId: 'claude-opus-4-8',
        currency: 'USD',
        source: 'subscription-reference',
        approximate: true,
        inputPerMtok: 3,
        outputPerMtok: 15,
        cacheReadPerMtok: 0.3,
        cacheCreatePerMtok: 3.75,
      },
    },
  };
  return { DEFAULT_PRICING, pricing: DEFAULT_PRICING as unknown, renderCalls: 0 };
});
vi.mock('@/hooks/useModelPricing', () => ({
  useModelPricing: () => {
    pricingRef.renderCalls += 1;
    return pricingRef.pricing;
  },
}));

// 可变 providers mock:默认 = anthropic fixture(分段/hover 用例依赖),
// 个别来源解析用例可临时替换,用完必须还原 DEFAULT_PROVIDERS。
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
            description: 'Most capable for ambitious work',
            contextWindow: 200000,
            efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
            defaultEffort: 'high',
          },
          {
            id: 'claude-sonnet-4-6',
            name: 'Sonnet 4.6',
            contextWindow: 200000,
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'medium',
          },
          {
            id: 'claude-haiku-4-5',
            name: 'Haiku 4.5',
            description: 'Fastest for quick answers',
            contextWindow: 200000,
            efforts: [],
            defaultEffort: null,
          },
        ],
      },
    },
  ] as unknown[];
  return { DEFAULT_PROVIDERS, providers: DEFAULT_PROVIDERS };
});
vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: providersRef.providers }),
}));

const deviceProvidersRef = vi.hoisted(() => ({ providers: [] as unknown[] }));
vi.mock('@/hooks/useDeviceProviders', () => ({
  useDeviceProviders: () => ({ providers: deviceProvidersRef.providers, loading: false }),
}));

interface VisibleModelFixture {
  id: string;
  displayName: string;
  description?: string;
  contextWindow: number;
  efforts: string[];
  defaultEffort: string | null;
  effortDisplayNames?: Record<string, string>;
  supportsFastMode?: boolean;
}

const visibleModelsRef = vi.hoisted(() => ({
  models: null as VisibleModelFixture[] | null,
}));
vi.mock('@/lib/providerModels', () => ({
  providerMonogram: (name: string) => name.slice(0, 1).toUpperCase(),
  // #245 新增:ModelSelector 渲染路径直接调用;fixture providers 无 routing,按不过滤透传。
  isChatBridgedCodexProvider: () => false,
  filterChatBridgedCodexProviders: (providers: unknown[]) => providers,
  resolveVisibleModelAgentKind: ({ agentKind }: { agentKind: 'claude-code' | 'codex' | null }) =>
    agentKind ?? 'claude-code',
  selectVisibleModels: ({ agentKind }: { agentKind: 'claude-code' | 'codex' | null }) => {
    if (visibleModelsRef.models) return visibleModelsRef.models;
    return [
      {
        id: 'claude-opus-4-8',
        displayName: 'Opus 4.8',
        description: 'Most capable for ambitious work',
        contextWindow: 200000,
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'high',
        effortDisplayNames: {
          xhigh: 'X-High',
        },
      },
      {
        id: 'claude-sonnet-4-6',
        displayName: 'Sonnet 4.6',
        contextWindow: 200000,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
      },
      {
        id: 'claude-haiku-4-5',
        displayName: 'Haiku 4.5',
        description: 'Fastest for quick answers',
        contextWindow: 200000,
        efforts: [],
        defaultEffort: null,
      },
      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        contextWindow: 400000,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
      },
    ].filter((model) => {
      if (agentKind === 'claude-code') return model.id.startsWith('claude-');
      if (agentKind === 'codex') return model.id.startsWith('gpt-');
      return true;
    });
  },
}));

const modelVisibilityRef = vi.hoisted(
  (): {
    isEnabled: (agent: string, providerId: string, model: { id: string }) => boolean;
  } => ({
    isEnabled: () => true,
  }),
);
vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: (agent: string, providerId: string, model: { id: string }) =>
    modelVisibilityRef.isEnabled(agent, providerId, model),
  useModelVisibilityVersion: () => 0,
}));

vi.mock('@/state/providerModelMemory', () => ({
  useProviderModelMemoryVersion: () => 0,
}));

vi.mock('@/state/deviceLinkModelMirror', () => ({
  useDeviceLinkModelMirrorVersion: () => 0,
}));

import {
  ModelSelector,
  ModelSelectorContent,
  modelEffortLabel,
  modelListMaxHeightForRows,
  resolveModelSelectorAgentIdentity,
} from '@/components/new-chat/ModelSelector';
import { makerChatStore } from '@/lib/makerChatStore';

const requestProviderModelsAutoRefresh = vi.fn(async () => ({ ok: true as const }));

beforeEach(() => {
  requestProviderModelsAutoRefresh.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: { requestProviderModelsAutoRefresh },
  };
});

describe('ModelSelector trigger variants', () => {
  it('requests a silent refresh when a local selector opens, but not for a remote device', () => {
    const local = render(
      React.createElement(ModelSelector, {
        modelId: 'claude-opus-4-8',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Current: Opus 4\.8/ }));
    expect(requestProviderModelsAutoRefresh).toHaveBeenCalledWith('model-selector-open');
    fireEvent.click(screen.getByRole('button', { name: /Current: Opus 4\.8/ }));
    fireEvent.click(screen.getByRole('button', { name: /Current: Opus 4\.8/ }));
    expect(requestProviderModelsAutoRefresh).toHaveBeenCalledTimes(2);
    local.unmount();

    requestProviderModelsAutoRefresh.mockClear();
    render(
      React.createElement(ModelSelector, {
        modelId: 'claude-opus-4-8',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
        deviceId: 'remote-device',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Current: Opus 4\.8/ }));
    expect(requestProviderModelsAutoRefresh).not.toHaveBeenCalled();
  });

  it('keeps row-count caps finite and within the shared 300px ceiling', () => {
    expect(modelListMaxHeightForRows()).toBeUndefined();
    expect(modelListMaxHeightForRows(Number.NaN)).toBeUndefined();
    expect(modelListMaxHeightForRows(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(modelListMaxHeightForRows(0)).toBe(36);
    expect(modelListMaxHeightForRows(6)).toBe(226);
    expect(modelListMaxHeightForRows(7)).toBe(264);
    expect(modelListMaxHeightForRows(8)).toBe(300);
    expect(modelListMaxHeightForRows(100)).toBe(300);
  });

  it('bounds the default-session trigger in narrow and ultra-narrow composers', () => {
    const props = {
      modelId: 'claude-opus-4-8',
      effort: 'xhigh' as Effort,
      onModelChange: vi.fn(),
      onEffortChange: vi.fn(),
      vendorKey: 'cc' as const,
      compactToolbar: true,
    };
    const view = render(React.createElement(ModelSelector, props));

    let trigger = screen.getByRole('button', {
      name: /Current: Opus 4\.8, effort: 超高/,
    });
    expect(trigger.className).toContain('w-[148px]');
    expect(trigger.className).toContain('min-w-[72px]');
    expect(within(trigger).getByText('Opus 4.8').className).toContain('truncate');
    expect(trigger.textContent).not.toContain('超高');

    view.rerender(
      React.createElement(ModelSelector, {
        ...props,
        ultraCompactToolbar: true,
      }),
    );
    trigger = screen.getByRole('button', {
      name: /Current: Opus 4\.8, effort: 超高/,
    });
    expect(trigger.className).toContain('w-[64px]');
    expect(trigger.className).toContain('min-w-[64px]');
    expect(within(trigger).getByText('Opus 4.8').className).toContain('hidden');
    // 可及名仍保留完整模型 + effort，视觉仅收起文字，不丢选择能力。
    expect(trigger.getAttribute('aria-label')).toContain('Opus 4.8');
    expect(trigger.getAttribute('aria-label')).toContain('超高');
  });

  it('keeps the session Agent explicit when Claude Code uses an OpenAI-branded model', () => {
    const model = {
      id: 'chatgpt/gpt-5.6-terra',
      displayName: 'GPT-5.6-Terra',
      contextWindow: 400000,
      efforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
    };
    visibleModelsRef.models = [model];
    providersRef.providers = [
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'builtin',
        agents: ['claude-code'],
        auth: { method: 'oauth' },
        routing: { 'claude-code': {} },
        connected: true,
        models: {
          'claude-code': [
            {
              id: model.id,
              name: model.displayName,
              contextWindow: model.contextWindow,
              efforts: model.efforts,
              defaultEffort: model.defaultEffort,
            },
          ],
        },
      },
    ];

    try {
      const props = {
        modelId: model.id,
        effort: 'medium' as Effort,
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc' as const,
        currentProviderId: 'openai',
        agentIdentity: { vendorKey: 'cc' as const, state: 'current' as const },
      };
      const view = render(React.createElement(ModelSelector, props));

      let trigger = screen.getByRole('button', {
        name: /Current: Claude Code · GPT-5\.6-Terra, effort: medium/,
      });
      expect(trigger.textContent).toContain('Claude Code');
      expect(trigger.textContent).toContain('GPT-5.6-Terra');
      expect(trigger.getAttribute('title')).toBe('Claude Code · GPT-5.6-Terra');

      view.rerender(
        React.createElement(ModelSelector, {
          ...props,
          compactToolbar: true,
        }),
      );
      trigger = screen.getByRole('button', {
        name: /Current: Claude Code · GPT-5\.6-Terra, effort: medium/,
      });
      expect(trigger.textContent).not.toContain('Claude Code');
      expect(trigger.getAttribute('aria-label')).toContain('Claude Code');
    } finally {
      visibleModelsRef.models = null;
      providersRef.providers = providersRef.DEFAULT_PROVIDERS;
    }
  });

  it('does not infer a current Agent from the fallback vendor before session identity loads', () => {
    render(
      React.createElement(ModelSelector, {
        modelId: 'claude-opus-4-8',
        effort: 'high' as Effort,
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
        agentIdentity: resolveModelSelectorAgentIdentity(null, null),
      }),
    );

    const trigger = screen.getByRole('button', { name: /Current: Opus 4\.8/ });
    expect(trigger.textContent).not.toContain('Claude Code');
    expect(trigger.getAttribute('aria-label')).not.toContain('Claude Code');
  });

  it('keeps the disconnected status in the compact trigger title', () => {
    render(
      React.createElement(ModelSelector, {
        modelId: 'claude-opus-4-8',
        effort: 'xhigh' as Effort,
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
        compactToolbar: true,
        currentProviderId: 'anthropic',
        sourceDisconnected: true,
      }),
    );

    const trigger = screen.getByRole('button', {
      name: /已断开: Opus 4\.8/,
    });
    expect(trigger.getAttribute('title')).toBe('已断开: Opus 4.8');
    // compact 隐藏冗余状态文案，但 Unplug 错误图标与悬停 title 仍保留。
    expect(trigger.textContent).not.toContain('已断开');
  });

  it('shows the intent model and its default source after registering an agent switch', () => {
    const sessionId = 'model-selector-agent-switch-intent';
    providersRef.providers = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        connected: true,
        agents: ['claude-code'],
        routing: { 'claude-code': {} },
        models: {
          'claude-code': [
            {
              id: 'claude-opus-4-8',
              name: 'Opus 4.8',
              contextWindow: 200000,
              efforts: ['high'],
              defaultEffort: 'high',
            },
          ],
        },
      },
      {
        id: 'zeta-codex',
        name: 'Zeta Codex',
        connected: true,
        agents: ['codex'],
        routing: { codex: {} },
        models: {
          codex: [
            {
              id: 'gpt-5.5',
              name: 'GPT-5.5',
              contextWindow: 400000,
              efforts: ['medium'],
              defaultEffort: 'medium',
            },
          ],
        },
      },
    ];

    function IntentTrigger({ refresh }: { refresh: number }) {
      void refresh;
      const lightState = React.useSyncExternalStore(
        (onStoreChange) => makerChatStore.subscribeLight(sessionId, onStoreChange),
        () => makerChatStore.getLightSnapshot(sessionId),
      );
      // 复刻 CCAgentSessionView(订阅轻快照决定 vendor) + ChatInput(直接读 intent
      // 覆盖 model/provider)的组合窗口。refresh 模拟其它状态带来的无关重渲染。
      const intent = makerChatStore.getAgentSwitchIntent(sessionId);
      const displayAgent = lightState.agentSwitchIntent?.target ?? 'claude-code';
      return React.createElement(ModelSelector, {
        modelId: intent?.model ?? 'claude-opus-4-8',
        effort: (intent?.effort ?? 'high') as Effort,
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: displayAgent === 'codex' ? 'codex' : 'cc',
        // 稳态来自已加载的真实 runtime；intent 是下一条消息的明确目标，不能写成 Current。
        agentIdentity: resolveModelSelectorAgentIdentity('claude-code', intent?.target),
        currentProviderId: intent?.providerId ?? null,
        onProviderChange: vi.fn(),
        onNavigateToProviders: vi.fn(),
      });
    }

    const view = render(React.createElement(IntentTrigger, { refresh: 0 }));
    try {
      let trigger = screen.getByRole('button', {
        name: /Current: Claude Code · Opus 4\.8/,
      });
      expect(trigger.textContent).toContain('Claude Code');

      act(() => {
        makerChatStore.noteAgentSwitchIntent(sessionId, 'codex', {
          model: 'gpt-5.5',
          providerId: null,
          effort: 'medium',
        });
      });
      view.rerender(React.createElement(IntentTrigger, { refresh: 1 }));

      trigger = screen.getByRole('button', {
        name: /Next message: Codex · GPT-5\.5, effort: medium/,
      });
      expect(trigger.textContent).toContain('GPT-5.5');
      expect(trigger.textContent).toContain('Next: Codex');
      expect(trigger.getAttribute('aria-label')).not.toContain('Current');
      // 切换失败时 intent 会保留供重试；重复渲染仍明确标成“下条消息”，不会隐藏身份。
      view.rerender(React.createElement(IntentTrigger, { refresh: 2 }));
      expect(
        screen.getByRole('button', {
          name: /Next message: Codex · GPT-5\.5, effort: medium/,
        }),
      ).toBeTruthy();
      // providerId=null 仍应按目标模型的默认可连来源解析 icon。
      expect(trigger.textContent).toContain('Z');
      expect(trigger.textContent).not.toContain('newChat.modelSelector.source.connect');
    } finally {
      view.unmount();
      makerChatStore.purgeSession(sessionId);
      providersRef.providers = providersRef.DEFAULT_PROVIDERS;
    }
  });

  it('renders the field trigger as a settings input and localizes effort before provider labels', () => {
    render(
      React.createElement(ModelSelector, {
        modelId: 'claude-opus-4-8',
        effort: 'xhigh',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
        triggerVariant: 'field',
      }),
    );

    const trigger = screen.getByRole('button', {
      name: /Current: Opus 4\.8, effort: 超高/,
    });

    expect(trigger.className).toContain('w-full');
    expect(trigger.className).toContain('border-[var(--border-default)]');
    expect(trigger.className).toContain('bg-[var(--settings-input-bg)]');
    expect(trigger.textContent).toContain('Opus 4.8');
    expect(trigger.textContent).toContain('超高');
    expect(trigger.textContent).not.toContain('X-High');
    expect(trigger.querySelector('[data-model-promotion-badge]')).toBeNull();
  });

  it('keeps a long subscription-backed field menu bounded and wheel-scrollable', () => {
    const models: VisibleModelFixture[] = Array.from({ length: 40 }, (_, index) => ({
      id: `subscription-model-${index + 1}`,
      displayName: `Subscription Model ${index + 1}`,
      contextWindow: 200000,
      efforts: ['high'],
      defaultEffort: 'high',
    }));
    const originalCapabilities = agentCapabilitiesRef.capabilities;
    visibleModelsRef.models = models;
    agentCapabilitiesRef.capabilities = {
      availableModels: models,
      effortLevels: [{ id: 'high', displayName: 'High' }],
      hasFastMode: false,
    };
    providersRef.providers = [
      {
        id: 'anthropic',
        name: 'Anthropic',
        source: 'builtin',
        agents: ['claude-code'],
        auth: { method: 'oauth' },
        routing: { 'claude-code': {} },
        connected: true,
        models: {
          'claude-code': models.map((model) => ({
            ...model,
            name: model.displayName,
          })),
        },
      },
    ];

    try {
      render(
        React.createElement(ModelSelector, {
          modelId: models[0].id,
          effort: 'high',
          onModelChange: vi.fn(),
          onEffortChange: vi.fn(),
          vendorKey: 'cc',
          triggerVariant: 'field',
          currentProviderId: 'anthropic',
          onProviderChange: vi.fn(),
        }),
      );

      fireEvent.click(screen.getByRole('button', { name: /Current: Subscription Model 1/ }));
      const list = screen.getByRole('listbox', { name: 'Model list' });

      expect(list.className).toContain('max-h-[300px]');
      expect(list.className).toContain('overflow-y-auto');
      expect(list.className).toContain('overscroll-contain');
      const options = within(list).getAllByRole('option');
      expect(options).toHaveLength(40);
      expect(options[0].textContent).toContain('Subscription Model 1');
      expect(options[39].textContent).toContain('Subscription Model 40');
    } finally {
      visibleModelsRef.models = null;
      agentCapabilitiesRef.capabilities = originalCapabilities;
      providersRef.providers = providersRef.DEFAULT_PROVIDERS;
    }
  });

  it('reuses the parent pricing snapshot when the model content opens', () => {
    pricingRef.renderCalls = 0;
    render(
      React.createElement(ModelSelector, {
        modelId: 'claude-opus-4-8',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
      }),
    );
    expect(pricingRef.renderCalls).toBe(1);

    pricingRef.renderCalls = 0;
    fireEvent.click(screen.getByRole('button', { name: /Current: Opus 4\.8/ }));
    expect(pricingRef.renderCalls).toBe(1);
  });

  it('shows Gateway discount and free promotions in the selected-model trigger', () => {
    providersRef.providers = [
      {
        id: 'xd',
        name: 'Cindy AI',
        connected: true,
        agents: ['claude-code'],
        routing: { 'claude-code': {} },
        models: {
          'claude-code': [
            {
              id: 'claude-opus-4-8',
              name: 'Opus 4.8',
              contextWindow: 200000,
              efforts: ['high'],
              defaultEffort: 'high',
              cost: { input: 6, output: 18, cacheRead: 1.2, cacheWrite: 7.5 },
            },
            {
              id: 'claude-sonnet-4-6',
              name: 'Sonnet 4.6',
              contextWindow: 200000,
              efforts: ['medium'],
              defaultEffort: 'medium',
              cost: { input: 0, output: 0 },
            },
          ],
        },
      },
    ];
    pricingRef.pricing = {
      xd: {
        'claude-opus-4-8': {
          providerId: 'xd',
          modelId: 'claude-opus-4-8',
          currency: 'CNY',
          source: 'gateway',
          approximate: false,
          inputPerMtok: 12,
          outputPerMtok: 36,
          cacheReadPerMtok: 2.4,
          cacheCreatePerMtok: 15,
        },
      },
    };

    try {
      const discounted = render(
        React.createElement(ModelSelector, {
          modelId: 'claude-opus-4-8',
          effort: 'high',
          onModelChange: vi.fn(),
          onEffortChange: vi.fn(),
          vendorKey: 'cc',
          currentProviderId: 'xd',
          onProviderChange: vi.fn(),
        }),
      );
      const discountTrigger = screen.getByRole('button', { name: /Current: Opus 4\.8/ });
      const discountBadge = within(discountTrigger).getByText('立省 50%');
      expect(discountBadge.hasAttribute('data-model-promotion-badge')).toBe(true);
      expect(discountBadge.className).toContain('bg-[var(--accent-cta-bg)]');
      expect(discountBadge.className).toContain('text-[var(--accent-pure-cta-fg)]');
      discounted.unmount();

      pricingRef.pricing = {};
      render(
        React.createElement(ModelSelector, {
          modelId: 'claude-sonnet-4-6',
          effort: 'medium',
          onModelChange: vi.fn(),
          onEffortChange: vi.fn(),
          vendorKey: 'cc',
          currentProviderId: 'xd',
          onProviderChange: vi.fn(),
        }),
      );
      expect(
        within(screen.getByRole('button', { name: /Current: Sonnet 4\.6/ })).getByText('限时免费'),
      ).toBeTruthy();
    } finally {
      providersRef.providers = providersRef.DEFAULT_PROVIDERS;
      pricingRef.pricing = pricingRef.DEFAULT_PRICING;
    }
  });

  it('does not mix controller prices with remote provider costs', () => {
    deviceProvidersRef.providers = [
      {
        id: 'xd',
        name: 'Cindy AI',
        connected: true,
        agents: ['claude-code'],
        routing: { 'claude-code': {} },
        models: {
          'claude-code': [
            {
              id: 'claude-opus-4-8',
              name: 'Opus 4.8',
              contextWindow: 200000,
              efforts: ['high'],
              defaultEffort: 'high',
              cost: { input: 6, output: 18 },
            },
          ],
        },
      },
    ];
    pricingRef.pricing = {
      xd: {
        'claude-opus-4-8': {
          providerId: 'xd',
          modelId: 'claude-opus-4-8',
          currency: 'CNY',
          source: 'gateway',
          approximate: false,
          inputPerMtok: 12,
          outputPerMtok: 36,
        },
      },
    };

    try {
      const triggerView = render(
        React.createElement(ModelSelector, {
          modelId: 'claude-opus-4-8',
          effort: 'high',
          onModelChange: vi.fn(),
          onEffortChange: vi.fn(),
          vendorKey: 'cc',
          deviceId: 'remote-device',
          currentProviderId: 'xd',
          onProviderChange: vi.fn(),
        }),
      );
      expect(
        screen
          .getByRole('button', { name: /Current: Opus 4\.8/ })
          .querySelector('[data-model-promotion-badge]'),
      ).toBeNull();
      triggerView.unmount();

      render(
        React.createElement(ModelSelectorContent, {
          modelId: 'claude-opus-4-8',
          effort: 'high',
          onModelChange: vi.fn(),
          onEffortChange: vi.fn(),
          vendorKey: 'cc',
          deviceId: 'remote-device',
          currentProviderId: 'xd',
          onProviderChange: vi.fn(),
        }),
      );
      const row = screen.getByRole('option', { name: /Opus 4\.8/ });
      expect(row.textContent).not.toContain('¥12 / ¥36');
      expect(row.textContent).not.toContain('¥6 / ¥18');
      expect(row.querySelector('[data-model-promotion-badge]')).toBeNull();

      fireEvent.pointerEnter(row);
      expect(
        within(screen.getByRole('group', { name: /Opus 4\.8/ })).queryByText(
          'newChat.modelSelector.pricing.title',
        ),
      ).toBeNull();
    } finally {
      deviceProvidersRef.providers = [];
      pricingRef.pricing = pricingRef.DEFAULT_PRICING;
    }
  });

  it('uses model effort display names only as fallback when i18n has no translation', () => {
    const t = (key: string, options?: { defaultValue?: string }) =>
      key === 'effortLevels.xhigh' ? '超高' : (options?.defaultValue ?? key);

    expect(
      modelEffortLabel(t, { effortDisplayNames: { xhigh: 'Extra High' } }, 'xhigh', 'X-High'),
    ).toBe('超高');
    expect(modelEffortLabel(t, { effortDisplayNames: { xhigh: 'Extra High' } }, 'max', 'Max')).toBe(
      'Max',
    );
  });

  it.each([
    {
      agentKind: 'claude-code' as const,
      vendorKey: 'cc' as const,
      currentModel: {
        id: 'claude-opus-4-8',
        displayName: 'Opus 4.8',
        contextWindow: 200000,
        efforts: ['high'],
        defaultEffort: 'high',
        supportsFastMode: false,
      },
      seedEfforts: ['low', 'medium', 'high'],
      seedDefaultEffort: 'low',
      seedLabel: 'Low',
      glmEfforts: ['high', 'max'],
    },
    {
      agentKind: 'codex' as const,
      vendorKey: 'codex' as const,
      currentModel: {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        contextWindow: 400000,
        efforts: ['high'],
        defaultEffort: 'high',
        supportsFastMode: false,
      },
      seedEfforts: ['minimal', 'low', 'medium', 'high'],
      seedDefaultEffort: 'minimal',
      seedLabel: 'Minimal',
      glmEfforts: ['minimal', 'high', 'max'],
    },
  ])(
    'renders the corrected XD effort defaults without Fast markers for $agentKind',
    ({ agentKind, vendorKey, currentModel, seedEfforts, seedDefaultEffort, seedLabel, glmEfforts }) => {
      const targetModels: VisibleModelFixture[] = [
        {
          id: 'bytedance-seed/seed-2.1-pro',
          displayName: 'Seed 2.1 Pro',
          contextWindow: 256000,
          efforts: seedEfforts,
          defaultEffort: seedDefaultEffort,
          supportsFastMode: false,
        },
        {
          id: 'moonshotai/kimi-k3',
          displayName: 'Kimi K3',
          contextWindow: 1000000,
          efforts: ['low', 'high', 'max'],
          defaultEffort: 'max',
          supportsFastMode: false,
        },
        {
          id: 'qwen/qwen3.8-max-preview',
          displayName: 'Qwen 3.8 Max Preview',
          contextWindow: 983616,
          efforts: ['low', 'high', 'xhigh'],
          defaultEffort: 'xhigh',
          supportsFastMode: false,
        },
        {
          id: 'z-ai/glm-5.2',
          displayName: 'GLM-5.2',
          contextWindow: 1000000,
          efforts: glmEfforts,
          defaultEffort: 'max',
          supportsFastMode: false,
        },
        {
          id: 'deepseek/deepseek-v4-pro',
          displayName: 'DeepSeek V4 Pro',
          contextWindow: 1048576,
          efforts: ['high', 'max'],
          defaultEffort: 'high',
          supportsFastMode: false,
        },
        {
          id: 'deepseek/deepseek-v4-flash',
          displayName: 'DeepSeek V4 Flash',
          contextWindow: 1048576,
          efforts: ['high', 'max'],
          defaultEffort: 'high',
          supportsFastMode: false,
        },
      ];
      const originalCapabilities = agentCapabilitiesRef.capabilities;
      visibleModelsRef.models = [currentModel, ...targetModels];
      agentCapabilitiesRef.capabilities = {
        availableModels: visibleModelsRef.models,
        effortLevels: [
          { id: 'minimal', displayName: 'Minimal' },
          { id: 'low', displayName: 'Low' },
          { id: 'medium', displayName: 'Medium' },
          { id: 'high', displayName: 'High' },
          { id: 'xhigh', displayName: 'X-High' },
          { id: 'max', displayName: 'Max' },
        ],
        hasFastMode: true,
      };
      providersRef.providers = [
        {
          id: 'xd',
          name: 'Cindy',
          connected: true,
          agents: [agentKind],
          routing: { [agentKind]: {} },
          models: {
            [agentKind]: visibleModelsRef.models.map((model) => ({
              ...model,
              name: model.displayName,
            })),
          },
        },
      ];
      const modelMemory = {
        getEffort: vi.fn(),
        setEffort: vi.fn(),
        // Even a stale persisted Fast=true must not render when the model capability is false.
        getFast: vi.fn(() => true),
        setFast: vi.fn(),
      };

      try {
        render(
          React.createElement(ModelSelectorContent, {
            modelId: currentModel.id,
            effort: 'high',
            fastMode: false,
            onModelChange: vi.fn(),
            onEffortChange: vi.fn(),
            onFastModeChange: vi.fn(),
            vendorKey,
            currentProviderId: 'xd',
            onProviderChange: vi.fn(),
            modelMemory,
          }),
        );

        expect(screen.getByRole('option', { name: /Seed 2\.1 Pro/ }).textContent).toContain(
          seedLabel,
        );
        expect(screen.getByRole('option', { name: /Kimi K3/ }).textContent).toContain('Max');
        expect(screen.getByRole('option', { name: /Qwen 3\.8 Max Preview/ }).textContent).toContain(
          '超高',
        );
        expect(screen.getByRole('option', { name: /GLM-5\.2/ }).textContent).toContain('Max');
        expect(screen.getByRole('option', { name: /DeepSeek V4 Pro/ }).textContent).toContain('High');
        expect(screen.getByRole('option', { name: /DeepSeek V4 Flash/ }).textContent).toContain('High');
        expect(screen.queryByLabelText('newChat.modelSelector.meta.fastBadge')).toBeNull();
      } finally {
        visibleModelsRef.models = null;
        agentCapabilitiesRef.capabilities = originalCapabilities;
        providersRef.providers = providersRef.DEFAULT_PROVIDERS;
      }
    },
  );

  it('renders an active fallback option without model effort metadata', () => {
    render(
      React.createElement(ModelSelector, {
        modelId: '',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
        triggerVariant: 'field',
        fallbackOption: {
          active: true,
          label: '不指定（跟随原逻辑）',
          onSelect: vi.fn(),
        },
      }),
    );

    const trigger = screen.getByRole('button', { name: /不指定（跟随原逻辑）/ });
    expect(trigger.textContent).toContain('不指定（跟随原逻辑）');
    expect(trigger.textContent).not.toContain('high');
  });

  it('localizes the placeholder when the current model is unavailable', () => {
    render(
      React.createElement(ModelSelector, {
        modelId: 'missing-model',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
        triggerVariant: 'field',
      }),
    );

    expect(screen.getByRole('button', { name: /选择模型/ }).textContent).toContain('选择模型');
  });

  it('can hide model effort and Fast editing controls for model-id-only settings', () => {
    render(
      React.createElement(ModelSelectorContent, {
        modelId: 'claude-opus-4-8',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
        configurationEnabled: false,
      }),
    );

    fireEvent.pointerEnter(screen.getByRole('option', { name: /Opus 4\.8/ }));
    const information = screen.getByRole('group', { name: /Opus 4\.8/ });
    expect(within(information).getByText('Most capable for ambitious work')).toBeTruthy();
    expect(within(information).queryByRole('option')).toBeNull();
  });

  it('filters provider-ignored models from flat model-only selectors', () => {
    modelVisibilityRef.isEnabled = (_agent, _providerId, model) => model.id !== 'claude-sonnet-4-6';
    try {
      render(
        React.createElement(ModelSelectorContent, {
          modelId: '',
          effort: 'high',
          onModelChange: vi.fn(),
          onEffortChange: vi.fn(),
          vendorKey: 'cc',
          configurationEnabled: false,
        }),
      );

      expect(screen.getByRole('option', { name: /Opus 4\.8/ })).toBeTruthy();
      expect(screen.queryByRole('option', { name: /Sonnet 4\.6/ })).toBeNull();
    } finally {
      modelVisibilityRef.isEnabled = () => true;
    }
  });

  it('forwards an overlay-specific z-index to the model information panel', () => {
    render(
      React.createElement(ModelSelectorContent, {
        modelId: 'claude-opus-4-8',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
        overlayContentClassName: 'z-[10020]',
      }),
    );

    fireEvent.pointerEnter(screen.getByRole('option', { name: /Opus 4\.8/ }));
    expect(screen.getByTestId('model-options-popover').className).toContain('z-[10020]');
  });

  it('keeps non-Gateway prices in model details without repeating them in the primary row', () => {
    vi.useFakeTimers();
    render(
      React.createElement(ModelSelectorContent, {
        modelId: 'claude-opus-4-8',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
      }),
    );

    const row = screen.getByRole('option', { name: /Opus 4\.8/ });
    expect(screen.queryByRole('group', { name: /Opus 4\.8/ })).toBeNull();
    expect(screen.queryByText('newChat.modelSelector.edit')).toBeNull();

    fireEvent.pointerEnter(row);
    const options = screen.getByRole('group', { name: /Opus 4\.8/ });
    expect(screen.getByTestId('model-options-popover').getAttribute('data-align')).toBe('center');
    expect(screen.getByTestId('model-options-popover').getAttribute('data-side-offset')).toBe('8');
    expect(options).toBeTruthy();
    expect(within(options).getByText('Most capable for ambitious work')).toBeTruthy();
    expect(within(options).getByText('Source: Anthropic')).toBeTruthy();
    expect(within(options).getByText('200K context')).toBeTruthy();
    const priceTitle = within(options).getByText('newChat.modelSelector.pricing.title');
    expect(row.textContent).not.toContain('$3 / $15');
    expect(row.textContent).not.toContain('¥');
    expect(row.textContent).not.toContain('≈');
    expect(within(options).getByText('$3')).toBeTruthy();
    expect(within(options).getByText('$15')).toBeTruthy();
    expect(within(options).getByText('$0.3')).toBeTruthy();
    expect(within(options).getByText('$3.75')).toBeTruthy();
    expect(
      within(options).getByText('newChat.modelSelector.pricing.subscriptionEstimate'),
    ).toBeTruthy();
    const firstChoice = within(options).getByRole('option', { name: 'low' });
    const description = within(options).getByText('Most capable for ambitious work');
    expect(
      description.compareDocumentPosition(firstChoice) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(firstChoice.compareDocumentPosition(priceTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(row.getAttribute('data-model-options-active')).toBe('true');

    fireEvent.pointerLeave(row);
    act(() => vi.advanceTimersByTime(79));
    expect(screen.getByRole('group', { name: /Opus 4\.8/ })).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('group', { name: /Opus 4\.8/ })).toBeNull();

    fireEvent.focus(row);
    expect(screen.getByRole('group', { name: /Opus 4\.8/ })).toBeTruthy();

    // 列表滚动不派发 pointerleave,浮层会跟着滚出视口的锚点行跑到菜单外 → 用户滚动必须立即收起。
    fireEvent.scroll(screen.getByRole('listbox', { name: 'Model list' }));
    expect(screen.queryByRole('group', { name: /Opus 4\.8/ })).toBeNull();
    vi.useRealTimers();
  });

  it('keeps non-price access labels in the primary model row', () => {
    providersRef.providers = [
      {
        ...(providersRef.DEFAULT_PROVIDERS[0] as Record<string, unknown>),
        access: { kind: 'subscription', product: 'Claude Pro' },
      },
    ];

    try {
      render(
        React.createElement(ModelSelectorContent, {
          modelId: 'claude-opus-4-8',
          effort: 'high',
          onModelChange: vi.fn(),
          onEffortChange: vi.fn(),
          vendorKey: 'cc',
          currentProviderId: 'anthropic',
          onProviderChange: vi.fn(),
        }),
      );

      const row = screen.getByRole('option', { name: /Opus 4\.8/ });
      const tags = row.querySelector('[data-model-tags]');
      expect(tags).not.toBeNull();
      expect(
        within(tags as HTMLElement).getByText('settings.providers.models.subscription'),
      ).toBeTruthy();
      expect(row.textContent).not.toContain('$3 / $15');
      expect(row.querySelector('[data-model-promotion-badge]')).toBeNull();
    } finally {
      providersRef.providers = providersRef.DEFAULT_PROVIDERS;
    }
  });

  it('keeps discounted Gateway prices in details while retaining the primary-row label', () => {
    providersRef.providers = [
      {
        id: 'xd',
        name: 'Cindy AI',
        connected: true,
        agents: ['claude-code'],
        routing: { 'claude-code': {} },
        models: {
          'claude-code': [
            {
              id: 'qwen-3.7',
              name: 'Qwen 3.7',
              contextWindow: 200000,
              efforts: ['high'],
              defaultEffort: 'high',
              cost: { input: 6, output: 18, cacheRead: 1.2, cacheWrite: 7.5 },
            },
          ],
        },
      },
    ];
    pricingRef.pricing = {
      xd: {
        'qwen-3.7': {
          providerId: 'xd',
          modelId: 'qwen-3.7',
          currency: 'CNY',
          source: 'gateway',
          approximate: false,
          inputPerMtok: 12,
          outputPerMtok: 36,
          cacheReadPerMtok: 2.4,
          cacheCreatePerMtok: 15,
        },
      },
    };

    try {
      render(
        React.createElement(ModelSelectorContent, {
          modelId: 'qwen-3.7',
          effort: 'high',
          onModelChange: vi.fn(),
          onEffortChange: vi.fn(),
          vendorKey: 'cc',
          currentProviderId: 'xd',
          onProviderChange: vi.fn(),
          maxVisibleModelRows: 6,
        }),
      );

      // 一级菜单保持单行并保留折价标签；折后价和标准价只在完整详情展示。
      const row = screen.getByRole('option', { name: /Qwen 3\.7/ });
      expect(row.className).toContain('min-h-9');
      expect(within(row).getByText('Qwen 3.7').className).toContain('leading-5');
      expect(screen.getByRole('listbox', { name: 'Model list' }).style.maxHeight).toBe('226px');
      expect(row.textContent).not.toContain('¥6 / ¥18');
      expect(row.textContent).not.toContain('¥12 / ¥36');
      const rowBadge = within(row).getByText('立省 50%');
      expect(rowBadge.hasAttribute('data-model-promotion-badge')).toBe(true);
      expect(rowBadge.parentElement?.hasAttribute('data-model-tags')).toBe(true);
      expect(row.querySelector('[data-model-price-stack]')).toBeNull();

      fireEvent.pointerEnter(row);
      const details = screen.getByRole('group', { name: /Qwen 3\.7/ });
      expect(within(details).getByText('¥6')).toBeTruthy();
      expect(within(details).getByText('¥18')).toBeTruthy();
      expect(within(details).getByText('¥12').className).toContain('line-through');
      expect(within(details).getByText('¥36').className).toContain('line-through');
      // 缓存价同样按折后价展示,标准缓存价并排划线。
      expect(within(details).getByText('¥1.2')).toBeTruthy();
      expect(within(details).getByText('¥2.4').className).toContain('line-through');
      expect(within(details).getByText('¥7.5')).toBeTruthy();
      expect(within(details).getByText('¥15').className).toContain('line-through');
      const detailsBadge = within(details).getByText('立省 50%');
      expect(detailsBadge.parentElement?.hasAttribute('data-model-tags')).toBe(true);
      expect(detailsBadge.parentElement?.className).toContain('ml-auto');
    } finally {
      providersRef.providers = providersRef.DEFAULT_PROVIDERS;
      pricingRef.pricing = pricingRef.DEFAULT_PRICING;
    }
  });

  it('keeps explicit free labels in the row while leaving full information in details', () => {
    providersRef.providers = [
      {
        id: 'xd',
        name: 'Cindy AI',
        connected: true,
        agents: ['claude-code'],
        routing: { 'claude-code': {} },
        models: {
          'claude-code': [
            {
              id: 'free-gateway-model',
              name: 'Free Gateway Model',
              contextWindow: 200000,
              efforts: ['high'],
              defaultEffort: 'high',
              cost: { input: 0, output: 0 },
            },
          ],
        },
      },
    ];
    pricingRef.pricing = null;

    try {
      const loading = render(
        React.createElement(ModelSelectorContent, {
          modelId: 'free-gateway-model',
          effort: 'high',
          onModelChange: vi.fn(),
          onEffortChange: vi.fn(),
          vendorKey: 'cc',
          currentProviderId: 'xd',
          onProviderChange: vi.fn(),
        }),
      );
      expect(
        within(screen.getByRole('option', { name: /Free Gateway Model/ })).queryByText('限时免费'),
      ).toBeNull();
      loading.unmount();

      pricingRef.pricing = {};
      render(
        React.createElement(ModelSelectorContent, {
          modelId: 'free-gateway-model',
          effort: 'high',
          onModelChange: vi.fn(),
          onEffortChange: vi.fn(),
          vendorKey: 'cc',
          currentProviderId: 'xd',
          onProviderChange: vi.fn(),
        }),
      );

      const row = screen.getByRole('option', { name: /Free Gateway Model/ });
      const rowBadge = within(row).getByText('限时免费');
      expect(rowBadge.hasAttribute('data-model-promotion-badge')).toBe(true);
      expect(rowBadge.parentElement?.hasAttribute('data-model-tags')).toBe(true);
      expect(row.querySelectorAll('[data-model-promotion-badge]')).toHaveLength(1);

      fireEvent.pointerEnter(row);
      const details = screen.getByRole('group', { name: /Free Gateway Model/ });
      const detailsBadge = within(details).getByText('限时免费');
      expect(detailsBadge.parentElement?.hasAttribute('data-model-tags')).toBe(true);
      expect(detailsBadge.parentElement?.className).toContain('ml-auto');
      expect(within(details).queryByText('newChat.modelSelector.pricing.perMillion')).toBeNull();
    } finally {
      providersRef.providers = providersRef.DEFAULT_PROVIDERS;
      pricingRef.pricing = pricingRef.DEFAULT_PRICING;
    }
  });

  it('shows model information even when a model has no configurable options', () => {
    render(
      React.createElement(ModelSelectorContent, {
        modelId: 'claude-opus-4-8',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
      }),
    );

    fireEvent.pointerEnter(screen.getByRole('option', { name: /Haiku 4\.5/ }));
    const information = screen.getByRole('group', { name: /Haiku 4\.5/ });
    expect(within(information).getByText('Fastest for quick answers')).toBeTruthy();
    expect(within(information).getByText('200K context')).toBeTruthy();
    expect(within(information).queryByRole('option')).toBeNull();
  });

  it('lets inactive provider rows edit the injected preset without switching the model', () => {
    const onProviderChange = vi.fn();
    const setEffort = vi.fn();
    const modelMemory = {
      getEffort: vi.fn(),
      setEffort,
      getFast: vi.fn(),
      setFast: vi.fn(),
    };

    render(
      React.createElement(ModelSelectorContent, {
        modelId: 'claude-opus-4-8',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
        currentProviderId: 'anthropic',
        onProviderChange,
        modelMemory,
      }),
    );

    const opusRow = screen.getByRole('option', { name: /Opus 4\.8/ });
    const sonnetRow = screen.getByRole('option', { name: /Sonnet 4\.6/ });
    fireEvent.pointerEnter(opusRow);
    expect(screen.getByRole('group', { name: /Opus 4\.8/ })).toBeTruthy();

    fireEvent.pointerEnter(sonnetRow);
    expect(screen.queryByRole('group', { name: /Opus 4\.8/ })).toBeNull();
    const options = screen.getByRole('group', { name: /Sonnet 4\.6/ });
    expect(sonnetRow.getAttribute('data-model-options-active')).toBe('true');
    expect(opusRow.getAttribute('data-model-options-active')).toBeNull();
    fireEvent.click(within(options).getByRole('option', { name: 'high' }));

    expect(setEffort).toHaveBeenCalledWith('claude-code', 'anthropic', 'claude-sonnet-4-6', 'high');
    expect(onProviderChange).not.toHaveBeenCalled();
  });

  it('keeps target-agent provider rows and effort memory configurable while browsing Codex', async () => {
    providersRef.providers = [
      ...providersRef.DEFAULT_PROVIDERS,
      {
        id: 'zeta-codex',
        name: 'Zeta Codex',
        connected: true,
        agents: ['codex'],
        routing: { codex: {} },
        models: {
          codex: [
            {
              id: 'gpt-5.5',
              name: 'GPT-5.5',
              contextWindow: 400000,
              efforts: ['low', 'medium', 'high'],
              defaultEffort: 'medium',
            },
          ],
        },
      },
    ];
    const setEffort = vi.fn();
    const confirmBrowseSwitch = vi.fn(async () => true);
    const onSwitch = vi.fn();
    const modelMemory = {
      getEffort: vi.fn((agent: string, providerId: string, modelId: string) =>
        agent === 'codex' && providerId === 'zeta-codex' && modelId === 'gpt-5.5'
          ? 'high'
          : undefined,
      ),
      setEffort,
      getFast: vi.fn(),
      setFast: vi.fn(),
    };

    try {
      render(
        React.createElement(ModelSelectorContent, {
          modelId: 'claude-opus-4-8',
          effort: 'medium',
          onModelChange: vi.fn(),
          onEffortChange: vi.fn(),
          vendorKey: 'cc',
          currentProviderId: 'anthropic',
          onProviderChange: vi.fn(),
          modelMemory,
          agentSwitch: { currentVendor: 'cc', confirmBrowseSwitch, onSwitch },
        }),
      );

      fireEvent.click(screen.getByRole('tab', { name: /Codex/ }));
      const row = await screen.findByRole('option', { name: /GPT-5\.5/ });
      expect(confirmBrowseSwitch).toHaveBeenCalledTimes(1);
      // 来源 mark 存在说明目标 Agent 仍走 provider sections，而不是退化成 flat。
      expect(row.textContent).toContain('Z');
      // 行尾与悬浮面板同读目标 Agent 的 per-(来源,模型) 记忆，不落模型默认 medium。
      expect(row.textContent).toContain('high');
      expect(row.textContent).not.toContain('medium');

      fireEvent.pointerEnter(row);
      const options = screen.getByRole('group', { name: /GPT-5\.5/ });
      expect(
        within(options).getByRole('option', { name: 'high' }).getAttribute('aria-selected'),
      ).toBe('true');
      fireEvent.click(within(options).getByRole('option', { name: 'low' }));
      expect(setEffort).toHaveBeenCalledWith('codex', 'zeta-codex', 'gpt-5.5', 'low');
      expect(confirmBrowseSwitch).toHaveBeenCalledTimes(1);

      fireEvent.click(row);
      expect(onSwitch).toHaveBeenCalledWith('codex', 'gpt-5.5', 'zeta-codex');
      // 模型确认与意图期配置不再触发确认；确认门只在 Agent 分段切换。
      expect(confirmBrowseSwitch).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole('tab', { name: /Claude/ }));
      await waitFor(() =>
        expect(screen.getByRole('tab', { name: /Claude/ }).getAttribute('aria-selected')).toBe(
          'true',
        ),
      );
      // 返回当前引擎直接切分段，不重复确认。
      expect(confirmBrowseSwitch).toHaveBeenCalledTimes(1);
    } finally {
      providersRef.providers = providersRef.DEFAULT_PROVIDERS;
    }
  });

  it('keeps the current Agent tab when pre-browse confirmation is canceled', async () => {
    const confirmBrowseSwitch = vi.fn(async () => false);
    render(
      React.createElement(ModelSelectorContent, {
        modelId: 'claude-opus-4-8',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
        agentSwitch: { currentVendor: 'cc', confirmBrowseSwitch, onSwitch: vi.fn() },
      }),
    );

    fireEvent.click(screen.getByRole('tab', { name: /Codex/ }));
    await waitFor(() => expect(confirmBrowseSwitch).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('tab', { name: /Claude/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /Codex/ }).getAttribute('aria-selected')).toBe('false');
    expect(screen.queryByText('newChat.modelSelector.agentSwitch.hint')).toBeNull();
  });

  it('keeps the expanded model panel open while Agent browse confirmation is shown', async () => {
    let resolveConfirmation!: (confirmed: boolean) => void;
    const confirmBrowseSwitch = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirmation = resolve;
        }),
    );
    render(
      React.createElement(ModelSelector, {
        modelId: 'claude-opus-4-8',
        effort: 'high',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
        agentSwitch: { currentVendor: 'cc', confirmBrowseSwitch, onSwitch: vi.fn() },
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /Current: Opus 4\.8/ }));
    fireEvent.click(screen.getByRole('tab', { name: /Codex/ }));
    await waitFor(() => expect(confirmBrowseSwitch).toHaveBeenCalledTimes(1));

    // 模拟 AlertDialog 被 Popover 判成外部交互而发出的 close 请求；确认未结束时
    // 面板仍留在原 Agent 页签，取消后也不发生关闭再打开的闪烁。
    fireEvent.click(screen.getByTestId('mock-popover-dismiss'));
    expect(screen.getByTestId('model-options-popover')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Claude/ }).getAttribute('aria-selected')).toBe('true');

    await act(async () => resolveConfirmation(false));
    await waitFor(() => expect(screen.getByTestId('model-options-popover')).toBeTruthy());
    expect(screen.getByRole('tab', { name: /Claude/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('shares inactive model presets across conversations while protecting an active model', () => {
    const efforts = new Map<string, Effort>();
    const keyOf = (providerId: string, modelId: string) => `${providerId}:${modelId}`;
    const modelMemory = {
      getEffort: vi.fn((_agent: string, providerId: string, modelId: string) =>
        efforts.get(keyOf(providerId, modelId)),
      ),
      setEffort: vi.fn((_agent: string, providerId: string, modelId: string, effort: Effort) => {
        efforts.set(keyOf(providerId, modelId), effort);
      }),
      getFast: vi.fn(),
      setFast: vi.fn(),
    };

    // 对话 A 当前用 Sonnet,把非当前的 Opus 全局预设改成 High。
    const conversationA = render(
      React.createElement(ModelSelectorContent, {
        modelId: 'claude-sonnet-4-6',
        effort: 'medium',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
        currentProviderId: 'anthropic',
        onProviderChange: vi.fn(),
        modelMemory,
      }),
    );
    fireEvent.pointerEnter(screen.getByRole('option', { name: /Opus 4\.8/ }));
    fireEvent.click(
      within(screen.getByRole('group', { name: /Opus 4\.8/ })).getByRole('option', {
        name: 'high',
      }),
    );
    expect(efforts.get('anthropic:claude-opus-4-8')).toBe('high');
    conversationA.unmount();

    // 对话 B 当前用别的模型,其 Opus 非当前行立即读取同一份 High 预设。
    const conversationB = render(
      React.createElement(ModelSelectorContent, {
        modelId: 'claude-haiku-4-5',
        effort: 'medium',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
        currentProviderId: 'anthropic',
        onProviderChange: vi.fn(),
        modelMemory,
      }),
    );
    fireEvent.pointerEnter(screen.getByRole('option', { name: /Opus 4\.8/ }));
    expect(
      within(screen.getByRole('group', { name: /Opus 4\.8/ }))
        .getByRole('option', { name: 'high' })
        .getAttribute('aria-selected'),
    ).toBe('true');
    conversationB.unmount();

    // 对话 C 正在用 Opus/Medium:选中行以 live 值为准,不被全局 High 覆盖。
    render(
      React.createElement(ModelSelectorContent, {
        modelId: 'claude-opus-4-8',
        effort: 'medium',
        onModelChange: vi.fn(),
        onEffortChange: vi.fn(),
        vendorKey: 'cc',
        currentProviderId: 'anthropic',
        onProviderChange: vi.fn(),
        modelMemory,
      }),
    );
    fireEvent.pointerEnter(screen.getByRole('option', { name: /Opus 4\.8/ }));
    const activeOptions = screen.getByRole('group', { name: /Opus 4\.8/ });
    expect(
      within(activeOptions).getByRole('option', { name: 'medium' }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      within(activeOptions).getByRole('option', { name: 'high' }).getAttribute('aria-selected'),
    ).toBe('false');
  });

  it('renders the routed source mark on the trigger instead of guessing a model brand', () => {
    // claude-* 模型经自定义网关路由时,trigger 必须显示该来源的 monogram,
    // 不能按 model id 猜成 Claude 厂牌图标(否则订阅直连与网关来源同貌,用户无法自查)。
    providersRef.providers = [
      {
        id: 'zeta-gw',
        name: 'Zeta',
        connected: true,
        agents: ['claude-code'],
        routing: { 'claude-code': {} },
        models: {
          'claude-code': [
            {
              id: 'claude-opus-4-8',
              name: 'Opus 4.8',
              contextWindow: 200000,
              efforts: ['high'],
              defaultEffort: 'high',
            },
          ],
        },
      },
    ];
    try {
      render(
        React.createElement(ModelSelector, {
          modelId: 'claude-opus-4-8',
          effort: 'high',
          onModelChange: vi.fn(),
          onEffortChange: vi.fn(),
          vendorKey: 'cc',
        }),
      );

      const trigger = screen.getByRole('button', { name: /Current: Opus 4\.8/ });
      // ProviderMark 自定义供应商分支渲染 name 首字母 monogram。
      expect(trigger.textContent).toContain('Z');
      expect(trigger.textContent).toContain('Opus 4.8');
    } finally {
      providersRef.providers = providersRef.DEFAULT_PROVIDERS;
    }
  });

  it('honors the gateway-configured model icon over the source mark fallback', () => {
    // 统一规则:模型条目带 icon(AI Gateway / 目录设定)→ 渲染厂牌 mark(此处 Claude svg),
    // 不再显示来源 monogram;缺省才回落来源标(上一个用例)。
    providersRef.providers = [
      {
        id: 'zeta-gw',
        name: 'Zeta',
        connected: true,
        agents: ['claude-code'],
        routing: { 'claude-code': {} },
        models: {
          'claude-code': [
            {
              id: 'claude-opus-4-8',
              name: 'Opus 4.8',
              contextWindow: 200000,
              efforts: ['high'],
              defaultEffort: 'high',
              icon: 'claude',
            },
          ],
        },
      },
    ];
    try {
      render(
        React.createElement(ModelSelector, {
          modelId: 'claude-opus-4-8',
          effort: 'high',
          onModelChange: vi.fn(),
          onEffortChange: vi.fn(),
          vendorKey: 'cc',
        }),
      );

      const trigger = screen.getByRole('button', { name: /Current: Opus 4\.8/ });
      expect(trigger.textContent).not.toContain('Z');
      expect(trigger.textContent).toContain('Opus 4.8');
    } finally {
      providersRef.providers = providersRef.DEFAULT_PROVIDERS;
    }
  });
});
