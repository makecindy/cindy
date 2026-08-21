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
 *   2. 收起态把带告警的那条运行提上来单独成行,用户能直接点开处置。
 * 都从同一份判据(resolveCollapsedAttention)出发,所以不可能再「汇总说有、列表没有」。
 */

import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';
import { addSessionAttention, clearSessionAttention } from '@/lib/sessionAttentionStore';

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
  DropdownMenu: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuContent: () => null,
  DropdownMenuItem: () => null,
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
const ALL_IDS = RUNS.map((run) => run.id);
const noop = () => {};

function renderGroup({
  notifications = [],
  urgentSessionIds = new Set<string>(),
}: {
  notifications?: string[];
  urgentSessionIds?: ReadonlySet<string>;
} = {}) {
  return render(
    createElement(SessionAttentionUrgencyProvider, {
      urgentSessionIds,
      children: createElement(AutomationSessionGroupItem, {
        group: {
          id: 'schedule:sched-1',
          scheduleId: 'sched-1',
          scheduleStatus: 'active',
          title: '产品决策巡检',
          sessions: RUNS,
          attentionSessionIds: notifications,
        },
        runningSessionIds: new Set<string>(),
        attachedSessionIds: new Set<string>(),
        notifications: new Set(notifications),
        // 受控收起:本测试只关心收起态,不依赖 localStorage 里的持久化偏好。
        collapsed: true,
        onCollapsedChange: noop,
        onSessionClick: noop,
        onAction: noop,
        onRename: noop,
        onTogglePin: noop,
        onScheduleAction: noop,
      }),
    }),
  );
}

const childRunIds = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-child-run]')].map(
    (node) => node.getAttribute('data-child-run') ?? '',
  );

afterEach(() => {
  cleanup();
  for (const id of ALL_IDS) clearSessionAttention(id, { intent: 'explicit' });
});

beforeEach(() => {
  for (const id of ALL_IDS) clearSessionAttention(id, { intent: 'explicit' });
});

describe('AutomationSessionGroupItem — 收起态的未处理告警', () => {
  it('无告警时收起就是收起:组头不点状态、不渲染子行', () => {
    const { container } = renderGroup();
    expect(childRunIds(container)).toEqual([]);
    expect(screen.queryByLabelText('Failed — click to view')).toBeNull();
  });

  it('组内非最新一条留下告警时,组头点红且该条被提上来成行', () => {
    // run-2 = 「第 3 新、turn 从未收尾」的那条;组头代表的是 run-0。
    addSessionAttention('run-2', 'error');
    const { container } = renderGroup({ notifications: ['run-2'] });

    expect(screen.getByLabelText('Failed — click to view')).toBeTruthy();
    expect(childRunIds(container)).toEqual(['run-2']);
  });

  it('定时任务失败未读(attention kind 缺失)同样算告警,不被涂成完成绿', () => {
    const { container } = renderGroup({
      notifications: ['run-3'],
      urgentSessionIds: new Set(['run-3']),
    });

    expect(screen.getByLabelText('Failed — click to view')).toBeTruthy();
    expect(screen.queryByLabelText('Completed — click to view')).toBeNull();
    expect(childRunIds(container)).toEqual(['run-3']);
  });

  it('只有完成未读时组头补绿点,但不提行(绿点不是待处理告警)', () => {
    addSessionAttention('run-2', 'done');
    const { container } = renderGroup({ notifications: ['run-2'] });

    expect(screen.getByLabelText('Completed — click to view')).toBeTruthy();
    expect(screen.queryByLabelText('Failed — click to view')).toBeNull();
    expect(childRunIds(container)).toEqual([]);
  });

  it('等待回复(蓝)不升格成组头状态,也不提行', () => {
    addSessionAttention('run-2', 'awaiting');
    const { container } = renderGroup({ notifications: ['run-2'] });

    expect(screen.queryByLabelText('Failed — click to view')).toBeNull();
    expect(screen.queryByLabelText('Awaiting your input')).toBeNull();
    expect(childRunIds(container)).toEqual([]);
  });
});
