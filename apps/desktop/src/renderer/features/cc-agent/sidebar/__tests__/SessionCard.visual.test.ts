// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionCard } from '../SessionCard';
import { sessionCardVisualCases } from '../__fixtures__/sessionCardVisualCases';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  boundSchedulesBySession: new Map<string, readonly unknown[]>(),
  worktreeSessionIds: new Set<string>(),
  runningDetailBySession: new Map<string, string>(),
  pendingPluginSetupSessionIds: new Set<string>(),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: () => {},
  },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const count = Number(options?.count ?? 0);
      const dict: Record<string, string> = {
        'ccAgent.time.relative.now': '刚刚',
        'ccAgent.time.relative.minute': `${count} 分`,
        'ccAgent.time.relative.hour': `${count} 时`,
        'ccAgent.time.relative.day': `${count} 天`,
        'ccAgent.time.relative.week': `${count} 周`,
        'ccAgent.time.relative.month': `${count} 月`,
        'ccAgent.time.relative.year': `${count} 年`,
        'ccAgent.sidebar.automationGenerated': '由自动化创建',
        'ccAgent.sidebar.scheduleBinding.viewTask': '查看自动化任务',
        'ccAgent.sidebar.scheduleBinding.label': '绑定自动化任务',
        'ccAgent.sidebar.scheduleBinding.tooltipName': `任务:${String(options?.name ?? '')}`,
        'ccAgent.sidebar.scheduleBinding.tooltipFrequency': `频率:${String(options?.frequency ?? '')}`,
        'ccAgent.sidebar.scheduleBinding.pausedSuffix': '已暂停',
        'scheduler.detail.manualTrigger': '手动触发',
        'ccAgent.sidebar.card.awaitingPermission': '等待授权',
        'ccAgent.sidebar.card.awaitingPlan': '等待确认计划',
        'ccAgent.sidebar.card.awaitingQuestion': '等待回复',
        'ccAgent.sidebar.card.awaitingPluginSetup': '等待插件设置',
        'ccAgent.sidebar.sessionMenu.rename': '重命名',
        'ccAgent.sidebar.sessionMenu.unarchive': '取消归档',
        'ccAgent.sidebar.sessionMenu.delete': '删除',
        'ccAgent.sidebar.sessionMenu.unpin': '取消置顶',
        'ccAgent.sidebar.sessionMenu.pin': '置顶',
        'ccAgent.sidebar.sessionMenu.openInNewWindow': '新窗口打开',
        'ccAgent.sidebar.sessionMenu.archived': '归档',
        'ccAgent.sidebar.sessionMenu.copySessionLink': '复制对话链接',
      };
      return dict[key] ?? key;
    },
  }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: {
    Provider: ({ children }: { children: ReactNode }) => children,
    Root: ({ children }: { children: ReactNode }) => children,
    Trigger: ({ children }: { children: ReactNode }) => children,
    Content: () => null,
  },
}));

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: () => null,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => children,
  DropdownMenuSeparator: () => null,
  DropdownMenuSub: ({ children }: { children: ReactNode }) => children,
  DropdownMenuSubContent: () => null,
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@/components/sidebar/WorktreeBadge', () => ({
  WorktreeBadge: ({ sessionId }: { sessionId: string }) =>
    mocks.worktreeSessionIds.has(sessionId) ? createElement('span', { 'data-testid': 'worktree-badge' }, 'WT') : null,
}));

vi.mock('@/state/agentIslandActivity', () => ({
  useAgentIslandActivity: (sessionId: string) => {
    const compactDetail = mocks.runningDetailBySession.get(sessionId);
    return compactDetail ? { phase: 'running', compactDetail } : null;
  },
}));

vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    subscribeAll: () => () => {},
    getRunningSnapshot: () =>
      new Map(
        [...mocks.pendingPluginSetupSessionIds].map((sessionId) => [
          sessionId,
          { hasPendingPluginSetup: true },
        ]),
      ),
  },
}));

vi.mock('@/hooks/useComposerDraftPresence', () => ({
  useComposerDraftPresence: () => false,
}));

vi.mock('@/hooks/useSessionPausedQueue', () => ({
  useSessionPausedQueue: () => false,
}));

