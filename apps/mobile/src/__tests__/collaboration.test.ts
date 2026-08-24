import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import {
  isCollaborationSession,
  sessionCollaborationComposerReadOnlyReason,
  sessionCollaborationLabel,
  sessionCollaborationNotice,
  sessionCollaborationReadOnlyReason,
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
  it('labels Orca lead and worker sessions without exposing orchestration actions', () => {
    const lead = session({ orcaRole: 'lead' });
    const worker = session({ orcaRole: 'worker' });

    expect(sessionCollaborationLabel(lead)).toBe('协同 Lead');
    expect(sessionCollaborationLabel(worker)).toBe('协同 Worker');
    // Lead 文案:可以发消息聊天,只有编排操作留在电脑端(不再说"暂不提供发送消息")。
    expect(sessionCollaborationNotice(lead)).toContain('继续发消息');
    expect(sessionCollaborationNotice(lead)).toContain('创建 Worker');
    expect(sessionCollaborationNotice(lead)).not.toContain('暂不提供');
    expect(sessionCollaborationNotice(worker)).toContain('发送消息');
    expect(sessionCollaborationNotice(worker)).toContain('切换 Worker 焦点');
    expect(isCollaborationSession(lead)).toBe(true);
    expect(sessionCollaborationReadOnlyReason(worker)).toContain('只读');
  });

  it('lets Lead compose messages while keeping worker composer read-only', () => {
    const lead = session({ orcaRole: 'lead' });
    const worker = session({ orcaRole: 'worker' });
    const custom = session({ orcaRole: 'reviewer' });

    // composer 只读:Lead 可发消息(null),worker / 其它角色只读(非空)。
    expect(sessionCollaborationComposerReadOnlyReason(lead)).toBeNull();
    expect(sessionCollaborationComposerReadOnlyReason(worker)).toContain('只读');
    expect(sessionCollaborationComposerReadOnlyReason(custom)).toContain('只读');
    expect(sessionCollaborationComposerReadOnlyReason(session({ orcaRole: null }))).toBeNull();

    // 但写编排只读对 Lead 仍生效(fork/rewind/队列/设置仍留电脑端)。
    expect(sessionCollaborationReadOnlyReason(lead)).not.toBeNull();
  });

  it('keeps unknown collaboration roles readable but generic', () => {
    const custom = session({ orcaRole: 'reviewer' });

    expect(sessionCollaborationLabel(custom)).toBe('协同 reviewer');
    expect(sessionCollaborationNotice(custom)).toContain('协同编排操作请在电脑端完成');
    expect(sessionCollaborationReadOnlyReason(custom)).toContain('任务修改请在电脑端完成');
    expect(sessionCollaborationLabel(session({ orcaRole: null }))).toBeNull();
    expect(isCollaborationSession(session({ orcaRole: null }))).toBe(false);
    expect(sessionCollaborationReadOnlyReason(session({ orcaRole: null }))).toBeNull();
  });
});
