import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import {
  isCollaborationSession,
  sessionCollaborationLabel,
} from '@/session/collaboration';
import type { RemoteSession } from '@/session/types';

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

function session(patch: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id: 's1',
    userId: 'user-1',
    title: 'Session',
    workingDir: '/repo/app',
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    permissionMode: 'ask',
    fastMode: false,
    status: 'active',
    agentKind: 'cc',
    pinnedAt: null,
    userSendAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

describe('mobile collaboration session fallback', () => {
  it('labels Orca lead and worker sessions', () => {
    const lead = session({ orcaRole: 'lead' });
    const worker = session({ orcaRole: 'worker' });

    expect(sessionCollaborationLabel(lead)).toBe('协同 Lead');
    expect(sessionCollaborationLabel(worker)).toBe('协同 Worker');
    expect(isCollaborationSession(lead)).toBe(true);
    expect(isCollaborationSession(worker)).toBe(true);
  });

  it('keeps unknown collaboration roles readable but generic', () => {
    const custom = session({ orcaRole: 'reviewer' });

    expect(sessionCollaborationLabel(custom)).toBe('协同 reviewer');
    expect(sessionCollaborationLabel(session({ orcaRole: null }))).toBeNull();
    expect(isCollaborationSession(session({ orcaRole: null }))).toBe(false);
  });
});
