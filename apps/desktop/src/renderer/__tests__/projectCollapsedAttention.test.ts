import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AttentionKind } from '@/lib/sessionAttentionStore';
import type { RemoteSessionActivityPhase } from '@/features/device-link/remoteSessionActivityStore';
import type { SessionRightStatus } from '@cindy/maker-shared/session-activity';
import {
  resolveCollapsedAttention,
  resolveCollapsedAutomationGroupState,
  resolveCollapsedGroupHeaderSessionId,
  resolveCollapsedGroupRightStatus,
  resolveCollapsedProjectAttentionTone,
} from '../features/cc-agent/sidebar/projectCollapsedAttention';

const sidebarDir = resolvePath(__dirname, '..', 'features', 'cc-agent', 'sidebar');
const projectNodeSource = readFileSync(
  resolvePath(sidebarDir, 'sections', 'ProjectNode.tsx'),
  'utf8',
);
const projectsSectionSource = readFileSync(
  resolvePath(sidebarDir, 'sections', 'ProjectsSection.tsx'),
  'utf8',
);
const sidebarUpperSource = readFileSync(
  resolvePath(__dirname, '..', 'features', 'cc-agent', 'CCAgentSidebarUpper.tsx'),
  'utf8',
);
const sessionItemSource = readFileSync(resolvePath(sidebarDir, 'SessionItem.tsx'), 'utf8');
const automationGroupSource = readFileSync(
  resolvePath(sidebarDir, 'AutomationSessionGroupItem.tsx'),
  'utf8',
);

const sessions = (ids: string[]) => ids.map((id) => ({ id }));

interface ResolveOptions {
  ids?: string[];
  running?: string[];
  notifications?: string[];
  attentionKinds?: [string, AttentionKind][];
  urgent?: string[];
  remotePhases?: [string, RemoteSessionActivityPhase][];
  localPhases?: [string, RemoteSessionActivityPhase][];
  remoteIds?: string[];
}

function inputFor({
  ids = ['session-1'],
  running = [],
  notifications = [],
  attentionKinds = [],
  urgent = [],
  remotePhases = [],
  localPhases = [],
  remoteIds = [],
}: ResolveOptions = {}) {
  const phases = new Map(remotePhases);
  const localPhaseMap = new Map(localPhases);
  return {
    sessions: sessions(ids).map((session) => remoteIds.includes(session.id)
      ? { ...session, deviceLinkDeviceId: 'remote-device' }
      : session),
    runningSessionIds: new Set(running),
    notifications: new Set(notifications),
    attentionKinds: new Map(attentionKinds),
    urgentSessionIds: new Set(urgent),
    remotePhaseOf: (sessionId: string) => phases.get(sessionId),
    localPhaseOf: (sessionId: string) => localPhaseMap.get(sessionId),
  };
}

function resolve(options: ResolveOptions = {}) {
  return resolveCollapsedProjectAttentionTone(inputFor(options));
}

function summarize(options: ResolveOptions = {}) {
  return resolveCollapsedAttention(inputFor(options));
}

describe('collapsed project attention tone', () => {
  it('returns no aggregate for idle, running, or awaiting-only children', () => {
    expect(resolve()).toBeNull();
    expect(
      resolve({ notifications: ['session-1'], attentionKinds: [['session-1', 'awaiting']] }),
    ).toBeNull();
    expect(resolve({ remotePhases: [['session-1', 'running']] })).toBeNull();
    expect(resolve({ remotePhases: [['session-1', 'needs-interaction']] })).toBeNull();
  });

  it('shows green for local and remote completed unread children', () => {
    expect(resolve({ notifications: ['session-1'], attentionKinds: [['session-1', 'done']] })).toBe(
      'done',
    );
    // 定时任务未读可能没有 attention kind，子任务行仍显示完成绿点。
    expect(resolve({ notifications: ['session-1'] })).toBe('done');
    expect(resolve({ remotePhases: [['session-1', 'completed']] })).toBe('done');
  });

  it('shows red for local errors, urgent schedules, and remote errors', () => {
    expect(
      resolve({ notifications: ['session-1'], attentionKinds: [['session-1', 'error']] }),
    ).toBe('error');
    expect(resolve({ urgent: ['session-1'] })).toBe('error');
    expect(resolve({ remotePhases: [['session-1', 'error']] })).toBe('error');
  });

  it('gives red priority when red and green children coexist', () => {
    expect(
      resolve({
        ids: ['done', 'error'],
        notifications: ['done', 'error'],
        attentionKinds: [
          ['done', 'done'],
          ['error', 'error'],
        ],
      }),
    ).toBe('error');
  });

  it('treats a remote running state as authoritative over stale local attention', () => {
    expect(
      resolve({
        notifications: ['session-1'],
        attentionKinds: [['session-1', 'error']],
        remotePhases: [['session-1', 'running']],
      }),
    ).toBeNull();
  });

  it('does not aggregate stale local completion while the child is running again', () => {
    expect(
      resolve({
        running: ['session-1'],
        notifications: ['session-1'],
        attentionKinds: [['session-1', 'done']],
      }),
    ).toBeNull();
  });
});

