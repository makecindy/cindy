// @vitest-environment jsdom

import { createElement, type ReactNode } from 'react';
import { cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionCard } from '../SessionCard';
import { sessionCardVisualCases } from '../__fixtures__/sessionCardVisualCases';
import { SPLIT_GROUP_SESSION_MIME } from '../../splitGroupDnd';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  dropdownMenuOpen: false,
  boundSchedulesBySession: new Map<string, readonly unknown[]>(),
  worktreeSessionIds: new Set<string>(),
  runningDetailBySession: new Map<string, string>(),
  pendingPluginSetupSessionIds: new Set<string>(),
  attentionKindBySession: new Map<string, 'done' | 'awaiting' | 'error'>(),
  ensureInitialMessages: vi.fn(),
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
        'ccAgent.sidebar.sessionMenu.copySessionLink': '复制任务链接',
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
  DropdownMenu: ({ children, open }: { children: ReactNode; open?: boolean }) => {
    mocks.dropdownMenuOpen = Boolean(open);
    return children;
  },
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    mocks.dropdownMenuOpen ? createElement('div', { role: 'menu' }, children) : null,
  DropdownMenuItem: ({ children }: { children: ReactNode }) =>
    createElement('div', { role: 'menuitem' }, children),
  DropdownMenuSeparator: () => null,
  DropdownMenuSub: ({ children }: { children: ReactNode }) => children,
  DropdownMenuSubContent: () => null,
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@/components/sidebar/WorktreeBadge', () => ({
  WorktreeBadge: ({ sessionId }: { sessionId: string }) =>
    mocks.worktreeSessionIds.has(sessionId)
      ? createElement('span', { 'data-testid': 'worktree-badge' }, 'WT')
      : null,
}));

vi.mock('@/state/agentIslandActivity', () => ({
  useAgentIslandActivity: (sessionId: string) => {
    const compactDetail = mocks.runningDetailBySession.get(sessionId);
    return compactDetail ? { phase: 'running', compactDetail } : null;
  },
}));

vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    ensureInitialMessages: mocks.ensureInitialMessages,
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

vi.mock('@/lib/sessionAttentionStore', () => ({
  useSessionAttentionKind: (sessionId: string) => mocks.attentionKindBySession.get(sessionId),
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
  scheduleFocusPath: (scheduleId: string) =>
    `/cc-agent/scheduled?focus=${encodeURIComponent(scheduleId)}`,
  useSessionBoundSchedules: (sessionId: string) =>
    mocks.boundSchedulesBySession.get(sessionId) ?? [],
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

function renderCase(caseId: string, overrides: Record<string, unknown> = {}) {
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
        ...overrides,
      }),
    ),
  );
}

/** 取本次渲染的行根元素(带 data-sidebar-session-row 标记)。 */
function sessionRowEl(): HTMLElement {
  const el = screen
    .getByTestId('visual-case')
    .querySelector('[data-sidebar-session-row="true"]') as HTMLElement | null;
  if (!el) throw new Error('session row not found');
  return el;
}

