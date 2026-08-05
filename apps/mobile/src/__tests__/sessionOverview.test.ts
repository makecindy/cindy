import { describe, expect, it } from 'vitest';
import { summarizeSessionOverview } from '@/session/sessionOverview';
import type { RemoteSession } from '@/session/types';

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

describe('sessionOverview', () => {
  it('summarizes the core runtime state for a normal writable session', () => {
    const overview = summarizeSessionOverview({
      messageCount: 8,
      pendingCount: 0,
      queueCount: 0,
      queuePaused: false,
      session: session(),
    });

    expect(overview).toMatchObject({
      actionCopy: null,
      attentionLabel: null,
      filesEnabled: true,
      runtimeSubtitle: 'Claude Code · claude-sonnet-4-6 · ask',
      title: 'app',
    });
    expect(overview.stateChips).toEqual([]);
  });

  it('promotes pending interactions before queue and spend copy', () => {
    const overview = summarizeSessionOverview({
      diffCount: 2,
      messageCount: 3,
      pendingCount: 2,
      queueCount: 4,
      queuePaused: true,
      session: session({ totalCostUsd: 0.24, totalTokenUsage: 12000 }),
    });

    expect(overview.attentionLabel).toBe('待处理 2');
    expect(overview.actionCopy).toBe('先处理待处理请求，处理后输入区会恢复。');
    expect(overview.stateChips).toEqual([
      { id: 'pending', label: '待处理 2', strong: true },
      { id: 'queue-paused', label: '队列暂停', strong: true },
    ]);
  });

  it('keeps collaboration worker sessions inspectable but clearly read-only', () => {
    const overview = summarizeSessionOverview({
      messageCount: 1,
      pendingCount: 0,
      queueCount: 0,
      queuePaused: false,
      readOnlyReason: '协作模式手机版第一版为只读安全降级。',
      session: session({
        agentKind: 'codex',
        fastMode: true,
        orcaRole: 'worker',
        permissionMode: 'plan',
        workingDir: null,
        worktreePath: '/repo/app-worker',
      }),
    });

    expect(overview.attentionLabel).toBe('只读');
    expect(overview.filesEnabled).toBe(false);
    expect(overview.actionCopy).toBe('协作模式手机版第一版为只读安全降级。');
    expect(overview.stateChips).toEqual([
      { id: 'read-only', label: '只读', strong: true },
    ]);
    expect(overview.runtimeSubtitle).toBe('协作 Worker · Worktree app-worker · Codex · claude-sonnet-4-6 · plan · Fast');
  });

  it('marks archived sessions without surfacing usage in the main overview', () => {
    const overview = summarizeSessionOverview({
      messageCount: 0,
      pendingCount: 0,
      queueCount: 0,
      queuePaused: false,
      session: session({
        contextTokens: 16000,
        contextWindow: 200000,
        status: 'archived',
        totalTokenUsage: 42000,
      }),
    });

    expect(overview.attentionLabel).toBe('已归档');
    expect(overview.actionCopy).toBe('会话已归档，恢复后才能继续发送。');
    expect(overview.stateChips).toEqual([
      { id: 'status', label: '已归档', strong: true },
    ]);
  });
});