describe('collapsed attention alert ids', () => {
  it('names every child that contributes the red dot, across all three sources', () => {
    const summary = summarize({
      ids: ['local-error', 'urgent-schedule', 'remote-error', 'done-child', 'idle-child'],
      notifications: ['local-error', 'done-child'],
      attentionKinds: [
        ['local-error', 'error'],
        ['done-child', 'done'],
      ],
      urgent: ['urgent-schedule'],
      remotePhases: [['remote-error', 'error']],
    });
    expect(summary.tone).toBe('error');
    expect([...summary.errorSessionIds]).toEqual([
      'local-error',
      'urgent-schedule',
      'remote-error',
    ]);
  });

  it('stays empty whenever the aggregate is green or absent', () => {
    expect(summarize({ notifications: ['session-1'] })).toEqual({
      tone: 'done',
      errorSessionIds: [],
    });
    expect(summarize()).toEqual({ tone: null, errorSessionIds: [] });
    // 蓝(等你回复)与运行态都不升格,也不算告警 —— 与 tone 口径一致。
    expect(
      summarize({ notifications: ['session-1'], attentionKinds: [['session-1', 'awaiting']] })
        .errorSessionIds,
    ).toEqual([]);
  });

  it('never reports an alert the tone would not show (remote mirror wins)', () => {
    const summary = summarize({
      notifications: ['session-1'],
      attentionKinds: [['session-1', 'error']],
      remotePhases: [['session-1', 'running']],
    });
    expect(summary.tone).toBeNull();
    expect(summary.errorSessionIds).toEqual([]);
  });
});

describe('collapsed automation group right status', () => {
  const status = (
    collapsed: boolean,
    latestKind: Parameters<typeof resolveCollapsedGroupRightStatus>[0]['latestKind'],
    tone: Parameters<typeof resolveCollapsedGroupRightStatus>[0]['tone'],
  ) => resolveCollapsedGroupRightStatus({ collapsed, latestKind, tone });

  it('keeps the latest run authoritative while the group is expanded', () => {
    expect(status(false, 'time', 'error')).toBe('time');
    expect(status(false, 'running', 'done')).toBe('running');
  });

  it('promotes an aggregated error over anything the latest run shows', () => {
    expect(status(true, 'time', 'error')).toBe('error');
    // 「等你处理」压过 spinner —— 正是此前被藏掉的那一档。
    expect(status(true, 'running', 'error')).toBe('error');
    expect(status(true, 'done', 'error')).toBe('error');
  });

  it('only fills green into an otherwise empty slot', () => {
    expect(status(true, 'time', 'done')).toBe('done');
    // 绿点绝不能盖掉 spinner:会读成「仍在跑却已完成」。
    expect(status(true, 'running', 'done')).toBe('running');
    expect(status(true, 'awaiting', 'done')).toBe('awaiting');
  });

  it('leaves the latest status untouched when the group has nothing to aggregate', () => {
    expect(status(true, 'running', null)).toBe('running');
    expect(status(true, 'time', null)).toBe('time');
  });
});

