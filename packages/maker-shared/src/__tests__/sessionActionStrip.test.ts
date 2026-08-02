import { describe, expect, it } from 'vitest';
import {
  buildSessionActionStrip,
  sessionCollaborationLabel,
  sessionCollaborationReadOnlyReason,
  sessionWorktreeInfo,
} from '../index.js';
import type { SessionActionStripSessionLike } from '../sessionActionStrip.js';

function session(patch: Partial<SessionActionStripSessionLike> = {}): SessionActionStripSessionLike {
  return {
    agentKind: 'cc',
    fastMode: false,
    model: 'claude-sonnet-4-6',
    permissionMode: 'ask',
    status: 'active',
    workingDir: '/repo/app',
    ...patch,
  };
}

describe('shared session action strip model', () => {
  it('builds the writable session header and action strip without platform assumptions', () => {
    const overview = buildSessionActionStrip({
      messageCount: 8,
      pendingCount: 0,
      queueAvailable: false,
      queueCount: 0,
      queuePaused: false,
      session: session({ workingDir: 'D:\\repo\\app\\' }),
    });

    expect(overview).toMatchObject({
      actionCopy: null,
      attentionLabel: null,
      filesEnabled: true,
      runtimeSubtitle: 'Claude Code · claude-sonnet-4-6 · ask',
      title: 'app',
    });
    expect(overview.stateChips).toEqual([]);
    expect(overview.actions.map((action) => [action.id, action.label, action.disabledReason])).toEqual([
      ['settings', '设置', null],
      ['usage', '用量', null],
      ['files', '文件', null],
      ['queue', '队列', '当前没有队列消息。'],
      ['search', '搜索', null],
    ]);
  });

  it('labels pi sessions as Pi in the runtime subtitle', () => {
    // codex review 回归:二元映射会把 Pi 会话副标题显示成 Claude Code。
    const overview = buildSessionActionStrip({
      messageCount: 1,
      pendingCount: 0,
      queueAvailable: false,
      queueCount: 0,
      queuePaused: false,
      session: session({ agentKind: 'pi' }),
    });

    expect(overview.runtimeSubtitle).toBe('Pi · claude-sonnet-4-6 · ask');
  });

  it('promotes pending interactions and keeps normal queue count as icon attention only', () => {
    const overview = buildSessionActionStrip({
      diffCount: 2,
      messageCount: 3,
      pendingCount: 2,
      queueAvailable: false,
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
    expect(overview.actions.find((action) => action.id === 'queue')).toMatchObject({
      attention: true,
      disabled: true,
      disabledReason: '先处理待处理请求，处理后队列面板会恢复。',
      label: '队列暂停',
    });
  });

  it('keeps collaboration and dialogue sessions inspectable with clear disabled reasons', () => {
    const overview = buildSessionActionStrip({
      messageCount: 0,
      pendingCount: 0,
      queueAvailable: false,
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
    expect(overview.stateChips).toEqual([
      { id: 'read-only', label: '只读', strong: true },
    ]);
    expect(overview.runtimeSubtitle).toBe('协作 Worker · Worktree app-worker · Codex · claude-sonnet-4-6 · plan · Fast');
    // 这条 fixture 恰好证明禁用原因不能断言「因为不绑项目」: 它是 Orca Worker、
    // 有 worktreePath, 只是 workingDir 为 null —— 判据只看 workingDir。
    expect(overview.actions.find((action) => action.id === 'files')).toMatchObject({
      disabled: true,
      disabledReason: '这个任务没有远程工作目录，不能浏览文件。',
    });
    expect(overview.actions.find((action) => action.id === 'search')).toMatchObject({
      disabled: true,
      disabledReason: '当前没有可搜索的消息。',
    });
  });

  it('promotes remote unavailable copy before writable composer guidance', () => {
    const overview = buildSessionActionStrip({
      messageCount: 2,
      pendingCount: 0,
      queueAvailable: false,
      queueCount: 0,
      queuePaused: false,
      remoteUnavailableReason: '网络或被控端暂时不可用，可以稍后重新同步。',
      session: session(),
    });

    expect(overview.actionCopy).toBe('网络或被控端暂时不可用，可以稍后重新同步。');
    expect(overview.stateChips).toEqual([
      { id: 'remote-unavailable', label: '不可用', strong: true },
    ]);
    expect(overview.actions.find((action) => action.id === 'queue')).toMatchObject({
      disabled: true,
      disabledReason: '被控电脑暂不可用，重新同步后再查看队列。',
    });
  });
});

describe('shared session identity helpers', () => {
  it('labels collaboration sessions and extracts worktree names across platforms', () => {
    expect(sessionCollaborationLabel({ orcaRole: 'lead' })).toBe('协作 Lead');
    expect(sessionCollaborationLabel({ orcaRole: 'reviewer' })).toBe('协作 reviewer');
    expect(sessionCollaborationReadOnlyReason({ orcaRole: 'worker' })).toContain('只读安全降级');
    expect(sessionWorktreeInfo({ worktreePath: 'D:\\repo\\.xdt-worktrees\\feat-win\\' })).toEqual({
      path: 'D:\\repo\\.xdt-worktrees\\feat-win\\',
      name: 'feat-win',
    });
  });
});
