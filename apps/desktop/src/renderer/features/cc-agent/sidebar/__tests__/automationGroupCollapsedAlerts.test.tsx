// @vitest-environment jsdom

/**
 * 定时任务分组头 —— 收起态的未处理告警必须可见(行为回归,不是源码形状断言)。
 *
 * 复现的线上现象:某项目折叠后行右侧亮红点,展开项目却在任何一行上都找不到它。
 * 成因是两层折叠叠加 —— 组头此前只代表「最新一条」运行,而收起态子行整片不渲染,
 * 于是「组内第 3 新的运行留下未处理告警」(实测是一条被 App 重启打断、turn 从未
 * 收尾的定时任务运行)既不上组头、也不成行,而项目折叠头是按**全部**子任务汇总的。
 *
 * 本测试钉住修复后的两条:
 *   1. 收起态组头按整组汇总点红(不是只看最新一条);
 *   2. 收起态的未读及告警可由组头或独立子行打开，同一任务不重复显示。
 * 都从同一份判据(resolveCollapsedAttention)出发,所以不可能再「汇总说有、列表没有」。
 */

import { createElement, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';
import type {
  AutomationScheduleAction,
  AutomationSessionGroup,
} from '../../lib/automationSidebarGrouping';
import { addSessionAttention, clearSessionAttention } from '@/lib/sessionAttentionStore';
import {
  applyRemoteSessionActivity,
  clearRemoteSessionActivity,
} from '@/features/device-link/remoteSessionActivityStore';

// ── mocks:剥离与「收起态告警可见性」无关的重依赖 ─────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
  initReactI18next: { type: '3rdParty' as const, init: () => {} },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

// 子行探针:只登记「哪些运行被渲染成行」,不拖进 SessionItem 的全套依赖。
vi.mock('../SessionItem', () => ({
  SessionItem: ({ session }: { session: { id: string } }) =>
    createElement('div', { 'data-child-run': session.id }),
  hasSessionSelectionModifier: () => false,
}));

vi.mock('../SessionCard', () => ({
  SessionCard: ({ session }: { session: { id: string } }) =>
    createElement('div', { 'data-child-run': session.id }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/components/ui/dropdown-menu', () => ({
  // Radix only mounts the menu while it is open, so a case has to reach the menu through the
  // real entry point (right-click on the group header) instead of assuming it is in the tree.
  DropdownMenu: ({ open, children }: { open?: boolean; children: React.ReactNode }) =>
    open ? children : null,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
  }) =>
    createElement(
      'button',
      {
        role: 'menuitem',
        onClick: onSelect,
        disabled,
        ...(disabled ? { 'data-disabled': '' } : {}),
      },
      children,
    ),
  DropdownMenuSeparator: () => null,
}));

vi.mock('@/components/sidebar/VendorIcon', () => ({
  VendorIcon: () => null,
  agentKindToVendor: () => 'cc',
}));

vi.mock('../AutomationTimerIcon', () => ({
  AutomationTimerIcon: () => null,
}));

vi.mock('@/state/agentIslandActivity', () => ({
  useAgentIslandActivity: () => undefined,
}));

vi.mock('@/features/scheduler/lib/scheduleSessionBinding', () => ({
  scheduleFocusPath: (id: string) => `/cc-agent/scheduled?focus=${id}`,
}));

// mock 之后再 import,确保组件拿到探针版依赖。
import { AutomationSessionGroupItem } from '../AutomationSessionGroupItem';
import { SessionAttentionUrgencyProvider } from '../../contexts/SessionAttentionUrgencyContext';

// ── fixtures ─────────────────────────────────────────────────────────────────