// Test value: the collapsed automation entry must expose an older waiting/running
// run after all child rows are hidden. Existing project tests intentionally omit
// those states. Minimal regression: latest idle run + older awaiting run; unit tier.
describe('single collapsed automation entry', () => {
  const groupState = (options: ResolveOptions = {}) =>
    resolveCollapsedAutomationGroupState({ ...inputFor(options), latestSessionId: 'latest' });

  it.each([
    {
      options: {
        ids: ['latest', 'older-awaiting'],
        notifications: ['older-awaiting'],
        attentionKinds: [['older-awaiting', 'awaiting']] as [string, AttentionKind][],
      },
      expected: { kind: 'awaiting', sessionId: 'older-awaiting', unreadCount: 0 },
    },
    {
      options: { ids: ['latest', 'older-running'], running: ['older-running'] },
      expected: { kind: 'running', sessionId: 'older-running', unreadCount: 0 },
    },
    {
      options: { ids: ['latest', 'older-done'], notifications: ['older-done'] },
      expected: { kind: 'done', sessionId: 'older-done', unreadCount: 1 },
    },
    {
      options: { ids: ['latest', 'older-idle'] },
      expected: { kind: 'time', sessionId: 'latest', unreadCount: 0 },
    },
  ])('opens the run contributing $expected.kind', ({ options, expected }) => {
    expect(groupState(options)).toEqual(expected);
  });

  it('prioritizes error, awaiting, running, then unread completion with matching destinations', () => {
    const options: ResolveOptions = {
      ids: ['latest', 'done', 'running', 'awaiting', 'error'],
      notifications: ['done', 'awaiting', 'error'],
      attentionKinds: [['awaiting', 'awaiting'], ['error', 'error']],
      running: ['running'],
    };
    expect(groupState(options)).toEqual({ kind: 'error', sessionId: 'error', unreadCount: 2 });
    expect(groupState({ ...options, ids: options.ids!.filter((id) => id !== 'error') })).toEqual({
      kind: 'awaiting', sessionId: 'awaiting', unreadCount: 1,
    });
    expect(groupState({ ...options, ids: ['latest', 'done', 'running'] })).toEqual({
      kind: 'running', sessionId: 'running', unreadCount: 1,
    });
  });

  it('uses remote phases over stale local attention and opens remote waiting runs', () => {
    const options: ResolveOptions = {
      ids: ['latest', 'remote-waiting', 'remote-running', 'remote-done'],
      notifications: ['remote-waiting', 'remote-running'],
      attentionKinds: [['remote-waiting', 'error'], ['remote-running', 'error']],
      remotePhases: [
        ['remote-waiting', 'needs-interaction'],
        ['remote-running', 'running'],
        ['remote-done', 'completed'],
      ],
    };
    expect(groupState(options)).toEqual({ kind: 'awaiting', sessionId: 'remote-waiting', unreadCount: 1 });
    expect(groupState({ ...options, ids: ['latest', 'remote-running', 'remote-done'] })).toEqual({
      kind: 'running', sessionId: 'remote-running', unreadCount: 1,
    });
    expect(groupState({ ...options, remotePhases: [['remote-done', 'error']], notifications: [] })).toEqual({
      kind: 'error', sessionId: 'remote-done', unreadCount: 1,
    });
  });

  it.each(['error', 'awaiting', 'running'] as SessionRightStatus[])(
    'preserves live latest %s after its unread marker is cleared', (latestKind) => {
      expect(resolveCollapsedAutomationGroupState({
        ...inputFor({ ids: ['latest', 'older-done'], notifications: ['older-done'] }),
        latestSessionId: 'latest', latestKind,
      })).toEqual({ kind: latestKind, sessionId: 'latest', unreadCount: 1 });
    },
  );

  it('keeps an older error above the latest live waiting state', () => {
    expect(resolveCollapsedAutomationGroupState({
      ...inputFor({ ids: ['latest', 'older-error'], urgent: ['older-error'] }),
      latestSessionId: 'latest', latestKind: 'awaiting',
    })).toEqual({ kind: 'error', sessionId: 'older-error', unreadCount: 1 });
  });

  it.each([false, true])('counts urgent-only failures once, with notification=%s', (hasNotification) => {
    expect(groupState({
      ids: ['latest', 'urgent-failure'], urgent: ['urgent-failure'],
      notifications: hasNotification ? ['urgent-failure'] : [],
    })).toEqual({ kind: 'error', sessionId: 'urgent-failure', unreadCount: 1 });
  });

  it.each([
    ['needs-interaction', 'awaiting'], ['running', 'running'], ['error', 'error'],
  ] as [RemoteSessionActivityPhase, SessionRightStatus][])(
    'exposes older local %s even after its notification is cleared', (phase, kind) => {
      expect(groupState({
        ids: ['latest', 'older-live'], localPhases: [['older-live', phase]],
      })).toEqual({ kind, sessionId: 'older-live', unreadCount: 0 });
    },
  );

  it('does not treat a remote row as local when its remote mirror is absent', () => {
    expect(groupState({
      ids: ['latest', 'remote'], remoteIds: ['remote'], localPhases: [['remote', 'error']],
    })).toEqual({ kind: 'time', sessionId: 'latest', unreadCount: 0 });
  });

  it('uses a local live running phase over a stale local error notification', () => {
    expect(groupState({
      ids: ['latest', 'older-live'], localPhases: [['older-live', 'running']],
      notifications: ['older-live'], attentionKinds: [['older-live', 'error']],
    })).toEqual({ kind: 'running', sessionId: 'older-live', unreadCount: 0 });
  });
});

