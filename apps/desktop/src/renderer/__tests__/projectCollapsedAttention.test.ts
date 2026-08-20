import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AttentionKind } from '@/lib/sessionAttentionStore';
import type { RemoteSessionActivityPhase } from '@/features/device-link/remoteSessionActivityStore';
import { resolveCollapsedProjectAttentionTone } from '../features/cc-agent/sidebar/projectCollapsedAttention';

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

const sessions = (ids: string[]) => ids.map((id) => ({ id }));

function resolve({
  ids = ['session-1'],
  running = [],
  notifications = [],
  attentionKinds = [],
  urgent = [],
  remotePhases = [],
}: {
  ids?: string[];
  running?: string[];
  notifications?: string[];
  attentionKinds?: [string, AttentionKind][];
  urgent?: string[];
  remotePhases?: [string, RemoteSessionActivityPhase][];
} = {}) {
  const phases = new Map(remotePhases);
  return resolveCollapsedProjectAttentionTone({
    sessions: sessions(ids),
    runningSessionIds: new Set(running),
    notifications: new Set(notifications),
    attentionKinds: new Map(attentionKinds),
    urgentSessionIds: new Set(urgent),
    remotePhaseOf: (sessionId) => phases.get(sessionId),
  });
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

  it('feeds both regular and pinned project rows from their displayed children', () => {
    expect(projectsSectionSource).toContain(
      'collapsed.has(project.projectKey) ? collapsedAttentionToneFor(project.sessions) : null',
    );
    expect(sidebarUpperSource).toMatch(
      /collapse\.collapsed\.has\(project\.projectKey\)[\s\S]*?collapsedAttentionToneFor\(displaySessions \?\? project\.sessions\)[\s\S]*?: null/,
    );
  });
});
