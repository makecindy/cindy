// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleTemplate } from '@cindy/maker-scheduler';

import { SchedulerPage } from '@/features/scheduler/SchedulerPage';

const createSchedule = vi.fn();
const localStorageData = new Map<string, string>();

const template: ScheduleTemplate = {
  id: 'review-template',
  name: 'Review Template',
  description: 'Open a prefilled automation form',
  // 必须是 TEMPLATE_CATEGORIES 里存在的分类,否则 TemplateGallery 不渲染该卡片。
  category: 'dev-automation',
  source: 'builtin',
  prompt: 'Check open pull requests',
  cronExpr: '30 10 * * 1',
  timezone: 'Asia/Shanghai',
  recurring: true,
  agentKind: 'claude-code',
  notify: { desktop: true, feishu: false },
};

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.count != null ? `${key}:${String(values.count)}` : key,
    // useTemplates 走 i18n.getResource 做模板本地化；fixture id 不在 locale 里，
    // 返回 undefined 让模板原文直通。
    i18n: { language: 'en', getResource: () => undefined },
  }),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ search: '' }),
  useNavigate: () => vi.fn(),
}));

vi.mock('@radix-ui/react-dialog', async () => {
  const React = await import('react');
  const DialogContext = React.createContext(false);

  return {
    Root: ({ open, children }: { open: boolean; children: ReactNode }) =>
      React.createElement(DialogContext.Provider, { value: open }, open ? children : null),
    Portal: ({ children }: { children: ReactNode }) => React.createElement(React.Fragment, null, children),
    Overlay: (props: Record<string, unknown>) => React.createElement('div', props),
    Content: ({
      children,
      ...props
    }: {
      children: ReactNode;
      onPointerDownOutside?: unknown;
      onInteractOutside?: unknown;
      onEscapeKeyDown?: unknown;
    }) => {
      delete props.onPointerDownOutside;
      delete props.onInteractOutside;
      delete props.onEscapeKeyDown;
      return React.createElement('div', { ...props, role: 'dialog' }, children);
    },
    Title: ({ children, ...props }: { children: ReactNode }) =>
      React.createElement('h2', props, children),
  };
});

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({
    confirm: vi.fn(async () => true),
    confirmThree: vi.fn(async () => 'cancel'),
  }),
}));

vi.mock('@/components/ui/tooltip', async () => {
  const React = await import('react');
  return {
    Tip: ({ children }: { children: ReactNode }) => React.createElement(React.Fragment, null, children),
  };
});

vi.mock('@/features/scheduler/hooks/useSchedules', () => ({
  useSchedules: () => ({
    schedules: [],
    runningById: {},
    loading: false,
    error: null,
    refresh: vi.fn(async () => undefined),
  }),
}));

vi.mock('@/features/scheduler/hooks/useDeleteScheduleWithSessions', () => ({
  useDeleteScheduleWithSessions: () => ({
    requestDeleteSchedule: vi.fn(),
    deleteScheduleDialog: null,
  }),
}));

vi.mock('@/features/scheduler/hooks/useScheduleUnreadRunCounts', () => ({
  useScheduleUnreadRunCounts: () => new Map(),
}));

vi.mock('@/features/scheduler/hooks/useScheduleCostSummaries', () => ({
  useScheduleCostSummaries: () => ({ summaries: new Map(), loaded: true }),
}));

vi.mock('@/hooks/useFeishuBot', () => ({
  useFeishuBot: () => ({ status: 'disconnected' }),
}));

vi.mock('@/hooks/useProjectPickerOptions', () => ({
  useProjectPickerOptions: () => [],
}));

vi.mock('@/hooks/useAgentCapabilities', () => ({
  useAgentCapabilities: () => ({
    capabilities: {
      availableModels: [
        {
          id: 'claude-sonnet-4-6',
          displayName: 'Claude Sonnet 4.6',
          efforts: ['medium', 'high'],
          defaultEffort: 'medium',
        },
      ],
      hasFastMode: false,
    },
  }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: [] }),
}));

vi.mock('@/state/newMakerDraft', () => ({
  getPersistedVendorModel: () => '',
}));

vi.mock('@/features/scheduler/components/ScheduleChips', async () => {
  const React = await import('react');
  return {
    AgentTabs: ({ value }: { value: string }) =>
      React.createElement('div', { 'data-testid': 'agent-kind' }, value),
    ModelEffortChip: ({ modelValue }: { modelValue: string }) =>
      React.createElement('div', { 'data-testid': 'model-value' }, modelValue),
    ProjectChip: () => React.createElement('div'),
    ScheduleChip: ({ cronExpr }: { cronExpr: string }) =>
      React.createElement('div', { 'data-testid': 'cron-expr' }, cronExpr),
    ScheduleSettingsButton: () => React.createElement('button', { type: 'button' }),
    ThreadPickerInline: () => React.createElement('div'),
  };
});

beforeEach(() => {
  createSchedule.mockImplementation(async (input) => ({ id: 'created-schedule', ...input }));
  localStorageData.clear();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => localStorageData.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        localStorageData.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        localStorageData.delete(key);
      }),
    },
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: {
      schedule: {
        listTemplates: vi.fn(async () => [template]),
        create: createSchedule,
        update: vi.fn(),
        runNow: vi.fn(),
        // SchedulerPage 通过 useRunNowBusyGuard 订阅 schedule 事件(派发即释放 runNow busy)。
        // 返回一个 no-op 退订函数即可。
        onEvent: vi.fn(() => vi.fn()),
      },
      projectAutomation: {
        upsertSchedule: vi.fn(),
      },
    },
    openPath: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Scheduler template entry', () => {
  it('opens a recommended template as a prefilled create form', async () => {
    render(createElement(SchedulerPage));

    fireEvent.click(await screen.findByRole('button', { name: /Review Template/ }));

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getByDisplayValue('Review Template')).toBeTruthy();
    expect(screen.getByDisplayValue('Check open pull requests')).toBeTruthy();
    expect(screen.getByTestId('cron-expr').textContent).toBe('30 10 * * 1');
    expect(screen.getByTestId('agent-kind').textContent).toBe('claude-code');
    expect(screen.getByTestId('model-value').textContent).toBe('claude-sonnet-4-6');

    fireEvent.click(screen.getByRole('button', { name: 'scheduler.editor.promptDialog.createAria' }));

    await waitFor(() => expect(createSchedule).toHaveBeenCalledTimes(1));
    expect(createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Review Template',
        prompt: 'Check open pull requests',
        cronExpr: '30 10 * * 1',
        timezone: 'Asia/Shanghai',
        recurring: true,
        agentKind: 'claude-code',
        model: 'claude-sonnet-4-6',
        notify: { desktop: true, feishu: false },
      }),
    );
  });
});
