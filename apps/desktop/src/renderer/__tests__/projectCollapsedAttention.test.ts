import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AttentionKind } from '@/lib/sessionAttentionStore';
import type { RemoteSessionActivityPhase } from '@/features/device-link/remoteSessionActivityStore';
import {
  resolveCollapsedAttention,
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
}

function inputFor({
  ids = ['session-1'],
  running = [],
  notifications = [],
  attentionKinds = [],
  urgent = [],
  remotePhases = [],
}: ResolveOptions = {}) {
  const phases = new Map(remotePhases);
  return {
    sessions: sessions(ids),
    runningSessionIds: new Set(running),
    notifications: new Set(notifications),
    attentionKinds: new Map(attentionKinds),
    urgentSessionIds: new Set(urgent),
    remotePhaseOf: (sessionId: string) => phases.get(sessionId),
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

describe('collapsed project attention wiring', () => {
  it('renders the aggregate status on the trailing slot while the project is collapsed', () => {
    const slotChrome = 'group/slot relative ml-auto flex h-6 shrink-0 items-center justify-end';
    const gridChrome = 'grid h-6 grid-cols-[max-content] items-center justify-items-end';
    expect(projectNodeSource).toContain('isCollapsed && collapsedAttentionTone ? (');
    expect(projectNodeSource).toContain(
      '<SidebarRightStatusIndicator kind={collapsedAttentionTone} isActive={false} />',
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
      '<SidebarRightStatusIndicator kind={collapsedAttentionTone} isActive={false} />',
    );
    expect(nameSpan).toBeGreaterThan(0);
    expect(trailingSlot).toBeGreaterThan(nameSpan);
    expect(indicator).toBeGreaterThan(trailingSlot);
  });

  it('feeds the automation group header and its collapsed rows from the same summary', () => {
    // 组头红点与收起态提上来的告警行必须同源 —— 判据分家就会重演「项目行有红点、
    // 展开后哪一行都没有」。
    expect(automationGroupSource).toContain('resolveCollapsedAttention({');
    expect(automationGroupSource).toContain('resolveCollapsedGroupRightStatus({');
    expect(automationGroupSource).toMatch(/tone:\s*collapsedAttention\.tone/);
    expect(automationGroupSource).toMatch(/new Set\(collapsedAttention\.errorSessionIds\)/);
    expect(automationGroupSource).toContain('alertSessionIds,');
    // 收起态不再是"空列表",子行的取舍统一由 getAutomationGroupChildView 决定。
    expect(automationGroupSource).toContain('const visibleSessions = childView.visibleSessions;');
    expect(automationGroupSource).not.toMatch(/collapsed\s*\?\s*\[\]\s*:/);
  });

  it('aggregates the group header without falling back to whole-table subscriptions', () => {
    // 每个项目下都挂着若干组头,整表 / 整集订阅会让任何一个任务的状态变化重画全部组头。
    expect(automationGroupSource).not.toMatch(/useSessionAttentionKinds\s*\(/);
    expect(automationGroupSource).not.toMatch(/useSessionAttentionSnapshot\s*\(/);
    expect(automationGroupSource).not.toMatch(/useSessionAttentionUrgencySet\s*\(/);
    expect(automationGroupSource).not.toMatch(/useRemoteSessionActivityRevision\s*\(/);
    expect(automationGroupSource).toMatch(/useSessionsAttentionKindMap\(groupSessionIds\)/);
    expect(automationGroupSource).toMatch(/useSessionsAttentionUrgencyIdSet\(groupSessionIds\)/);
    expect(automationGroupSource).toMatch(/useRemoteSessionsPhaseMap\(groupSessionIds\)/);
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