describe('collapsed project attention wiring', () => {
  it('renders the aggregate status on the trailing slot while the project is collapsed', () => {
    const slotChrome = 'group/slot relative ml-auto flex h-6 shrink-0 items-center justify-end';
    const gridChrome = 'grid h-6 grid-cols-[max-content] items-center justify-items-end';
    expect(projectNodeSource).toContain('isCollapsed && collapsedStatusTone ? (');
    expect(projectNodeSource).toContain(
      '<SidebarRightStatusIndicator kind={collapsedStatusTone} isActive={false} />',
    );
    expect(projectNodeSource).not.toContain('AttentionDot');
    expect(projectNodeSource).toContain(slotChrome);
    expect(sessionItemSource).toContain(slotChrome);
    expect(projectNodeSource).toContain(gridChrome);
    expect(sessionItemSource).toContain(gridChrome);
    const nameSpan = projectNodeSource.indexOf(
      '<span className="min-w-0 max-w-full shrink truncate">{project.displayName}</span>',
    );
    const trailingSlot = projectNodeSource.indexOf(slotChrome);
    const indicator = projectNodeSource.indexOf(
      '<SidebarRightStatusIndicator kind={collapsedStatusTone} isActive={false} />',
    );
    expect(nameSpan).toBeGreaterThan(0);
    expect(trailingSlot).toBeGreaterThan(nameSpan);
    expect(indicator).toBeGreaterThan(trailingSlot);
  });

  it('aggregates the group header without falling back to whole-table subscriptions', () => {
    // 每个项目下都挂着若干组头,整表 / 整集订阅会让任何一个任务的状态变化重画全部组头。
    expect(automationGroupSource).not.toMatch(/useSessionAttentionKinds\s*\(/);
    expect(automationGroupSource).not.toMatch(/useSessionAttentionSnapshot\s*\(/);
    expect(automationGroupSource).not.toMatch(/useSessionAttentionUrgencySet\s*\(/);
    expect(automationGroupSource).not.toMatch(/useRemoteSessionActivityRevision\s*\(/);
    expect(automationGroupSource).toMatch(/useSessionsAttentionKindMap\(groupSessionIds\)/);
    expect(automationGroupSource).toMatch(/useSessionsAttentionUrgencyIdSet\(groupSessionIds\)/);
    expect(automationGroupSource).toMatch(/useRemoteSessionsPhaseMap\(group.sessions\)/);
  });

  it('opens the unread-failed session from a collapsed red group header', () => {
    const attention = { tone: 'error' as const, errorSessionIds: ['run-old'] };
    expect(
      resolveCollapsedGroupHeaderSessionId({
        collapsed: true,
        latestSessionId: 'run-new',
        attention,
      }),
    ).toBe('run-old');
    expect(
      resolveCollapsedGroupHeaderSessionId({
        collapsed: false,
        latestSessionId: 'run-new',
        attention,
      }),
    ).toBe('run-new');
    expect(
      resolveCollapsedGroupHeaderSessionId({
        collapsed: true,
        latestSessionId: 'run-new',
        attention: { tone: 'done', errorSessionIds: [] },
      }),
    ).toBe('run-new');
  });

  it('feeds both regular and pinned project rows from their displayed children', () => {
    expect(projectsSectionSource).toContain(
      'collapsed.has(project.projectKey) ? collapsedAttentionToneFor(project.sessions) : null',
    );
    expect(sidebarUpperSource).toMatch(
      /collapse\.collapsed\.has\(project\.projectKey\)[\s\S]*?collapsedAttentionToneFor\(displaySessions \?\? project\.sessions\)[\s\S]*?: null/,
    );
  });
});
