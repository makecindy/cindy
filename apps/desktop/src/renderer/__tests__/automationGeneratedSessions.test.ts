/**
 * Automation-generated sessions are ordinary sidebar sessions.
 *
 * The schedule itself stays in Automations. Sessions produced by a schedule run
 * must flow through the same project/dialogue grouping, redirect, tabs, and
 * notification paths as user-created sessions, with only a small source marker.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  DESKTOP_VISIBLE_SESSION_SOURCES,
  normalizeSessionSource,
} from '../../shared/sessionSource';
import {
  addSessionAttention,
  clearSessionAttentionMany,
  getSessionAttentionSnapshot,
  hasSessionAttention,
} from '@/lib/sessionAttentionStore';
import type { Session } from '@/lib/ccAgent.types';
import {
  getAutomationGroupChildView,
  getAutomationGroupLatestSession,
  getAutomationGroupPrimarySession,
  getVisibleAutomationGroupSessions,
  groupAutomationSidebarEntries,
  type AutomationScheduleSessionInfo,
} from '@/features/cc-agent/lib/automationSidebarGrouping';
import { groupSessions } from '@/features/cc-agent/lib/projectGrouping';
import {
  getAutomationSessionDisplayTitle,
  groupScheduledSessions,
  isAutomationGeneratedSession,
  isScheduledSession,
} from '@/features/cc-agent/lib/scheduledSessionGrouping';
import { getFocusedScheduleStatusFilter } from '@/features/scheduler/SchedulerPage';
import { isUnreadScheduleRun } from '@/features/scheduler/lib/runUnread';
import { formatUsd } from '@/features/scheduler/lib/formatters';

// Windows checkout(core.autocrlf)下源码是 CRLF;统一归一成 LF,含 \n 的多行片段断言才跨平台成立。
const readTextLf = (...args: Parameters<typeof readFileSync>): string =>
  String(readFileSync(...args)).replace(/\r\n/g, '\n');

const BASE_TIME = '2026-01-01T00:00:00.000Z';
const ATTENTION_TEST_IDS = ['auto-run', 'manual-run'];

const makeSession = (partial: Partial<Session> = {}): Session => {
  // 侧栏排序时间轴现在以 userSendAt 为主键(userSendAt ?? updatedAt;scheduler fire
  // 也会把 userSendAt bump 成本次 firedAt)。测试助手把 updatedAt / userSendAt 都对齐
  // 到同一个"活动时刻":调用者只给其一时,另一个同步取该值,让排序断言按预期时间轴运作。
  const updatedAt = partial.updatedAt ?? partial.userSendAt ?? BASE_TIME;
  return {
    id: 's1',
    userId: 'u1',
    title: 'Session',
    workingDir: '/repo',
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    permissionMode: 'ask',
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    fastMode: false,
    clearedAt: null,
    pinnedAt: null,
    // 默认对齐到派生的活动时刻(updatedAt),而非固定 BASE_TIME —— 否则只传 updatedAt
    // 的用例在 userSendAt 主键排序下会因 userSendAt 恒等而并列。显式 partial.userSendAt 优先。
    userSendAt: updatedAt,
    status: 'active',
    agentKind: 'cc',
    source: 'desktop',
    extraDirs: [],
    createdAt: BASE_TIME,
    updatedAt,
    ...partial,
    // 保证 updatedAt 最终为上面的推导结果(即使 partial 里显式带了 userSendAt
    // 但没带 updatedAt),不被 spread 覆盖回默认 BASE_TIME。
    ...(partial.updatedAt === undefined ? { updatedAt } : {}),
  };
};

const makeScheduleSessionInfo = (
  partial: Partial<AutomationScheduleSessionInfo> = {},
): AutomationScheduleSessionInfo => ({
  scheduleId: 'sched-1',
  scheduleName: 'Schedule',
  unreadRunIds: [],
  hasUnreadRun: false,
  hasUnreadFailedRun: false,
  ...partial,
});

describe('automation-generated sessions', () => {
  afterEach(() => {
    clearSessionAttentionMany(ATTENTION_TEST_IDS);
  });

  it('keeps scheduler sessions in the desktop-visible source contract', () => {
    // 所有会生成本地会话的 IM 渠道均进入 desktop sidebar。
    // (feishu 2026-07-16 起以「对话」分组回归, 见 sessionSource.ts 注释)。
    expect(DESKTOP_VISIBLE_SESSION_SOURCES).toEqual([
      'desktop',
      'feishu',
      'slack',
      'telegram',
      'x',
      'discord',
      'wechat',
      'dingtalk',
      'wecom',
      'scheduler',
      'learn',
      'shared',
      'plugin',
    ]);
    expect(DESKTOP_VISIBLE_SESSION_SOURCES).toContain('feishu');
    expect(DESKTOP_VISIBLE_SESSION_SOURCES).toContain('telegram');
    expect(DESKTOP_VISIBLE_SESSION_SOURCES).toContain('discord');
    expect(DESKTOP_VISIBLE_SESSION_SOURCES).toContain('dingtalk');
    expect(DESKTOP_VISIBLE_SESSION_SOURCES).toContain('plugin');

    expect(normalizeSessionSource('desktop')).toBe('desktop');
    expect(normalizeSessionSource('scheduler')).toBe('scheduler');
    expect(normalizeSessionSource('learn')).toBe('learn');
    expect(normalizeSessionSource('feishu')).toBe('feishu');
    expect(normalizeSessionSource('telegram')).toBe('telegram');
    expect(normalizeSessionSource('discord')).toBe('discord');
    expect(normalizeSessionSource('dingtalk')).toBe('dingtalk');
    expect(normalizeSessionSource('wecom')).toBe('wecom');
    expect(normalizeSessionSource('plugin')).toBe('plugin');
    expect(normalizeSessionSource(null)).toBe('desktop');
    expect(normalizeSessionSource('unknown')).toBe('desktop');
  });

  it('uses source=scheduler as the stable marker and keeps legacy title-prefix compatibility', () => {
    const schedulerSession = makeSession({ title: 'Daily summary', source: 'scheduler' });
    const legacySession = makeSession({ title: '[Schedule] Daily summary' });
    const normalSession = makeSession({ title: 'Daily summary', source: 'desktop' });

    expect(isScheduledSession(schedulerSession)).toBe(false);
    expect(isAutomationGeneratedSession(schedulerSession)).toBe(true);
    expect(getAutomationSessionDisplayTitle(schedulerSession)).toBe('Daily summary');

    expect(isScheduledSession(legacySession)).toBe(true);
    expect(isAutomationGeneratedSession(legacySession)).toBe(true);
    expect(getAutomationSessionDisplayTitle(legacySession)).toBe('Daily summary');

    expect(isScheduledSession(normalSession)).toBe(false);
    expect(isAutomationGeneratedSession(normalSession)).toBe(false);
    expect(getAutomationSessionDisplayTitle(normalSession)).toBe('Daily summary');
  });

  it('groups only automation-generated sessions by target directory and display title', () => {
    const groups = groupScheduledSessions(
      [
        makeSession({
          id: 'manual',
          title: 'Manual session',
          source: 'desktop',
          userSendAt: '2026-01-06T00:00:00.000Z',
        }),
        makeSession({
          id: 'daily-old',
          title: 'Daily summary',
          source: 'scheduler',
          workingDir: '/Users/alice/repo',
          userSendAt: '2026-01-02T00:00:00.000Z',
        }),
        makeSession({
          id: 'daily-new',
          title: 'Daily summary',
          source: 'scheduler',
          workingDir: '/Users/alice/repo',
          userSendAt: '2026-01-04T00:00:00.000Z',
          agentKind: 'codex',
        }),
        makeSession({
          id: 'legacy',
          title: '[Schedule] Legacy summary',
          workingDir: '/Users/alice/repo',
          userSendAt: '2026-01-03T00:00:00.000Z',
        }),
        makeSession({
          id: 'dialogue-run',
          title: 'Dialogue check',
          source: 'scheduler',
          workingDir: null,
          workspaceKind: 'dialogue',
          userSendAt: '2026-01-05T00:00:00.000Z',
        }),
      ],
      (key) => (key === 'ccAgent.schedule.unspecifiedDir' ? '未指定目录' : key),
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      workingDir: null,
      displayName: '未指定目录',
    });
    expect(groups[0].schedules.map((schedule) => schedule.scheduleName)).toEqual([
      'Dialogue check',
    ]);
    expect(groups[0].schedules[0].sessions.map((session) => session.id)).toEqual(['dialogue-run']);

    expect(groups[1]).toMatchObject({
      workingDir: '/Users/alice/repo',
      displayName: 'repo',
    });
    expect(groups[1].schedules.map((schedule) => schedule.scheduleName)).toEqual([
      'Daily summary',
      'Legacy summary',
    ]);
    expect(groups[1].schedules[0]).toMatchObject({
      agentKind: 'codex',
      latestActivityMs: Date.parse('2026-01-04T00:00:00.000Z'),
    });
    expect(groups[1].schedules[0].sessions.map((session) => session.id)).toEqual([
      'daily-new',
      'daily-old',
    ]);

    const groupedSessionIds = groups.flatMap((dirGroup) =>
      dirGroup.schedules.flatMap((schedule) => schedule.sessions.map((session) => session.id)),
    );
    expect(groupedSessionIds).not.toContain('manual');
  });

  it('keeps automation-generated sessions in ordinary sidebar project and dialogue groups', () => {
    const grouped = groupSessions([
      makeSession({
        id: 'project-manual',
        title: 'Manual project session',
        source: 'desktop',
        workingDir: '/Users/alice/repo',
        userSendAt: '2026-01-02T00:00:00.000Z',
      }),
      makeSession({
        id: 'project-auto',
        title: 'Automated project session',
        source: 'scheduler',
        workingDir: '/Users/alice/repo',
        userSendAt: '2026-01-03T00:00:00.000Z',
      }),
      makeSession({
        id: 'dialogue-auto',
        title: 'Automated dialogue session',
        source: 'scheduler',
        workspaceKind: 'dialogue',
        workingDir: null,
        userSendAt: '2026-01-04T00:00:00.000Z',
      }),
    ]);

    expect(grouped.dialogues.map((session) => session.id)).toEqual(['dialogue-auto']);
    expect(grouped.projects).toHaveLength(1);
    expect(grouped.projects[0]).toMatchObject({
      workingDir: '/Users/alice/repo',
      displayName: 'repo',
    });
    expect(grouped.projects[0].sessions.map((session) => session.id)).toEqual([
      'project-auto',
      'project-manual',
    ]);
  });

  it('keeps newly bound scheduler project sessions under their project before message count refreshes', () => {
    const grouped = groupSessions([
      makeSession({
        id: 'manual-draft',
        title: 'Manual draft',
        source: 'desktop',
        workingDir: '/Users/alice/repo',
        userSendAt: null,
        _count: { messages: 0 },
      }),
      makeSession({
        id: 'scheduler-bound',
        title: '[Schedule] GitHub 巡检',
        source: 'scheduler',
        workingDir: '/Users/alice/repo',
        userSendAt: null,
        _count: { messages: 0 },
      }),
    ]);

    expect(grouped.unclassified.map((session) => session.id)).toEqual(['manual-draft']);
    expect(grouped.projects).toHaveLength(1);
    expect(grouped.projects[0]).toMatchObject({
      workingDir: '/Users/alice/repo',
      displayName: 'repo',
    });
    expect(grouped.projects[0].sessions.map((session) => session.id)).toEqual(['scheduler-bound']);
  });

  it('keeps a single automation-generated session as an ordinary sidebar row', () => {
    const session = makeSession({
      id: 'single-auto-run',
      title: 'Daily summary',
      source: 'scheduler',
    });

    const entries = groupAutomationSidebarEntries([session], {
      notifications: new Set(),
    });

    expect(entries).toEqual([{ kind: 'session', session }]);
  });

  it('groups multiple sessions from the same automation task into one sidebar entry', () => {
    const scheduleIndex = new Map<string, AutomationScheduleSessionInfo>([
      [
        'jira-1',
        makeScheduleSessionInfo({
          scheduleId: 'sched-jira',
          scheduleName: 'Jira 自动修复',
          scheduleStatus: 'active',
          scheduleSource: 'user',
          nextFireAt: 1_767_225_600_000,
          unreadRunIds: ['run-jira-1'],
          hasUnreadRun: true,
        }),
      ],
      [
        'jira-2',
        makeScheduleSessionInfo({
          scheduleId: 'sched-jira',
          scheduleName: 'Jira 自动修复',
          scheduleStatus: 'active',
          scheduleSource: 'user',
          nextFireAt: 1_767_225_600_000,
          unreadRunIds: [],
          hasUnreadRun: false,
        }),
      ],
      [
        'daily-1',
        makeScheduleSessionInfo({
          scheduleId: 'sched-daily',
          scheduleName: 'Daily summary',
          scheduleStatus: 'paused',
          scheduleSource: 'project',
          nextFireAt: 1_767_312_000_000,
          workingDir: '/repo',
          projectConfigId: 'daily-config',
          unreadRunIds: [],
          hasUnreadRun: false,
        }),
      ],
    ]);
    const sessions = [
      makeSession({
        id: 'manual',
        title: 'Manual session',
        source: 'desktop',
        userSendAt: '2026-01-05T00:00:00.000Z',
      }),
      makeSession({
        id: 'jira-2',
        title: 'BUG-2',
        source: 'scheduler',
        userSendAt: '2026-01-04T00:00:00.000Z',
      }),
      makeSession({
        id: 'jira-1',
        title: 'BUG-1',
        source: 'scheduler',
        userSendAt: '2026-01-03T00:00:00.000Z',
      }),
      makeSession({
        id: 'daily-1',
        title: 'Daily summary',
        source: 'scheduler',
        userSendAt: '2026-01-02T00:00:00.000Z',
      }),
    ];

    const entries = groupAutomationSidebarEntries(sessions, {
      notifications: new Set(['jira-1']),
      scheduleSessionIndex: scheduleIndex,
    });

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ kind: 'session' });
    expect(entries[1]).toMatchObject({
      kind: 'automation-group',
      group: {
        id: 'schedule:sched-jira',
        scheduleId: 'sched-jira',
        scheduleStatus: 'active',
        scheduleSource: 'user',
        nextFireAt: 1_767_225_600_000,
        title: 'Jira 自动修复',
        attentionSessionIds: ['jira-1'],
      },
    });
    if (entries[1].kind !== 'automation-group') throw new Error('expected automation group');
    expect(entries[1].group.sessions.map((session) => session.id)).toEqual(['jira-2', 'jira-1']);
    expect(entries[2]).toEqual({ kind: 'session', session: sessions[3] });
  });

  it('shows every recent run as its own row when expanded (primary not hidden into header)', () => {
    const group = {
      id: 'schedule:sched-jira',
      title: 'Jira 自动修复',
      sessions: [
        makeSession({ id: 'jira-2', title: 'BUG-2', source: 'scheduler' }),
        makeSession({ id: 'jira-1', title: 'BUG-1', source: 'scheduler' }),
      ],
      attentionSessionIds: ['jira-1'],
    };

    // 展开态:全部运行(含被组头代表的最新未读 jira-1)都各自成行,前 5 条内全显示。
    expect(
      getVisibleAutomationGroupSessions(group, {
        notifications: new Set(['jira-1']),
        showAll: false,
      }).map((session) => session.id),
    ).toEqual(['jira-2', 'jira-1']);
    // 组头点击目标仍是 primary(最新未读),与它的列表行是两个入口指向同一 session。
    expect(getAutomationGroupPrimarySession(group, new Set(['jira-1']))?.id).toBe('jira-1');
  });

  it('picks the most recently active run as the collapsed group latest session', () => {
    const group = {
      id: 'schedule:sched-jira',
      title: 'Jira 自动修复',
      sessions: [
        makeSession({
          id: 'jira-old',
          title: 'BUG-old',
          source: 'scheduler',
          updatedAt: '2026-07-01T00:00:00.000Z',
        }),
        makeSession({
          id: 'jira-new',
          title: 'BUG-new',
          source: 'scheduler',
          updatedAt: '2026-07-08T00:00:00.000Z',
        }),
        makeSession({
          id: 'jira-mid',
          title: 'BUG-mid',
          source: 'scheduler',
          updatedAt: '2026-07-05T00:00:00.000Z',
        }),
      ],
      attentionSessionIds: [],
    };
    // 组头代表「最新一条」运行:严格按活动时间取,不受列表顺序 / running / attention 影响。
    expect(getAutomationGroupLatestSession(group)?.id).toBe('jira-new');
  });

  it('uses a running automation session as the collapsed group primary before attention arrives', () => {
    const group = {
      id: 'schedule:sched-jira',
      title: 'Jira 自动修复',
      sessions: [
        makeSession({ id: 'jira-3', title: 'BUG-3', source: 'scheduler' }),
        makeSession({ id: 'jira-2', title: 'BUG-2', source: 'scheduler' }),
        makeSession({ id: 'jira-1', title: 'BUG-1', source: 'scheduler' }),
      ],
      attentionSessionIds: ['jira-1'],
    };

    expect(
      getAutomationGroupPrimarySession(group, new Set(), {
        runningSessionIds: new Set(['jira-2']),
      })?.id,
    ).toBe('jira-2');
    expect(
      getAutomationGroupPrimarySession(group, new Set(['jira-1']), {
        runningSessionIds: new Set(['jira-2']),
        preferredSessionId: 'jira-3',
      })?.id,
    ).toBe('jira-2');
    // primary = 运行中的 jira-2(组头点击目标);展开态里三条都各自成行。
    expect(
      getVisibleAutomationGroupSessions(group, {
        notifications: new Set(['jira-2', 'jira-1']),
        runningSessionIds: new Set(['jira-2']),
        showAll: false,
      }).map((session) => session.id),
    ).toEqual(['jira-3', 'jira-2', 'jira-1']);
  });

  it('keeps schedule run unread semantics shared with the run history badge', () => {
    expect(isUnreadScheduleRun({ status: 'success', readAt: undefined })).toBe(true);
    expect(isUnreadScheduleRun({ status: 'failed', readAt: undefined })).toBe(true);
    expect(isUnreadScheduleRun({ status: 'running', readAt: undefined })).toBe(false);
    expect(isUnreadScheduleRun({ status: 'success', readAt: 1 })).toBe(false);
  });

  it('maps a focused schedule to the status bucket that can reveal it', () => {
    const schedules = [
      { id: 'active-schedule', status: 'active' },
      { id: 'expired-schedule', status: 'expired' },
      { id: 'paused-schedule', status: 'paused' },
    ] as const;

    expect(getFocusedScheduleStatusFilter(schedules, 'active-schedule')).toBe('active');
    expect(getFocusedScheduleStatusFilter(schedules, 'expired-schedule')).toBe('active');
    expect(getFocusedScheduleStatusFilter(schedules, 'paused-schedule')).toBe('paused');
    expect(getFocusedScheduleStatusFilter(schedules, 'missing')).toBeNull();
    expect(getFocusedScheduleStatusFilter(schedules, null)).toBeNull();
  });

  it('shows all recent runs as rows in the default expanded view, consistent with show-all', () => {
    const group = {
      id: 'schedule:sched-jira',
      title: 'Jira 自动修复',
      sessions: [
        makeSession({ id: 'jira-3', title: 'BUG-3', source: 'scheduler' }),
        makeSession({ id: 'jira-2', title: 'BUG-2', source: 'scheduler' }),
        makeSession({ id: 'jira-1', title: 'BUG-1', source: 'scheduler' }),
      ],
      attentionSessionIds: ['jira-1'],
    };

    // 默认展开态:全部运行各自成行(≤5 条全显示),含被组头代表的那条。
    expect(
      getVisibleAutomationGroupSessions(group, {
        notifications: new Set(['jira-1']),
        showAll: false,
      }).map((session) => session.id),
    ).toEqual(['jira-3', 'jira-2', 'jira-1']);

    expect(
      getVisibleAutomationGroupSessions(group, {
        notifications: new Set(['jira-2', 'jira-1']),
        showAll: false,
      }).map((session) => session.id),
    ).toEqual(['jira-3', 'jira-2', 'jira-1']);
    expect(getAutomationGroupPrimarySession(group, new Set(['jira-2', 'jira-1']))?.id).toBe(
      'jira-2',
    );

    // 「显示全部」与默认展开态一致(都是全量)。
    expect(
      getVisibleAutomationGroupSessions(group, {
        notifications: new Set(['jira-1']),
        showAll: true,
      }).map((session) => session.id),
    ).toEqual(['jira-3', 'jira-2', 'jira-1']);
  });

  it('caps collapsed automation children at five and overflows the rest like the dialogue list', () => {
    const sessions = Array.from({ length: 7 }, (_, index) =>
      makeSession({ id: `run-${index}`, title: `RUN-${index}`, source: 'scheduler' }),
    );
    const group = { id: 'schedule:sched-cap', title: 'Cap', sessions, attentionSessionIds: [] };

    // 全部 7 条参与折叠,默认显示前 5 条(run-0..run-4),剩 run-5 / run-6 折叠。
    const view = getAutomationGroupChildView(group, {
      notifications: new Set(),
      showAll: false,
    });
    expect(view.visibleSessions.map((session) => session.id)).toEqual([
      'run-0',
      'run-1',
      'run-2',
      'run-3',
      'run-4',
    ]);
    expect(view.isOverflowing).toBe(true);
    expect(view.hiddenCount).toBe(2);
    expect(view.totalCount).toBe(7);
  });

  it('keeps unread automation runs visible past the collapse cap', () => {
    const sessions = Array.from({ length: 8 }, (_, index) =>
      makeSession({ id: `run-${index}`, title: `RUN-${index}`, source: 'scheduler' }),
    );
    const group = {
      id: 'schedule:sched-unread',
      title: 'Unread',
      sessions,
      attentionSessionIds: ['run-1', 'run-7'],
    };

    // 前 5 条 = run-0..run-4;run-7 在折叠区但未读 → 豁免保留;run-5 / run-6 已读且在折叠区 → 折叠。
    const view = getAutomationGroupChildView(group, {
      notifications: new Set(['run-1', 'run-7']),
      showAll: false,
    });
    expect(view.visibleSessions.map((session) => session.id)).toContain('run-7');
    expect(view.visibleSessions.map((session) => session.id)).not.toContain('run-6');
    expect(view.isOverflowing).toBe(true);
  });

  it('exempts automation runs active within the last 24h from the collapse cap', () => {
    const now = Date.parse('2026-01-10T12:00:00.000Z');
    const recentIso = new Date(now - 60 * 60 * 1000).toISOString();
    const staleIso = new Date(now - 48 * 60 * 60 * 1000).toISOString();
    const group = {
      id: 'schedule:sched-recent',
      title: 'Recent',
      sessions: [
        makeSession({ id: 'primary', source: 'scheduler', userSendAt: recentIso }),
        makeSession({ id: 'stale', source: 'scheduler', userSendAt: staleIso }),
        makeSession({ id: 'recent', source: 'scheduler', userSendAt: recentIso }),
      ],
      attentionSessionIds: [],
    };

    // minVisibleCount=1:全部 3 条参与,硬性只保留前 1 条(primary);传 now 时 recent 因 24h
    // 内有活动而豁免保留,stale(48h)被折叠;不传 now(关闭 24h 豁免)则 recent 也被折叠。
    const withNow = getAutomationGroupChildView(group, {
      notifications: new Set(),
      showAll: false,
      minVisibleCount: 1,
      nowMs: now,
    });
    expect(withNow.visibleSessions.map((session) => session.id)).toEqual(['primary', 'recent']);

    const withoutNow = getAutomationGroupChildView(group, {
      notifications: new Set(),
      showAll: false,
      minVisibleCount: 1,
    });
    expect(withoutNow.visibleSessions.map((session) => session.id)).toEqual(['primary']);
    expect(withoutNow.isOverflowing).toBe(true);
  });

  it('retains a clicked auto-exposed child during route transition and while active', () => {
    const group = {
      id: 'schedule:sched-jira',
      title: 'Jira 自动修复',
      sessions: [
        makeSession({ id: 'jira-3', title: 'BUG-3', source: 'scheduler' }),
        makeSession({ id: 'jira-2', title: 'BUG-2', source: 'scheduler' }),
        makeSession({ id: 'jira-1', title: 'BUG-1', source: 'scheduler' }),
      ],
      attentionSessionIds: ['jira-2', 'jira-1'],
    };

    expect(
      getVisibleAutomationGroupSessions(group, {
        notifications: new Set(['jira-2']),
        showAll: false,
        activeSessionId: 'manual',
        frozenVisibleSessionIds: ['jira-1'],
      }).map((session) => session.id),
    ).toEqual(['jira-1']);
    expect(
      getAutomationGroupPrimarySession(group, new Set(['jira-2']), {
        preferredSessionId: 'jira-2',
      })?.id,
    ).toBe('jira-2');

    expect(
      getVisibleAutomationGroupSessions(group, {
        notifications: new Set(['jira-2']),
        showAll: false,
        activeSessionId: 'jira-1',
        frozenVisibleSessionIds: ['jira-1'],
      }).map((session) => session.id),
    ).toEqual(['jira-1']);
  });

  it('freezes the group primary while the clicked automation session is active', () => {
    const group = {
      id: 'schedule:sched-jira',
      title: 'Jira 自动修复',
      sessions: [
        makeSession({ id: 'jira-3', title: 'BUG-3', source: 'scheduler' }),
        makeSession({ id: 'jira-2', title: 'BUG-2', source: 'scheduler' }),
        makeSession({ id: 'jira-1', title: 'BUG-1', source: 'scheduler' }),
      ],
      attentionSessionIds: ['jira-3', 'jira-2', 'jira-1'],
    };

    expect(getAutomationGroupPrimarySession(group, new Set(['jira-2', 'jira-1']))?.id).toBe(
      'jira-2',
    );
    expect(
      getAutomationGroupPrimarySession(group, new Set(['jira-2', 'jira-1']), {
        preferredSessionId: 'jira-3',
      })?.id,
    ).toBe('jira-3');
    expect(
      getVisibleAutomationGroupSessions(group, {
        notifications: new Set(['jira-2', 'jira-1']),
        showAll: false,
        activeSessionId: 'jira-3',
        frozenVisibleSessionIds: ['jira-2', 'jira-1'],
      }).map((session) => session.id),
    ).toEqual(['jira-2', 'jira-1']);
  });

  it('keeps the automation group title click separate from the disclosure toggle', () => {
    const source = readTextLf(
      new URL('../features/cc-agent/sidebar/AutomationSessionGroupItem.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('setFrozen(null)');
    // 轴 1:箭头切换的是持久化 disclosure(useAutomationGroupCollapsed),不是「显示全部」。
    expect(source).toContain('useAutomationGroupCollapsed(group.id)');
    expect(source).toContain('toggleCollapsed()');
    expect(source).toContain('const ToggleIcon = collapsed ? ChevronRight : ChevronDown');
    expect(source).toContain('aria-expanded={!collapsed}');
    // 轴 1 收起时藏掉全部子运行(只留组头)。
    expect(source).toContain('const visibleSessions = collapsed ? [] : childView.visibleSessions');
    expect(source).toContain('const hasVisibleChildren = visibleSessions.length > 0');
    expect(source).toContain('{hasVisibleChildren && (');
    // 侧栏侧保留「立即运行」直点,低频的编辑 / 暂停恢复 / 删除收回 More 菜单。
    expect(source).toContain("onScheduleAction(group, 'run')");
    expect(source).toContain("onScheduleAction(group, 'edit')");
    expect(source).toContain("onScheduleAction(group, 'toggle-pause')");
    expect(source).toContain("onScheduleAction(group, 'delete')");
    expect(source).toContain('EllipsisVertical');
    expect(source).toContain('setMenuOpen');
    expect(source).not.toContain('handleGroupContextMenu');
    // Run / More 图标(lucide Play / EllipsisVertical)必须都在,按钮尺寸与普通会话行对齐。
    expect(source).toMatch(/<Play size=\{14\}/);
    expect(source).toMatch(/<EllipsisVertical size=\{14\}/);
    expect(source).toContain('ccAgent.sidebar.automationGroup.menu.runNow');
    expect(source).toContain('ccAgent.sidebar.automationGroup.menu.more');
    expect(source).toContain('ccAgent.sidebar.automationGroup.menu.edit');
    expect(source).toContain('ccAgent.sidebar.automationGroup.menu.pause');
    expect(source).toContain('ccAgent.sidebar.automationGroup.menu.resume');
    expect(source).toContain('ccAgent.sidebar.automationGroup.menu.delete');
    expect(source).toContain('scheduleFocusPath(group.scheduleId)');
    // 组头点击打开组内「最新一条」运行(需求:点折叠组头打开最新 session),不再走 primary。
    expect(source).toContain('onSessionClick(latestSession.id)');
    expect(source).toContain('getAutomationGroupLatestSession(group)');
    expect(source).toContain('visibleSessionIds: visibleSessions.map((session) => session.id)');
    expect(source).toContain('originActiveSessionId: activeSessionId ?? null');
    expect(source).toContain('hasBeenActive: false');
    expect(source).toContain('hasBeenActive: true');
    expect(source).toContain('formatSidebarTime(primaryActivityIso, t)');
    expect(source).toContain('setCountdownNowMs(Date.now())');
    expect(source).toContain('window.setInterval');
    // 下次运行倒计时不再进 meta,而是作为整行 hover tooltip 的内容。
    expect(source).toContain(
      'formatSidebarFutureTime(group.nextFireAt, t, new Date(countdownNowMs))',
    );
    // rowTooltip 现在同时展示「下次运行倒计时 + 累计运行次数」;countdownText 来自
    // shouldTickCountdown 分支,runCountText 走既有 runCount i18n。
    expect(source).toContain('const countdownText = shouldTickCountdown');
    expect(source).toContain(
      "t('ccAgent.sidebar.automationGroup.runCount', { count: group.sessions.length })",
    );
    expect(source).toContain('text={rowTooltip}');
    expect(source).toContain('side="right"');
    // 点击行空白 = 点击标题:共享 openPrimarySession,行 div 挂 onClick,内部 chevron /
    // Run / More 各自 stopPropagation 不误触发。ARIA 上不给 div 加 role=button(会与
    // 内嵌 <button> 冲突),键盘可达性由内部标题 <button> 保留;因此不断言 role/tabIndex/
    // onKeyDown 存在,反过来要保证它们不出现在行 div 上。
    expect(source).toContain('const openLatestSession =');
    expect(source).toContain('onClick={openLatestSession}');
    expect(source).not.toMatch(/role=\{latestSession \? 'button'/);
    expect(source).toContain("group.scheduleStatus === 'active'");
    expect(source).toContain(
      "scheduleId && !menuOpen && 'group-hover:opacity-0 group-focus-within/slot:opacity-0'",
    );
    expect(source).toContain("menuOpen && 'opacity-0'");
    expect(source).toContain('disabled={!latestSession}');
    // 自动任务组头首图标必须复用普通 SessionItem 的 15px 槽与 vendor 尺寸规则，
    // 否则裸 VendorIcon 会比其它会话向左偏约 1.5px，Claude mark 还会小 1px。
    // vendor 经 agentKindToVendor 归一(pi 会话显示 π,而非 Claude 脸);尺寸规则:cc=13,其余(codex/pi)=12。
    expect(source).toContain('className="flex w-[15px] shrink-0 items-center justify-center"');
    expect(source).toContain('vendor={agentKindToVendor(latestSession?.agentKind)}');
    expect(source).toContain("size={agentKindToVendor(latestSession?.agentKind) === 'cc' ? 13 : 12}");
    // 所有自动任务统一 Timer；暂停只叠角标，主图标和 12px 槽位不替换。
    expect(source).toContain('<AutomationTimerIcon');
    expect(source).toContain('paused={isScheduleStopped}');
    expect(source).not.toContain('<Clock');
    expect(source).not.toContain('<Pause');
    // 沿用原 Clock 的紧凑节奏：vendor → Timer、Timer → 标题均为 6px。
    expect(source).toContain(
      'className="flex min-w-0 items-center gap-1.5 text-left disabled:cursor-default"',
    );
    expect(source).toContain('className="flex min-w-0 items-center gap-1.5"');
    expect(source).toContain('runningSessionIds,');
  });

  it('auto-collapses an expanded automation group once focus leaves it and offers show-all', () => {
    const source = readTextLf(
      new URL('../features/cc-agent/sidebar/AutomationSessionGroupItem.tsx', import.meta.url),
      'utf8',
    );

    // 展开锚点:展开瞬间记当时 active,落到组内算锚定,锚定过再离开组 → setShowAll(false)。
    expect(source).toContain('expandAnchorRef');
    expect(source).toContain('hasFocusedGroup');
    expect(source).toContain('originActiveSessionId: activeSessionId ?? null');
    expect(source).toContain('setShowAll(false)');
    // 「显示全部 N 个」复用普通对话同款文案 key,溢出时才出现。
    expect(source).toContain('childView.isOverflowing');
    expect(source).toContain(
      "t('ccAgent.sidebar.showAllSessions', { count: childView.totalCount })",
    );
  });

  it('refreshes the shared session store when a schedule binds a newly created session', () => {
    const source = readTextLf(new URL('../lib/sessionsStore.ts', import.meta.url), 'utf8');

    expect(source).toContain('maker?.schedule');
    expect(source).toContain("event.type === 'session-bound'");
    expect(source).toContain('sessionsStore.forceRefreshAll()');
  });

  it('backfills scheduler session metadata before broadcasting session-bound refreshes', () => {
    const source = readTextLf(
      new URL('../../main/scheduler-host/runner.ts', import.meta.url),
      'utf8',
    );

    const fireStart = source.indexOf(
      'async fire(schedule: Schedule, ctx: FireContext): Promise<FireResult> {',
    );
    const turnListenerStart = source.indexOf('let assistantText =', fireStart);
    expect(fireStart).toBeGreaterThanOrEqual(0);
    expect(turnListenerStart).toBeGreaterThan(fireStart);

    const fireSetupSource = source
      .slice(fireStart, turnListenerStart)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const backfillMatches = [...fireSetupSource.matchAll(/\bawait\s+backfillSessionMeta\s*\(/g)];
    const sessionBoundMatches = [
      ...fireSetupSource.matchAll(/\bawait\s+ctx\.onSessionBound\?\.\(session\.id\)/g),
    ];

    expect(backfillMatches).toHaveLength(1);
    expect(sessionBoundMatches).toHaveLength(1);
    expect(backfillMatches[0].index).toBeLessThan(sessionBoundMatches[0].index);
  });

  it('does not clear automation conversation attention just by browsing schedules', () => {
    const schedulerPageSource = readTextLf(
      new URL('../features/scheduler/SchedulerPage.tsx', import.meta.url),
      'utf8',
    );
    const taskListPaneSource = readTextLf(
      new URL('../features/scheduler/components/TaskListPane.tsx', import.meta.url),
      'utf8',
    );
    const taskListCellSource = readTextLf(
      new URL('../features/scheduler/components/TaskListCell.tsx', import.meta.url),
      'utf8',
    );
    const runHistoryCardSource = readTextLf(
      new URL('../features/scheduler/components/RunHistoryCard.tsx', import.meta.url),
      'utf8',
    );
    expect(schedulerPageSource).toContain('useScheduleUnreadRunCounts(sorted)');
    expect(taskListPaneSource).toContain('unreadRunCounts.get(s.id) ?? 0');
    expect(taskListCellSource).toContain('<AttentionDot');
    expect(schedulerPageSource).not.toContain('markScheduleRunsRead(selectedId)');
    // 标已读走 …AndSync 包装(IPC settle 后无条件本地刷新,main no-op 不广播时红点也能自愈)
    expect(runHistoryCardSource).toContain('markScheduleRunReadAndSync(run.id)');
  });

  it('uses the sidebar run index instead of a fixed per-schedule history limit', () => {
    const scheduleIndexHookSource = readTextLf(
      new URL('../features/cc-agent/hooks/useAutomationScheduleSessionIndex.ts', import.meta.url),
      'utf8',
    );
    const unreadCountsHookSource = readTextLf(
      new URL('../features/scheduler/hooks/useScheduleUnreadRunCounts.ts', import.meta.url),
      'utf8',
    );
    const storageSource = readTextLf(
      new URL('../../main/scheduler-host/storage.ts', import.meta.url),
      'utf8',
    );
    const preloadSource = readTextLf(new URL('../../preload/preload.ts', import.meta.url), 'utf8');

    // 这个 hook 取 snapshot 变体:除了 run 列表还要引擎的 in-flight 集合,用于通知抑制
    // 标记的对账(见 scheduleSidebarIndexRuns 与 scheduler.listInflightRunIds)。两者是
    // 同一条 sidebar index IPC,本用例要锁的「不走 per-schedule history limit」不变。
    expect(scheduleIndexHookSource).toContain('loadScheduleSidebarIndexSnapshot()');
    expect(scheduleIndexHookSource).not.toContain('RUNS_PER_SCHEDULE_LIMIT');
    expect(scheduleIndexHookSource).not.toContain('listRuns(');
    expect(unreadCountsHookSource).toContain('loadScheduleSidebarIndexRuns()');
    expect(unreadCountsHookSource).not.toContain('RUNS_PER_SCHEDULE_LIMIT');
    expect(unreadCountsHookSource).not.toContain('listRuns(');
    expect(storageSource).toContain('listSidebarIndexRuns');
    expect(storageSource).toContain('isNotNull(scheduleRuns.sessionId)');
    expect(storageSource).toContain('UNREAD_TERMINAL_RUN_STATUSES');
    expect(storageSource).toContain('nextFireAt: schedules.nextFireAt');
    expect(storageSource).toContain('listSchedulesByLegacyKey(db)');
    expect(storageSource).toContain('legacyScheduleNameFromSessionTitle(session.title)');
    expect(storageSource).toContain('runId: `${LEGACY_SESSION_RUN_ID_PREFIX}${session.id}`');
    expect(storageSource).toContain('readAt: session.updatedAt');
    expect(storageSource).toContain('linkedLegacyRows');
    expect(storageSource).toContain('scheduleByLegacyKey.set(key');
    expect(storageSource).toContain('legacyTitleWhere()');
    expect(storageSource).toContain("eq(sessions.source, 'scheduler')");
    expect(storageSource).toContain('listDirectScheduleIdsByLegacyKey');
    expect(storageSource).toContain('directScheduleId && directScheduleId !== row.id');
    expect(scheduleIndexHookSource).toContain('nextFireAt: run.nextFireAt');
    expect(preloadSource).toContain('listSidebarIndexRuns');
  });

  it('surfaces total automation task cost from deduped schedule sessions', () => {
    const storageSource = readTextLf(
      new URL('../../main/scheduler-host/storage.ts', import.meta.url),
      'utf8',
    );
    const schedulePageSource = readTextLf(
      new URL('../features/scheduler/SchedulerPage.tsx', import.meta.url),
      'utf8',
    );
    const taskListPaneSource = readTextLf(
      new URL('../features/scheduler/components/TaskListPane.tsx', import.meta.url),
      'utf8',
    );
    const taskListCellSource = readTextLf(
      new URL('../features/scheduler/components/TaskListCell.tsx', import.meta.url),
      'utf8',
    );
    const runHistoryCardSource = readTextLf(
      new URL('../features/scheduler/components/RunHistoryCard.tsx', import.meta.url),
      'utf8',
    );
    const runHistoryPaneSource = readTextLf(
      new URL('../features/scheduler/components/RunHistoryPane.tsx', import.meta.url),
      'utf8',
    );
    const hookSource = readTextLf(
      new URL('../features/scheduler/hooks/useScheduleCostSummaries.ts', import.meta.url),
      'utf8',
    );
    const preloadSource = readTextLf(new URL('../../preload/preload.ts', import.meta.url), 'utf8');
    const zh = JSON.parse(
      readTextLf(new URL('../i18n/locales/zh-CN/common.json', import.meta.url), 'utf8'),
    );

    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.001)).toBe('<$0.01');
    expect(formatUsd(1.234)).toBe('$1.23');
    expect(storageSource).toContain('listCostSummaries');
    expect(storageSource).toContain('messages.agentMeta');
    expect(storageSource).toContain('scheduleOriginFromAgentMeta');
    expect(storageSource).toContain("origin?.kind !== 'scheduler'");
    expect(storageSource).toContain('turnCostFromAgentMeta');
    expect(storageSource).toContain('turnCostIsEstimate === true');
    expect(storageSource).toContain('SQLITE_IN_CHUNK_SIZE');
    expect(storageSource).toContain("when 'user' then 0 else 1 end");
    expect(storageSource).toContain('entry.costValues.push(turnCost.costMoney)');
    expect(storageSource).toContain(
      'addCompatibleRegionalMoney(summary.costValues, summary.latestCurrency)',
    );
    expect(storageSource).toContain('totalMoney');
    expect(storageSource).toContain('listLegacySessionRuns');
    expect(storageSource).toContain("LEGACY_SCHEDULE_TITLE_PREFIX = '[Schedule] '");
    expect(storageSource).toContain("LEGACY_SESSION_RUN_ID_PREFIX = 'legacy-session:'");
    expect(storageSource).toContain('legacyScheduleNameFromSessionTitle(session.title)');
    expect(storageSource).toContain('listLegacyAliasesForSchedule');
    expect(storageSource).toContain('inArray(sessions.title, titles)');
    expect(storageSource).toContain('legacyAliases.has(');
    expect(storageSource).toContain('directScheduleId && directScheduleId !== schedule.id');
    expect(preloadSource).toContain('listCostSummaries');
    expect(hookSource).toContain('onUsageSessionSpendChanged');
    expect(hookSource).toContain('onUsageMessageTurnCost');
    expect(hookSource).toContain('maker.schedule.listCostSummaries()');
    expect(schedulePageSource).toContain('useScheduleCostSummaries(sorted)');
    expect(taskListPaneSource).toContain('costSummariesLoaded');
    expect(taskListCellSource).toContain('scheduler.cell.totalCost');
    expect(taskListCellSource).toContain('formatTurnCostMoney(totalMoney)');
    expect(runHistoryPaneSource).toContain('groupRunsForHistory');
    expect(runHistoryPaneSource).toContain('PERSISTENT_SESSION_PREVIEW_LIMIT = 3');
    expect(runHistoryPaneSource).toContain('expandRemainingRuns');
    expect(runHistoryPaneSource).not.toContain('sessionCostMap');
    expect(runHistoryCardSource).toContain('isLegacySessionRun');
    expect(runHistoryCardSource).toContain("!isLegacySessionRun && run.status !== 'running'");
    expect(runHistoryCardSource).toContain('scheduler.runs.runCost');
    expect(runHistoryCardSource).toContain("run.costAttribution === 'legacy'");
    expect(zh.scheduler.cell.totalCost).toBe('开销 {{cost}}');
    expect(zh.scheduler.cell.totalValue).toBe('价值 {{value}}');
    expect(zh.scheduler.runs.sessionCost).toBe('任务开销 {{cost}}');
    expect(zh.scheduler.runs.sessionValue).toBe('任务价值 {{value}}');
    expect(zh.scheduler.runs.runCost).toBe('本次开销 {{cost}}');
    expect(zh.scheduler.runs.legacyCostUnavailable).toBe('历史费用无法拆分');
    expect(zh.scheduler.runs.persistentSessionGroup).toBe(
      '持续任务 {{session}} · {{count}} 次运行',
    );
    expect(zh.scheduler.runs.expandRemainingRuns).toBe('展开另外 {{count}} 次');
  });

  it('routes automation group menu actions through the scheduler APIs', () => {
    const sidebarSource = readTextLf(
      new URL('../features/cc-agent/CCAgentSidebarUpper.tsx', import.meta.url),
      'utf8',
    );
    const schedulerPageSource = readTextLf(
      new URL('../features/scheduler/SchedulerPage.tsx', import.meta.url),
      'utf8',
    );

    expect(sidebarSource).toContain('/cc-agent/scheduled?focus=');
    expect(sidebarSource).toContain('&edit=');
    expect(sidebarSource).toContain('encodeURIComponent(scheduleId)');
    expect(sidebarSource).toContain('maker.schedule.runNow(scheduleId)');
    expect(sidebarSource).toContain('maker.schedule.pause(scheduleId)');
    expect(sidebarSource).toContain('maker.schedule.resume(scheduleId)');
    expect(sidebarSource).toContain('useDeleteScheduleWithSessions');
    expect(sidebarSource).toContain('requestDeleteSchedule({');
    expect(sidebarSource).toContain('knownSessionIds: group.sessions.map((session) => session.id)');
    expect(schedulerPageSource).toContain('getFocusedScheduleStatusFilter(schedules, focusId)');
    expect(schedulerPageSource).toContain('setEditing(focused)');
    expect(schedulerPageSource).toContain('setFormOpen(true)');
    expect(schedulerPageSource).toContain('requestDeleteSchedule({');
  });

  it('requires a generated-conversation disposition before deleting an automation schedule', () => {
    const deleteHookSource = readTextLf(
      new URL('../features/scheduler/hooks/useDeleteScheduleWithSessions.tsx', import.meta.url),
      'utf8',
    );

    expect(deleteHookSource).toContain(
      "export type ScheduleGeneratedSessionDisposition = 'keep' | 'archive' | 'delete'",
    );
    expect(deleteHookSource).toContain('window.electronAPI.maker.schedule.listRuns(');
    expect(deleteHookSource).toContain('RUNS_PER_DELETE_PREVIEW_LIMIT');
    expect(deleteHookSource).toContain('target.knownSessionIds ?? []');
    expect(deleteHookSource).toContain('window.electronAPI.maker.projectAutomation.removeSchedule');
    expect(deleteHookSource).toContain('window.electronAPI.maker.schedule.delete(target.id)');
    expect(deleteHookSource).toContain("if (disposition === 'keep') return []");
    expect(deleteHookSource).toContain(
      "sessionService.update(sessionId, { status: 'archived', pinnedAt: null })",
    );
    expect(deleteHookSource).toContain("sessionService.update(sessionId, { status: 'deleted' })");
    expect(deleteHookSource).toContain('window.electronAPI.cleanupSessionImages(sessionId)');
    expect(deleteHookSource).toContain('makerChatStore.closeSessionQuery(sessionId)');
    expect(deleteHookSource).toContain('clearComposerDraft(sessionId)');
    expect(deleteHookSource).toContain('scheduler.deleteDialog.option.keep.title');
    expect(deleteHookSource).toContain('scheduler.deleteDialog.option.archive.title');
    expect(deleteHookSource).toContain('scheduler.deleteDialog.option.delete.title');
    expect(deleteHookSource).not.toContain('AlertDialog.Action asChild');
  });

  it('tracks attention by ordinary session id without a separate automation badge store', () => {
    addSessionAttention('auto-run');
    addSessionAttention('manual-run');

    expect(hasSessionAttention('auto-run')).toBe(true);
    expect(hasSessionAttention('manual-run')).toBe(true);
    expect([...getSessionAttentionSnapshot()].sort()).toEqual(['auto-run', 'manual-run']);

    expect(clearSessionAttentionMany(['auto-run'])).toBe(1);
    expect(hasSessionAttention('auto-run')).toBe(false);
    expect(hasSessionAttention('manual-run')).toBe(true);
  });
});