vi.mock('../../lib/scrollIntoNearestView', () => ({
  scrollIntoNearestView: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('@/features/scheduler/lib/scheduleSessionBinding', () => ({
  scheduleFocusPath: (scheduleId: string) => `/cc-agent/scheduled?focus=${encodeURIComponent(scheduleId)}`,
  useSessionBoundSchedules: (sessionId: string) => mocks.boundSchedulesBySession.get(sessionId) ?? [],
}));

vi.mock('@/features/scheduler/lib/scheduleSidebarIndexRuns', () => ({
  loadScheduleSidebarIndexRuns: async () => [],
}));

function scheduleForCase(id: string, status: 'active' | 'paused') {
  return {
    id: `schedule-${id}`,
    name: `Visual ${id}`,
    status,
    manual: true,
    cronExpr: '* * * * *',
    targetSessionId: id,
  };
}

function renderCase(caseId: string) {
  const visualCase = sessionCardVisualCases.find((item) => item.id === caseId);
  if (!visualCase) throw new Error(`Missing visual case: ${caseId}`);
  if (visualCase.boundSchedule) {
    mocks.boundSchedulesBySession.set(visualCase.session.id, [
      scheduleForCase(visualCase.session.id, visualCase.boundSchedule),
    ]);
  }

  return render(
    createElement(
      'div',
      { 'data-testid': 'visual-case', style: { width: 118 } },
      createElement(SessionCard, {
        session: visualCase.session,
        isActive: visualCase.isActive ?? false,
        isRunning: visualCase.isRunning ?? false,
        isAttached: visualCase.isAttached ?? false,
        hasAttentionNotification: visualCase.hasAttentionNotification ?? false,
        isSelected: visualCase.isSelected ?? false,
        onClick: vi.fn(),
        onAction: vi.fn(),
        onRename: vi.fn(),
        onTogglePin: vi.fn(),
        projectOptions: [],
      }),
    ),
  );
}

describe('SessionCard visual cases', () => {
  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.boundSchedulesBySession.clear();
    mocks.worktreeSessionIds.clear();
    mocks.runningDetailBySession.clear();
    mocks.pendingPluginSetupSessionIds.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps a broad gallery of title, body, icon, and state combinations', () => {
    expect(sessionCardVisualCases.map((item) => item.id)).toEqual([
      'short-idle-cc',
      'two-line-title-codex',
      'very-long-title',
      'summary-long-body',
      'running-loading',
      'attention-dot',
      'automation-timer',
      'schedule-bound-active',
      'schedule-bound-paused',
      'remote-device-link',
      'remote-ssh',
      'attached-control',
      'archived',
      'selected-active',
    ]);
  });

  it.each(sessionCardVisualCases.map((item) => [item.label, item.id] as const))(
    'renders visual case: %s',
    (_label, id) => {
      renderCase(id);
      const root = screen.getByTestId('visual-case');
      const card = root.querySelector('[data-sidebar-session-row="true"]');
      const visualCase = sessionCardVisualCases.find((item) => item.id === id);
      expect(card).not.toBeNull();
      expect(card?.className).toContain('rounded-xl');
      expect(root.textContent).toContain(visualCase?.session.title.replace('[Schedule] ', '').slice(0, 4));
    },
  );

  it('keeps single-line cards naturally shorter than long summary cards', () => {
    renderCase('short-idle-cc');
    const shortCard = screen.getByTestId('visual-case').querySelector('[data-sidebar-session-row="true"]');
    expect(shortCard?.className).not.toContain('h-full');
    cleanup();

    renderCase('summary-long-body');
    expect(screen.getByText(/汇总玩家/)).toBeTruthy();
  });

  it('shows plugin setup as a needs-interaction preview', () => {
    const visualCase = sessionCardVisualCases.find((item) => item.id === 'short-idle-cc');
    if (!visualCase) throw new Error('Missing visual case');
    mocks.pendingPluginSetupSessionIds.add(visualCase.session.id);

    renderCase('short-idle-cc');

    expect(screen.getByText('等待插件设置')).toBeTruthy();
  });

  it('uses the unified Timer for automation cases without a bound schedule', () => {
    renderCase('automation-timer');
    expect(screen.getByRole('button', { name: '查看自动化任务' }).getAttribute('title')).toBe('由自动化创建');
    expect(screen.getByRole('button', { name: '查看自动化任务' }).querySelector('.lucide-timer')).not.toBeNull();
  });

  it('stops keyboard activation on the automation title action from opening the card', () => {
    const visualCase = sessionCardVisualCases.find((item) => item.id === 'automation-timer');
    if (!visualCase) throw new Error('Missing automation visual case');
    const onClick = vi.fn();

    render(
      createElement(SessionCard, {
        session: visualCase.session,
        isActive: false,
        isRunning: false,
        isAttached: false,
        hasAttentionNotification: false,
        isSelected: false,
        onClick,
        onAction: vi.fn(),
        onRename: vi.fn(),
        onTogglePin: vi.fn(),
        projectOptions: [],
      }),
    );

    fireEvent.keyDown(screen.getByRole('button', { name: '查看自动化任务' }), { key: 'Enter' });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('stops keyboard activation on the schedule badge from opening the card', () => {
    const visualCase = sessionCardVisualCases.find((item) => item.id === 'schedule-bound-active');
    if (!visualCase) throw new Error('Missing schedule visual case');
    mocks.boundSchedulesBySession.set(visualCase.session.id, [scheduleForCase(visualCase.session.id, 'active')]);
    const onClick = vi.fn();

    render(
      createElement(SessionCard, {
        session: visualCase.session,
        isActive: false,
        isRunning: false,
        isAttached: false,
        hasAttentionNotification: false,
        isSelected: false,
        onClick,
        onAction: vi.fn(),
        onRename: vi.fn(),
        onTogglePin: vi.fn(),
        projectOptions: [],
      }),
    );

    fireEvent.keyDown(screen.getByRole('button', { name: '查看自动化任务' }), { key: 'Enter' });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('uses the same Timer while bound schedules provide the binding metadata', () => {
    renderCase('schedule-bound-active');
    const root = screen.getByTestId('visual-case');
    const automationButton = within(root).getByRole('button', { name: '查看自动化任务' });
    expect(automationButton.getAttribute('title')).not.toBe('由自动化创建');
    expect(automationButton.querySelector('.lucide-timer')).not.toBeNull();
  });

  it('moves the automation action to the card meta row while list keeps it in the title prefix', () => {
    const visualCase = sessionCardVisualCases.find((item) => item.id === 'automation-timer');
    if (!visualCase) throw new Error('Missing automation visual case');

    const commonProps = {
      session: visualCase.session,
      isActive: false,
      isRunning: false,
      isAttached: false,
      hasAttentionNotification: false,
      isSelected: false,
      onClick: vi.fn(),
      onAction: vi.fn(),
      onRename: vi.fn(),
      onTogglePin: vi.fn(),
      projectOptions: [],
    };

    // card 变体(评审定稿):标题纯文字,自动化标志下沉到底部 meta 行。
    const { container: cardContainer } = render(createElement(SessionCard, commonProps));
    const cardTitle = Array.from(cardContainer.querySelectorAll('div')).find((node) =>
      node.className.includes('[-webkit-line-clamp:2]'),
    );
    expect(cardTitle?.textContent).toContain('自动化日报巡检');
    // 标题里不再有自动化图标……
    expect(cardTitle?.querySelector('[aria-label="查看自动化任务"]')).toBeNull();
    // ……但它仍在卡片内(底部 meta 行)。
    expect(cardContainer.querySelector('[aria-label="查看自动化任务"]')).not.toBeNull();
    cleanup();

    // list 变体保持原有标题前缀契约不变:自动化图标仍在标题里。
    const { container: listContainer } = render(createElement(SessionCard, { ...commonProps, variant: 'list' }));
    const listTitle = Array.from(listContainer.querySelectorAll('span')).find((node) =>
      node.className.includes('truncate') && node.textContent?.includes('自动化日报巡检'),
    );
    expect(listTitle?.textContent).toContain('自动化日报巡检');
    expect(listTitle?.querySelector('[aria-label="查看自动化任务"]')).not.toBeNull();
  });

  it('keeps archived sessions on the archive visual branch', () => {
    renderCase('archived');
    expect(screen.getByText('已归档的历史分析任务')).toBeTruthy();
  });

  it('keeps running card mode on the stable preview while list mode can show live detail', () => {
    const visualCase = sessionCardVisualCases.find((item) => item.id === 'running-loading');
    if (!visualCase) throw new Error('Missing running visual case');
    mocks.runningDetailBySession.set(visualCase.session.id, '正在实时扫描并刷新当前执行步骤');

    const commonProps = {
      session: visualCase.session,
      isActive: false,
      isRunning: true,
      isAttached: false,
      hasAttentionNotification: false,
      isSelected: false,
      onClick: vi.fn(),
      onAction: vi.fn(),
      onRename: vi.fn(),
      onTogglePin: vi.fn(),
      projectOptions: [],
    };

    const { container: cardContainer } = render(createElement(SessionCard, commonProps));
    expect(cardContainer.textContent).toContain('正在分析本周项目数据与异常波动。');
    expect(cardContainer.textContent).not.toContain('正在实时扫描并刷新当前执行步骤');
    cleanup();

    const { container: listContainer } = render(createElement(SessionCard, { ...commonProps, variant: 'list' }));
    expect(listContainer.textContent).toContain('正在实时扫描并刷新当前执行步骤');
  });
});