/** run-0 最新,序号越大越旧(sessionActivityMs 取 updatedAt / userSendAt 较新者)。 */
function makeRun(index: number): Session {
  const iso = new Date(Date.parse('2026-08-21T12:00:00.000Z') - index * 3_600_000).toISOString();
  return {
    id: `run-${index}`,
    title: `[Schedule] 巡检 ${index}`,
    status: 'active',
    source: 'scheduler',
    createdAt: iso,
    updatedAt: iso,
    userSendAt: iso,
    pinnedAt: null,
    sdkSessionId: null,
    remoteHostId: null,
    deviceLinkDeviceId: null,
    workspaceKind: 'project',
    workingDir: '/repo',
    _count: { messages: 5 },
  } as unknown as Session;
}

const RUNS = [makeRun(0), makeRun(1), makeRun(2), makeRun(3)];
const MANY_RUNS = Array.from({ length: 8 }, (_, index) => makeRun(index));
const ALL_IDS = MANY_RUNS.map((run) => run.id);
const noop = () => {};

function GroupHarness({
  sessions,
  notifications,
  urgentSessionIds,
  initialCollapsed,
  onSessionClick = noop,
  onScheduleAction = noop,
  deviceLinkDeviceId,
  scheduleId = 'sched-1',
}: {
  sessions: Session[];
  notifications: string[];
  urgentSessionIds: ReadonlySet<string>;
  initialCollapsed: boolean;
  onSessionClick?: (sessionId: string) => void;
  onScheduleAction?: (group: AutomationSessionGroup, action: AutomationScheduleAction) => void;
  deviceLinkDeviceId?: string;
  /** null models an automation that has been deleted: the group keeps its runs but loses its schedule. */
  scheduleId?: string | null;
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  return createElement(SessionAttentionUrgencyProvider, {
    urgentSessionIds,
    children: createElement(AutomationSessionGroupItem, {
      group: {
        id: 'schedule:sched-1',
        scheduleId: scheduleId ?? undefined,
        scheduleStatus: 'active',
        deviceLinkDeviceId,
        title: '产品决策巡检',
        sessions,
        attentionSessionIds: notifications,
      },
      runningSessionIds: new Set<string>(),
      attachedSessionIds: new Set<string>(),
      notifications: new Set(notifications),
      collapsed,
      onCollapsedChange: setCollapsed,
      onSessionClick,
      onAction: noop,
      onRename: noop,
      onTogglePin: noop,
      onScheduleAction,
    }),
  });
}

function renderGroup({
  sessions = RUNS,
  notifications = [],
  urgentSessionIds = new Set<string>(),
  collapsed = true,
  onSessionClick,
}: {
  sessions?: Session[];
  notifications?: string[];
  urgentSessionIds?: ReadonlySet<string>;
  collapsed?: boolean;
  onSessionClick?: (sessionId: string) => void;
} = {}) {
  return render(
    createElement(GroupHarness, {
      sessions,
      notifications,
      urgentSessionIds,
      initialCollapsed: collapsed,
      onSessionClick,
    }),
  );
}

/** The entry point under test: right-clicking the group header opens the same 更多 menu. */
function openGroupMenu() {
  fireEvent.contextMenu(screen.getByText('产品决策巡检'));
}

const childRunIds = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-child-run]')].map(
    (node) => node.getAttribute('data-child-run') ?? '',
  );

afterEach(() => {
  cleanup();
  clearRemoteSessionActivity();
  for (const id of ALL_IDS) clearSessionAttention(id, { intent: 'explicit' });
});

beforeEach(() => {
  for (const id of ALL_IDS) clearSessionAttention(id, { intent: 'explicit' });
});