describe('SessionCard visual cases', () => {
  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.dropdownMenuOpen = false;
    mocks.boundSchedulesBySession.clear();
    mocks.worktreeSessionIds.clear();
    mocks.runningDetailBySession.clear();
    mocks.pendingPluginSetupSessionIds.clear();
    mocks.attentionKindBySession.clear();
    mocks.ensureInitialMessages.mockReset();
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

  // 2026-08-12 用户反馈:列表模式下选中会改变行高,把上下行推移、列表跳动。
  // 根因是 active 态加了真实 border 而未选中时没有——列表行高由内容撑开,
  // 1px 边框直接把该行加高 2px。改用 inset shadow(画在盒内、不参与布局),
  // 与 SessionItem(文字模式)当年的修法一致。
  it('列表模式:选中态不引入改变盒模型的 border(行高与未选中一致)', () => {
    renderCase('short-idle-cc', { variant: 'list', isActive: true });
    const activeRow = sessionRowEl();
    // 描边走 inset shadow,不是 border —— 后者会撑高行。
    expect(activeRow.className).toContain(
      'shadow-[inset_0_0_0_1px_var(--sidebar-item-active-border)]',
    );
    expect(activeRow.className).not.toMatch(/(^|\s)border(\s|$)/);
    expect(activeRow.className).not.toContain('border-[var(--sidebar-item-active-border)]');

    cleanup();
    renderCase('short-idle-cc', { variant: 'list', isActive: false });
    const idleRow = sessionRowEl();
    // 未选中同样没有 border —— 两态盒模型一致,切换不产生高度差。
    expect(idleRow.className).not.toMatch(/(^|\s)border(\s|$)/);
  });

  it('卡片模式的 border 恒定存在(只换颜色),不因选中而改变布局', () => {
    renderCase('short-idle-cc', { variant: 'card', isActive: true });
    expect(sessionRowEl().className).toMatch(/(^|\s)border(\s|$)/);
    cleanup();
    renderCase('short-idle-cc', { variant: 'card', isActive: false });
    expect(sessionRowEl().className).toMatch(/(^|\s)border(\s|$)/);
  });

  it('prefetches a new task on primary pointerdown before navigation', () => {
    renderCase('short-idle-cc');
    const card = screen
      .getByTestId('visual-case')
      .querySelector('[data-sidebar-session-row="true"]');
    expect(card).not.toBeNull();

    fireEvent.pointerDown(card!, { button: 0, pointerType: 'mouse' });

    expect(mocks.ensureInitialMessages).toHaveBeenCalledTimes(1);
    expect(mocks.ensureInitialMessages).toHaveBeenCalledWith('short-idle-cc');
  });

  it('does not expose split creation in the card task menu', () => {
    renderCase('short-idle-cc');

    fireEvent.click(
      screen.getByRole('button', {
        name: /^(?:更多操作|ccAgent\.sidebar\.sessionMenu\.moreActions)$/,
      }),
    );

    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: '重命名' })).toBeTruthy();
    expect(
      within(menu).queryByRole('menuitem', {
        name: /(?:splitGroup\.openInSplit|在分栏中打开)/,
      }),
    ).toBeNull();
  });

  it.each(['card', 'list'] as const)(
    'uses native %s dragging for normal content while excluding action buttons',
    (variant) => {
      const visualCase = sessionCardVisualCases.find((item) => item.id === 'short-idle-cc');
      if (!visualCase) throw new Error('Missing idle visual case');
      const values = new Map<string, string>();
      const dataTransfer = {
        effectAllowed: 'none',
        setData: (format: string, data: string) => values.set(format, data),
      };

      const { container } = render(
        createElement(
          'div',
          {
            'data-sortable-id': visualCase.session.id,
            'data-sortable-native-dnd': 'true',
          },
          createElement(SessionCard, {
            session: visualCase.session,
            variant,
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
          }),
        ),
      );

      const card = container.querySelector<HTMLElement>('[data-sidebar-session-row="true"]');
      const title = within(card!).getByText(visualCase.session.title);
      const actionButton = card?.querySelector<HTMLButtonElement>(
        'button[aria-label="ccAgent.sidebar.sessionMenu.moreActions"]',
      );
      expect(card?.draggable).toBe(true);
      expect(card?.className).toContain('cursor-pointer');
      expect(card?.className).not.toContain('cursor-grab');
      expect(card?.querySelector('[data-split-group-drag-handle="true"]')).toBeNull();
      expect(title.className).not.toContain('cursor-grab');
      expect(actionButton).not.toBeNull();

      fireEvent.pointerDown(title, { button: 0, pointerType: 'mouse' });
      fireEvent.dragStart(card!, { dataTransfer });

      expect(values.get(SPLIT_GROUP_SESSION_MIME)).toBe(visualCase.session.id);
      expect(dataTransfer.effectAllowed).toBe('copyMove');

      const openOutside = vi.fn().mockResolvedValue(false);
      const electronApiDescriptor = Object.getOwnPropertyDescriptor(window, 'electronAPI');
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: { maker: { openSessionInNewWindowIfDroppedOutside: openOutside } },
      });
      fireEvent.dragEnd(card!, { dataTransfer });
      expect(openOutside).toHaveBeenCalledWith(
        visualCase.session.id,
        visualCase.session.deviceLinkDeviceId,
      );
      if (electronApiDescriptor) {
        Object.defineProperty(window, 'electronAPI', electronApiDescriptor);
      } else {
        Reflect.deleteProperty(window, 'electronAPI');
      }

      values.clear();
      dataTransfer.effectAllowed = 'none';
      fireEvent.pointerDown(actionButton!, { button: 0, pointerType: 'mouse' });
      const blockedDragStart = createEvent.dragStart(card!, { dataTransfer });
      const preventDefault = vi.spyOn(blockedDragStart, 'preventDefault');
      fireEvent(card!, blockedDragStart);

      expect(preventDefault).toHaveBeenCalledOnce();
      expect(values.has(SPLIT_GROUP_SESSION_MIME)).toBe(false);
      expect(dataTransfer.effectAllowed).toBe('none');
    },
  );

  it.each(sessionCardVisualCases.map((item) => [item.label, item.id] as const))(
    'renders visual case: %s',
    (_label, id) => {
      renderCase(id);
      const root = screen.getByTestId('visual-case');
      const card = root.querySelector('[data-sidebar-session-row="true"]');
      const visualCase = sessionCardVisualCases.find((item) => item.id === id);
      expect(card).not.toBeNull();
      expect(card?.className).toContain('rounded-xl');
      expect(root.textContent).toContain(
        visualCase?.session.title.replace('[Schedule] ', '').slice(0, 4),
      );
    },
  );

  it('keeps single-line cards naturally shorter than long summary cards', () => {
    renderCase('short-idle-cc');
    const shortCard = screen
      .getByTestId('visual-case')
      .querySelector('[data-sidebar-session-row="true"]');
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
    expect(screen.getByRole('button', { name: '查看自动化任务' }).getAttribute('title')).toBe(
      '由自动化创建',
    );
    expect(
      screen.getByRole('button', { name: '查看自动化任务' }).querySelector('.lucide-timer'),
    ).not.toBeNull();
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
    mocks.boundSchedulesBySession.set(visualCase.session.id, [
      scheduleForCase(visualCase.session.id, 'active'),
    ]);
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
    const { container: listContainer } = render(
      createElement(SessionCard, { ...commonProps, variant: 'list' }),
    );
    const listTitleRow = Array.from(listContainer.querySelectorAll<HTMLElement>('div')).find(
      (node) =>
        node.className.includes('h-[22px]') &&
        node.textContent?.includes('自动化日报巡检') &&
        node.querySelector('[aria-label="查看自动化任务"]'),
    );
    expect(listTitleRow?.textContent).toContain('自动化日报巡检');
    expect(listTitleRow?.querySelector('[aria-label="查看自动化任务"]')).not.toBeNull();
  });

  it('keeps the list title row height stable while the rename editor overlays it', () => {
    const visualCase = sessionCardVisualCases.find((item) => item.id === 'short-idle-cc');
    if (!visualCase) throw new Error('Missing idle visual case');

    const { container } = render(
      createElement(SessionCard, {
        session: visualCase.session,
        variant: 'list',
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
      }),
    );

    const card = container.querySelector<HTMLElement>('[data-sidebar-session-row="true"]')!;
    const titleRow = Array.from(card.querySelectorAll<HTMLElement>('div')).find(
      (node) =>
        node.className.includes('h-[22px]') && node.textContent?.includes(visualCase.session.title),
    );
    expect(titleRow).toBeTruthy();
    const statusIconSlot = Array.from(titleRow!.querySelectorAll<HTMLElement>('span')).find(
      (node) => node.className.includes('w-3') && node.querySelector('svg'),
    );
    expect(statusIconSlot).toBeTruthy();

    fireEvent.doubleClick(card);

    const input = card.querySelector<HTMLInputElement>('input')!;
    const editor = input.parentElement!;
    expect(editor.parentElement).toBe(titleRow);
    expect(editor.classList.contains('relative')).toBe(true);
    expect(editor.classList.contains('self-stretch')).toBe(true);
    expect(input.classList.contains('absolute')).toBe(true);
    expect(input.classList.contains('inset-x-0')).toBe(true);
    expect(input.classList.contains('top-1/2')).toBe(true);
    expect(input.classList.contains('-translate-y-1/2')).toBe(true);
    expect(input.classList.contains('h-6')).toBe(true);
    expect(titleRow!.contains(statusIconSlot!)).toBe(true);
  });

  it('keeps the card title flow box mounted while the rename editor overlays it without a duplicate status icon', () => {
    const visualCase = sessionCardVisualCases.find((item) => item.id === 'short-idle-cc');
    if (!visualCase) throw new Error('Missing idle visual case');

    const { container } = render(
      createElement(SessionCard, {
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
      }),
    );

    const card = container.querySelector<HTMLElement>('[data-sidebar-session-row="true"]')!;
    const title = Array.from(card.querySelectorAll<HTMLElement>('div')).find((node) =>
      node.className.includes('[-webkit-line-clamp:2]'),
    )!;
    expect(title.classList.contains('invisible')).toBe(false);

    fireEvent.doubleClick(card);

    const input = card.querySelector<HTMLInputElement>('input')!;
    const overlay = input.parentElement!;
    const titleSlot = title.parentElement!;
    expect(card.contains(title)).toBe(true);
    expect(title.classList.contains('invisible')).toBe(true);
    expect(titleSlot).toBe(overlay.parentElement);
    expect(titleSlot.classList.contains('relative')).toBe(true);
    expect(overlay.classList.contains('absolute')).toBe(true);
    expect(overlay.classList.contains('inset-x-0')).toBe(true);
    expect(overlay.classList.contains('top-1/2')).toBe(true);
    expect(overlay.classList.contains('-translate-y-1/2')).toBe(true);
    expect(titleSlot.querySelectorAll('svg')).toHaveLength(1);
    expect(titleSlot.querySelector('.lucide-sparkles')).not.toBeNull();
    expect(input.classList.contains('h-6')).toBe(true);
  });

  it('keeps archived sessions on the archive visual branch', () => {
    renderCase('archived');
    expect(screen.getByText('已归档的历史分析任务')).toBeTruthy();
  });

  it('matches text-mode action chrome in list mode while preserving card buttons', () => {
    const visualCase = sessionCardVisualCases.find((item) => item.id === 'short-idle-cc');
    if (!visualCase) throw new Error('Missing idle visual case');

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
    const moreActionsName = /^(?:更多操作|ccAgent\.sidebar\.sessionMenu\.moreActions)$/;

    const { container: listContainer } = render(
      createElement(SessionCard, { ...commonProps, variant: 'list' }),
    );
    const listMore = within(listContainer).getByRole('button', {
      name: moreActionsName,
    });
    const listArchive = within(listContainer).getByRole('button', { name: '归档' });
    for (const action of [listMore, listArchive]) {
      expect(action.className).toContain('size-5');
      expect(action.className).toContain('rounded-md');
      expect(action.className).toContain('text-sidebar-action-icon');
      expect(action.className).not.toContain('size-6');
      expect(action.className).not.toContain('bg-[var(--cmd-palette-bg)]');
      expect(action.className).not.toContain('border-sidebar-border');
      expect(action.querySelector('svg')?.getAttribute('width')).toBe('14');
    }
    // C 期起 time 包在 SessionInfoMeta 的 span 里;最近的 div 祖先才是让位容器。
    const listTimeFade = listContainer.querySelector('time')?.closest('div');
    expect(listTimeFade?.className).toContain('group-focus-within/slot:opacity-0');
    expect(listTimeFade?.parentElement?.className).toContain('group/slot');
    cleanup();

    const { container: activeListContainer } = render(
      createElement(SessionCard, { ...commonProps, variant: 'list', isActive: true }),
    );
    const activeListMore = within(activeListContainer).getByRole('button', {
      name: moreActionsName,
    });
    expect(activeListMore.className).toContain('text-sidebar-item-active-foreground');
    expect(activeListMore.className).toContain(
      'hover:bg-[color-mix(in_srgb,var(--sidebar-item-active-foreground)_14%,transparent)]',
    );
    cleanup();

    const { container: cardContainer } = render(createElement(SessionCard, commonProps));
    const cardMore = within(cardContainer).getByRole('button', {
      name: moreActionsName,
    });
    expect(cardMore.className).toContain('size-6');
    expect(cardMore.className).toContain('bg-[var(--cmd-palette-bg)]');
    expect(cardMore.className).toContain('border-sidebar-border');
    expect(cardMore.className).not.toContain('size-5');
    expect(cardMore.querySelector('svg')?.getAttribute('width')).toBe('13');
  });

  it.each(['list', 'card'] as const)(
    'keeps the %s archive confirmation pill on one line',
    (variant) => {
      const visualCase = sessionCardVisualCases.find((item) => item.id === 'short-idle-cc');
      if (!visualCase) throw new Error('Missing idle visual case');

      const { container } = render(
        createElement(SessionCard, {
          session: visualCase.session,
          variant: variant === 'list' ? 'list' : undefined,
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
        }),
      );

      fireEvent.click(screen.getByRole('button', { name: '归档' }));
      const confirmPill = screen.getByRole('button', { name: '归档' });
      expect(confirmPill.className).toContain('w-max');
      expect(confirmPill.className).toContain('min-w-14');
      expect(confirmPill.className).toContain('whitespace-nowrap');
      expect(confirmPill.className).toContain('var(--surface-elevated)');
      expect(confirmPill.className).not.toContain('transparent');
      if (variant === 'list') {
        // 让位容器是 time 最近的 div 祖先(time 嵌在 SessionInfoMeta span 内)。
        expect(container.querySelector('time')?.closest('div')?.className).toContain('invisible');
      }
    },
  );

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

    const { container: listContainer } = render(
      createElement(SessionCard, { ...commonProps, variant: 'list' }),
    );
    expect(listContainer.textContent).toContain('正在实时扫描并刷新当前执行步骤');
  });

  it.each(['list', 'card'] as const)(
    'keeps running %s text colors identical to idle',
    (variant) => {
      const visualCase = sessionCardVisualCases.find((item) => item.id === 'running-loading');
      if (!visualCase) throw new Error('Missing running visual case');

      const renderColors = (isRunning: boolean) => {
        const { container } = render(
          createElement(SessionCard, {
            session: visualCase.session,
            variant: variant === 'list' ? 'list' : undefined,
            isActive: false,
            isRunning,
            isAttached: false,
            hasAttentionNotification: false,
            isSelected: false,
            onClick: vi.fn(),
            onAction: vi.fn(),
            onRename: vi.fn(),
            onTogglePin: vi.fn(),
            projectOptions: [],
          }),
        );
        const title =
          variant === 'list'
            ? Array.from(container.querySelectorAll('span')).find(
                (node) =>
                  node.className.includes('truncate') &&
                  node.textContent?.includes(visualCase.session.title),
              )
            : Array.from(container.querySelectorAll('div')).find((node) =>
                node.className.includes('[-webkit-line-clamp:2]'),
              );
        const preview = Array.from(container.querySelectorAll('p')).find((node) =>
          node.textContent?.includes('正在分析本周项目数据与异常波动。'),
        );
        const time = container.querySelector('time');
        const colors = [title, preview, time].map((node) =>
          node?.className
            .split(' ')
            .filter(
              (className) =>
                className === 'text-foreground' ||
                className.startsWith('text-[var(--text-') ||
                className === 'text-[var(--cmd-palette-item-meta)]',
            ),
        );
        cleanup();
        return colors;
      };

      expect(renderColors(true)).toEqual(renderColors(false));
    },
  );

  it.each([
    ['done', 'var(--card-status-done)'],
    ['awaiting', 'var(--card-status-awaiting)'],
    ['error', 'var(--card-status-error)'],
  ] as const)('moves the %s attention dot to the list bottom-right corner', (kind, color) => {
    const visualCase = sessionCardVisualCases.find((item) => item.id === 'attention-dot');
    if (!visualCase) throw new Error('Missing attention visual case');
    mocks.attentionKindBySession.set(visualCase.session.id, kind);

    const { container } = render(
      createElement(SessionCard, {
        session: visualCase.session,
        variant: 'list',
        isActive: false,
        isRunning: false,
        isAttached: false,
        hasAttentionNotification: true,
        isSelected: false,
        onClick: vi.fn(),
        onAction: vi.fn(),
        onRename: vi.fn(),
        onTogglePin: vi.fn(),
        projectOptions: [],
      }),
    );

    const rightStatus = container.querySelector(`[data-sidebar-right-status="${kind}"]`);
    expect(rightStatus?.className).toContain('right-2.5');
    expect(rightStatus?.className).toContain('bottom-2');
    expect((rightStatus?.firstElementChild as HTMLElement | null)?.style.backgroundColor).toBe(
      color,
    );

    const title = Array.from(container.querySelectorAll('span')).find(
      (node) =>
        node.className.includes('truncate') && node.textContent?.includes(visualCase.session.title),
    );
    expect(
      Array.from(title?.querySelectorAll('span') ?? []).some((node) =>
        node.className.includes('bg-[var(--card-status-'),
      ),
    ).toBe(false);
  });

  it('uses the text-mode priority when a list session is both running and unread-done', () => {
    const visualCase = sessionCardVisualCases.find((item) => item.id === 'attention-dot');
    if (!visualCase) throw new Error('Missing attention visual case');
    mocks.attentionKindBySession.set(visualCase.session.id, 'done');

    const { container } = render(
      createElement(SessionCard, {
        session: visualCase.session,
        variant: 'list',
        isActive: false,
        isRunning: true,
        isAttached: false,
        hasAttentionNotification: true,
        isSelected: false,
        onClick: vi.fn(),
        onAction: vi.fn(),
        onRename: vi.fn(),
        onTogglePin: vi.fn(),
        projectOptions: [],
      }),
    );

    const rightStatus = container.querySelector('[data-sidebar-right-status="running"]');
    expect(rightStatus?.className).toContain('right-2.5');
    expect(rightStatus?.className).toContain('bottom-2');
    expect(container.querySelector('[data-sidebar-right-status="done"]')).toBeNull();
  });

  it('keeps the attention dot on the status icon in card mode', () => {
    const visualCase = sessionCardVisualCases.find((item) => item.id === 'attention-dot');
    if (!visualCase) throw new Error('Missing attention visual case');
    mocks.attentionKindBySession.set(visualCase.session.id, 'done');

    const { container } = render(
      createElement(SessionCard, {
        session: visualCase.session,
        isActive: false,
        isRunning: false,
        isAttached: false,
        hasAttentionNotification: true,
        isSelected: false,
        onClick: vi.fn(),
        onAction: vi.fn(),
        onRename: vi.fn(),
        onTogglePin: vi.fn(),
        projectOptions: [],
      }),
    );

    expect(container.querySelector('[data-sidebar-right-status]')).toBeNull();
    expect(
      Array.from(container.querySelectorAll('span')).some((node) =>
        node.className.includes('bg-[var(--card-status-done)]'),
      ),
    ).toBe(true);
  });
});
