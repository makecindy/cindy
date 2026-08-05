// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleTemplate } from '@cindy/maker-scheduler';

import { SchedulerPage } from '@/features/scheduler/SchedulerPage';
import {
  oneTimeCronAfterUsageReset,
  systemTimeZone,
  usageLimitScheduleNavigationState,
} from '@/features/scheduler/lib/usageLimitScheduleCreateIntent';
import { pluginScheduleNavigationState } from '@/features/scheduler/lib/pluginScheduleCreateIntent';

const createSchedule = vi.fn();
const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast: toastMocks }));
const localStorageData = new Map<string, string>();
const routerMocks = vi.hoisted(() => ({
  location: {
    pathname: '/cc-agent/scheduled',
    search: '',
    state: null as unknown,
  },
  navigate: vi.fn(),
}));

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
  useLocation: () => routerMocks.location,
  useNavigate: () => routerMocks.navigate,
}));

vi.mock('@radix-ui/react-dialog', async () => {
  const React = await import('react');
  const DialogContext = React.createContext(false);

  return {
    Root: ({ open, children }: { open: boolean; children: ReactNode }) =>
      React.createElement(DialogContext.Provider, { value: open }, open ? children : null),
    Portal: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
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
    Tip: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
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

vi.mock('@/features/scheduler/hooks/useSessionReferences', () => ({
  useSessionReferences: () => new Map(),
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
        // 第二个模型专供「所见即所存」那条用例:它需要一个**不等于 fallback**
        // (claude-sonnet-4-6)、又确实在可用目录里的模型 —— 否则要么测不出问题,
        // 要么被 isExplicitScheduleModelUnavailable 拦在提交前。
        {
          id: 'claude-opus-4-9',
          displayName: 'Claude Opus 4.9',
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
  routerMocks.location.pathname = '/cc-agent/scheduled';
  routerMocks.location.search = '';
  routerMocks.location.state = null;
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
    wecomGroupNotification: {
      getState: vi.fn(async () => ({ configured: false })),
      saveAndTest: vi.fn(),
      test: vi.fn(),
      clear: vi.fn(),
    },
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

    fireEvent.click(
      screen.getByRole('button', { name: 'scheduler.editor.promptDialog.createAria' }),
    );

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
        notify: { desktop: true, feishu: false, wecomGroup: false },
      }),
    );
  });

  it('opens a usage-limit recovery Automation for confirmation without creating it', async () => {
    const resetAtMs = Date.parse('2027-01-24T10:30:00.000Z');
    routerMocks.location.state = usageLimitScheduleNavigationState({
      kind: 'usage-limit-recovery',
      requestId: 'request-1',
      sessionId: 'session-1',
      agentKind: 'codex',
      resetAtMs,
    });

    render(createElement(SchedulerPage));

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(
      screen.getByDisplayValue('scheduler.usageLimitRecovery.name'),
    ).toBeTruthy();
    expect(
      screen.getByDisplayValue('scheduler.usageLimitRecovery.prompt'),
    ).toBeTruthy();
    expect(screen.getByTestId('cron-expr').textContent).toBe(
      oneTimeCronAfterUsageReset(resetAtMs, systemTimeZone()),
    );
    expect(screen.getByTestId('agent-kind').textContent).toBe('codex');
    expect(createSchedule).not.toHaveBeenCalled();
    expect(routerMocks.navigate).toHaveBeenCalledWith('/cc-agent/scheduled', {
      replace: true,
      state: null,
    });
  });

  it('opens the same confirmation form with a blank schedule when reset time is unknown', async () => {
    routerMocks.location.state = usageLimitScheduleNavigationState({
      kind: 'usage-limit-recovery',
      requestId: 'request-unknown-time',
      sessionId: 'session-2',
      agentKind: 'claude-code',
      resetAtMs: null,
    });

    render(createElement(SchedulerPage));

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getByTestId('cron-expr').textContent).toBe('');
    expect(screen.getByTestId('agent-kind').textContent).toBe('claude-code');
    expect(createSchedule).not.toHaveBeenCalled();
  });

  it('插件请求打开预填的创建表单,但不创建任务', async () => {
    routerMocks.location.state = pluginScheduleNavigationState({
      kind: 'plugin-schedule-draft',
      requestId: 'plugin-req-1',
      ghostId: 'codex-reset-planner',
      ghostName: 'Codex 重置管家',
      name: 'Codex 重置提醒',
      prompt: '检查本机 Codex 重置时间,快到了就提醒我。',
      intervalMs: 3_600_000,
    });

    render(createElement(SchedulerPage));

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(screen.getByDisplayValue('Codex 重置提醒')).toBeTruthy();
    expect(screen.getByDisplayValue('检查本机 Codex 重置时间,快到了就提醒我。')).toBeTruthy();
    // 插件永远不能直接建任务:落库只发生在用户点保存之后。
    expect(createSchedule).not.toHaveBeenCalled();
    // 一次性意图用完即清,重进自动化页不会再弹。
    expect(routerMocks.navigate).toHaveBeenCalledWith('/cc-agent/scheduled', {
      replace: true,
      state: null,
    });
  });

  /**
   * #1715 review Codex P2 的回归:表单已打开且用户改过内容时,新到的插件请求
   * **绝不能静默 reset 掉它**(ScheduleFormDialog 的 reset effect 依赖 initialValues,
   * 守卫只有 `if (!open) return`)。语义是"拒绝 + 提示",用户输入一个字都不能丢。
   */
  it('表单已打开且已修改时,新的插件请求不覆盖用户输入,只提示', async () => {
    routerMocks.location.state = pluginScheduleNavigationState({
      kind: 'plugin-schedule-draft',
      requestId: 'plugin-req-first',
      ghostId: 'sign-board',
      ghostName: '签字门看板',
      name: '插件预填的名字',
      prompt: '第一次请求的提示词。',
    });

    const view = render(createElement(SchedulerPage));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

    // 用户在表单里改了名称 —— 这就是绝不能丢的内容。
    const nameInput = screen.getByDisplayValue('插件预填的名字');
    fireEvent.change(nameInput, { target: { value: '用户自己改的名字' } });
    expect(screen.getByDisplayValue('用户自己改的名字')).toBeTruthy();

    // 第二个插件请求到来(不同 requestId,否则会被去重挡掉)。
    routerMocks.location.state = pluginScheduleNavigationState({
      kind: 'plugin-schedule-draft',
      requestId: 'plugin-req-second',
      ghostId: 'codex-reset-planner',
      ghostName: 'Codex 重置管家',
      name: '第二次请求的名字',
      prompt: '第二次请求的提示词。',
    });
    view.rerender(createElement(SchedulerPage));

    // 用户输入原样保留,没有被第二次请求的预填顶掉。
    await waitFor(() =>
      expect(toastMocks.warning).toHaveBeenCalledWith(
        'scheduler.toast.pluginDraftIgnoredFormOpen',
      ),
    );
    expect(screen.getByDisplayValue('用户自己改的名字')).toBeTruthy();
    expect(screen.queryByDisplayValue('第二次请求的名字')).toBeNull();
    expect(screen.queryByDisplayValue('第二次请求的提示词。')).toBeNull();
    expect(createSchedule).not.toHaveBeenCalled();
  });

  /**
   * review #1715 的回归:**所见即所存**。
   *
   * 插件请求的任务是「用户不改模型、直接点保存」的高频路径(插件把内容都预填好了,
   * 用户只是确认一下),所以模型默认值这条链路对它尤其值得钉死:一旦"显示的模型"与
   * "落库的模型"漂移,用户就会以为在用 A、实际每次跑 B(2026-06 真踩过)。
   *
   * 本用例钉的是**端到端结果**而非某条实现路径:当前由 ScheduleFormDialog 的
   * "form.model 为空时回填默认模型" effect 保证;将来若有人改成从 intent 直接给值,
   * 或反过来删掉那个 effect,只要最终"显示 === 落库"成立就仍然通过 —— 用户可见的
   * 正确性才是契约。
   *
   * 这里刻意把「记忆的模型」设成**不同于 fallback**(claude-sonnet-4-6)的值,
   * 否则两者恰好相等时这个 bug 根本测不出来。
   */
  it('插件请求:用户不碰模型 chip 直接保存,存下的模型与表单显示的一致', async () => {
    const REMEMBERED = 'claude-opus-4-9';
    expect(REMEMBERED).not.toBe('claude-sonnet-4-6'); // 必须区别于 fallback,否则测不出问题
    localStorageData.set(
      'xdt:scheduleFormPrefs:v1',
      JSON.stringify({
        agentKind: 'claude-code',
        workspaceKind: 'dialogue',
        workingDir: '',
        useWorktree: false,
        lastByAgent: {
          'claude-code': { model: REMEMBERED, providerId: '', effort: '', fastMode: false },
        },
      }),
    );

    routerMocks.location.state = pluginScheduleNavigationState({
      kind: 'plugin-schedule-draft',
      requestId: 'plugin-model-default',
      ghostId: 'codex-reset-planner',
      ghostName: 'Codex 重置管家',
      name: 'Codex 重置提醒',
      prompt: '检查重置时间,快到了提醒我。',
      intervalMs: 3_600_000,
    });

    render(createElement(SchedulerPage));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

    // 表单显示的就是记忆值(不是空、也不是 fallback)。
    expect(screen.getByTestId('model-value').textContent).toBe(REMEMBERED);

    // 用户什么都不改,直接保存。
    fireEvent.click(
      screen.getByRole('button', { name: 'scheduler.editor.promptDialog.createAria' }),
    );

    // 存下去的模型 === 表单上显示的那个,不省略、不回退。
    await waitFor(() => expect(createSchedule).toHaveBeenCalled());
    expect(createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ model: REMEMBERED, agentKind: 'claude-code' }),
    );
  });
});