describe('AutomationSessionGroupItem — 收起态的未处理告警', () => {
  // Feature regression (unit): the actual group menu must dispatch all members,
  // even while collapsed. Existing alert tests do not exercise menu actions.
  // Minimal input: two hidden runs; remote and archived-only groups cannot archive.
  // Standalone validation: Vitest 2.71s, tests 159ms (2026-10-27).
  it.each(['local', 'remote', 'archived'] as const)(
    'offers bulk archive only for active local groups (%s)',
    (kind) => {
      const onScheduleAction = vi.fn();
      const sessions = RUNS.slice(0, 2).map((run) => ({
        ...run,
        status: kind === 'archived' ? ('archived' as const) : ('active' as const),
      }));
      const { container } = render(
        createElement(GroupHarness, {
          sessions,
          notifications: [],
          urgentSessionIds: new Set<string>(),
          initialCollapsed: true,
          onScheduleAction,
          deviceLinkDeviceId: kind === 'remote' ? 'other-computer' : undefined,
        }),
      );
      expect(childRunIds(container)).toEqual([]);
      openGroupMenu();
      const menuItem = screen.queryByRole('menuitem', {
        name: 'ccAgent.sidebar.projectAction.archivedAll',
      });
      if (kind === 'remote') {
        expect(menuItem).toBeNull();
      } else {
        expect(menuItem).not.toBeNull();
        fireEvent.click(menuItem!);
        if (kind === 'archived') expect(onScheduleAction).not.toHaveBeenCalled();
        else
          expect(onScheduleAction).toHaveBeenCalledWith(
            expect.objectContaining({ sessions }),
            'archive-all',
          );
      }
    },
  );

  // #8594 regression (unit). Deleting an automation leaves its past runs under a fallback
  // group key with no scheduleId, and the header used to gate its whole action slot on
  // scheduleId — so the user could neither hover-archive nor right-click a group whose runs
  // are still active. Production entry: AutomationSessionGroupItem header menu; observable
  // result: the archive-all menu item dispatches 'archive-all' for the group's sessions.
  // Gap in existing coverage: every case above renders a group that still has a schedule.
  // Minimal failing input: scheduleId undefined with an active run.
  function renderOrphanGroup(sessions: Session[], onScheduleAction = vi.fn()) {
    const { container } = render(
      createElement(GroupHarness, {
        sessions,
        notifications: [],
        urgentSessionIds: new Set<string>(),
        initialCollapsed: true,
        onScheduleAction,
        scheduleId: null,
      }),
    );
    return { container, onScheduleAction };
  }

  it('keeps the bulk archive entry for runs of a deleted automation', () => {
    const sessions = RUNS.slice(0, 2);
    const { container, onScheduleAction } = renderOrphanGroup(sessions);
    expect(childRunIds(container)).toEqual([]);
    expect(
      screen.queryByRole('menuitem', { name: 'ccAgent.sidebar.projectAction.archivedAll' }),
    ).toBeNull();
    openGroupMenu();
    const menuItem = screen.getByRole('menuitem', {
      name: 'ccAgent.sidebar.projectAction.archivedAll',
    });
    expect(menuItem.hasAttribute('data-disabled')).toBe(false);
    fireEvent.click(menuItem);
    expect(onScheduleAction).toHaveBeenCalledWith(
      expect.objectContaining({ sessions }),
      'archive-all',
    );
  });

  it('does not offer to delete an automation that is already gone', () => {
    renderOrphanGroup(RUNS.slice(0, 2));
    openGroupMenu();
    expect(
      screen.queryByRole('menuitem', { name: 'ccAgent.sidebar.automationGroup.menu.delete' }),
    ).toBeNull();
  });

  // An orphan group with nothing left to archive gets no action slot at all, so the header
  // does not offer an operation that can only fail.
  it('offers no bulk archive entry once an orphan group has nothing active', () => {
    const sessions = RUNS.slice(0, 2).map((run) => ({ ...run, status: 'archived' as const }));
    const { onScheduleAction } = renderOrphanGroup(sessions);
    openGroupMenu();
    expect(
      screen.queryByRole('menuitem', { name: 'ccAgent.sidebar.projectAction.archivedAll' }),
    ).toBeNull();
    expect(onScheduleAction).not.toHaveBeenCalled();
  });

  it('still offers delete for a group whose automation exists', () => {
    render(
      createElement(GroupHarness, {
        sessions: RUNS.slice(0, 2),
        notifications: [],
        urgentSessionIds: new Set<string>(),
        initialCollapsed: true,
      }),
    );
    openGroupMenu();
    expect(
      screen.getByRole('menuitem', { name: 'ccAgent.sidebar.automationGroup.menu.delete' }),
    ).not.toBeNull();
  });

  it('无告警时收起就是收起:组头不点状态、不渲染子行', () => {
    const { container } = renderGroup();
    expect(childRunIds(container)).toEqual([]);
    expect(screen.queryByLabelText('Failed — click to view')).toBeNull();
  });

  it('组内旧运行留下告警时由红色组头代表,不重复成行', () => {
    // 收起态组头直接打开 run-2，下面不能重复同一任务。
    addSessionAttention('run-2', 'error');
    const { container } = renderGroup({ notifications: ['run-2'] });

    expect(screen.getByLabelText('Failed — click to view')).toBeTruthy();
    expect(childRunIds(container)).toEqual([]);
  });

  it('定时任务失败未读(attention kind 缺失)同样算告警,不被涂成完成绿', () => {
    const { container } = renderGroup({
      notifications: ['run-3'],
      urgentSessionIds: new Set(['run-3']),
    });

    expect(screen.getByLabelText('Failed — click to view')).toBeTruthy();
    expect(screen.queryByLabelText('Completed — click to view')).toBeNull();
    expect(childRunIds(container)).toEqual([]);
  });

  it('完成未读时组头补绿点且运行单独成行', () => {
    addSessionAttention('run-2', 'done');
    const { container } = renderGroup({ notifications: ['run-2'] });

    expect(screen.getByLabelText('Completed — click to view')).toBeTruthy();
    expect(screen.queryByLabelText('Failed — click to view')).toBeNull();
    expect(childRunIds(container)).toEqual(['run-2']);
  });

  // 用户规则（unit）：非静默未读全部露出；最小缺口是没有 chat attention kind 的
  // scheduler 未读，以及超过五条的情况。通过真实组件验证已读后收回和远程镜像。
  it.each(['local', 'remote'] as const)('所有完成未读可见,已读或静默成功隐藏 (%s)', (kind) => {
    const sessions = MANY_RUNS.map((run) => ({
      ...run,
      deviceLinkDeviceId: kind === 'remote' ? 'remote' : undefined,
    }));
    const unreadIds = ALL_IDS.slice(1, 7);
    if (kind === 'remote') {
      for (const session of sessions)
        applyRemoteSessionActivity('remote', {
          sessionId: session.id,
          phase: 'completed',
          attention: unreadIds.includes(session.id),
          compactDetail: '',
        });
    }
    const { container, rerender } = renderGroup({ sessions, notifications: unreadIds });
    expect(childRunIds(container)).toEqual(unreadIds);
    // 无未读的 run-0 / run-7（已读或静默成功）不因最近活动而显示。
    if (kind === 'remote')
      act(() => {
        for (const id of unreadIds)
          applyRemoteSessionActivity('remote', {
            sessionId: id,
            phase: 'completed',
            attention: false,
            compactDetail: '',
          });
      });
    rerender(
      createElement(GroupHarness, {
        sessions,
        notifications: [],
        urgentSessionIds: new Set<string>(),
        initialCollapsed: true,
      }),
    );
    expect(childRunIds(container)).toEqual([]);
  });

  it('收起且整组是红时,点组头打开告警那条而不是最新一条', () => {
    const onSessionClick = vi.fn();
    renderGroup({
      urgentSessionIds: new Set(['run-3']),
      onSessionClick,
    });

    fireEvent.click(screen.getByText('产品决策巡检'));
    expect(onSessionClick).toHaveBeenCalledWith('run-3');
    expect(onSessionClick).not.toHaveBeenCalledWith('run-0');
  });

  // 用户规则（unit）：只在折叠时排除组头任务；展开后无论已读未读都保留子行。
  // 从真实组头点击、冻结与显示全部验证，覆盖展开／收起往返。
  it.each([true, false])('组头任务展开时有子行,折叠时不重复 (未读=%s)', (unread) => {
    const onSessionClick = vi.fn();
    const { container } = renderGroup({
      sessions: MANY_RUNS, notifications: unread ? ['run-0', 'run-7'] : ['run-7'], onSessionClick,
    });
    expect(childRunIds(container)).toEqual(['run-7']);
    fireEvent.click(screen.getByText('产品决策巡检'));
    expect(onSessionClick).toHaveBeenLastCalledWith('run-0');
    fireEvent.click(screen.getByLabelText('ccAgent.sidebar.automationGroup.expand'));
    expect(childRunIds(container)).toEqual(['run-0', 'run-1', 'run-2', 'run-3', 'run-4', 'run-7']);
    fireEvent.click(screen.getByText('产品决策巡检'));
    expect(childRunIds(container)).toContain('run-0');
    fireEvent.click(screen.getByText(/ccAgent\.sidebar\.showAllSessions/));
    expect(childRunIds(container)).toEqual(ALL_IDS);
    fireEvent.click(screen.getByLabelText('ccAgent.sidebar.automationGroup.collapse'));
    expect(childRunIds(container)).toEqual(['run-7']);
  });

  it('等待回复的旧运行单独成行,组头仍代表最新运行', () => {
    addSessionAttention('run-2', 'awaiting');
    const { container, rerender } = renderGroup({ notifications: ['run-2'] });

    expect(screen.queryByLabelText('Failed — click to view')).toBeNull();
    expect(screen.queryByLabelText('Awaiting your input')).toBeNull();
    expect(childRunIds(container)).toEqual(['run-2']);
    act(() => clearSessionAttention('run-2', { intent: 'explicit' }));
    rerender(
      createElement(GroupHarness, {
        sessions: RUNS,
        notifications: [],
        urgentSessionIds: new Set<string>(),
        initialCollapsed: true,
      }),
    );
    expect(childRunIds(container)).toEqual([]);
  });

  it('远程旧运行等待回复时也成行,远程运行态压过本地残留的待回复', () => {
    const sessions = RUNS.map((run) => ({ ...run, deviceLinkDeviceId: 'remote' }));
    addSessionAttention('run-2', 'awaiting');
    applyRemoteSessionActivity('remote', {
      sessionId: 'run-2',
      phase: 'needs-interaction',
      attention: true,
      compactDetail: '',
    });
    const { container, rerender } = renderGroup({ sessions });
    expect(childRunIds(container)).toEqual(['run-2']);
    expect(screen.queryByLabelText('Awaiting your input')).toBeNull();
    act(() =>
      applyRemoteSessionActivity('remote', {
        sessionId: 'run-2',
        phase: 'running',
        attention: false,
        compactDetail: '',
      }),
    );
    rerender(
      createElement(GroupHarness, {
        sessions,
        notifications: ['run-2'],
        urgentSessionIds: new Set<string>(),
        initialCollapsed: true,
      }),
    );
    expect(childRunIds(container)).toEqual([]);
  });

  it('收起态显示全部待处理运行,展开后仍按普通历史上限折叠', () => {
    // 收起态的六条待处理运行全部可见；展开后普通旧历史仍保留前五条上限。
    const staleRuns = Array.from({ length: 8 }, (_, index) => {
      const iso = new Date(
        Date.parse('2026-08-10T12:00:00.000Z') - index * 3_600_000,
      ).toISOString();
      return { ...makeRun(index), createdAt: iso, updatedAt: iso, userSendAt: iso };
    });
    const alerts = staleRuns.slice(2).map((run) => run.id);
    const { container } = renderGroup({
      sessions: staleRuns,
      urgentSessionIds: new Set(alerts),
    });

    expect(childRunIds(container)).toEqual(alerts.slice(1));

    fireEvent.click(screen.getByLabelText('ccAgent.sidebar.automationGroup.expand'));
    const expandedIds = childRunIds(container);
    expect(expandedIds).toEqual(['run-0', 'run-1', 'run-2', 'run-3', 'run-4']);
    expect(expandedIds).not.toContain('run-7');
  });
});
