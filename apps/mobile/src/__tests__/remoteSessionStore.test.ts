import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAKER_EVENT_BATCH_CHANNEL } from '@cindy/device-link';
import { remoteSessionStore, sessionPendingWrites } from '@/session/remoteSessionStore';
import type { InputProjection, PendingInteraction, RemoteMessage, RemoteSession } from '@/session/types';

function session(id: string, patch: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id,
    userId: 'user-1',
    title: id,
    workingDir: '/repo',
    workspaceKind: 'project',
    model: 'claude',
    effort: 'medium',
    permissionMode: 'default',
    fastMode: false,
    status: 'active',
    agentKind: 'cc',
    userSendAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

function message(id: string, sessionId: string): RemoteMessage {
  return {
    id,
    clientId: id,
    sessionId,
    role: 'assistant',
    content: 'hello',
    toolUseId: null,
    agentMeta: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function messageAt(id: string, sessionId: string, createdAt: string): RemoteMessage {
  return { ...message(id, sessionId), createdAt };
}

function pushMakerStatus(sessionId: string, data: Record<string, unknown>): void {
  remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
    sessionId,
    event: { type: 'status', data },
  });
}

function pushMakerTaskUpdate(
  sessionId: string,
  taskId: string,
  opts: { source?: 'claude-code' | 'codex' | 'pi'; status?: string; description?: string } = {},
): void {
  remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
    sessionId,
    event: {
      type: 'agent_task_update',
      source: opts.source ?? 'claude-code',
      data: {
        taskId,
        status: opts.status ?? 'running',
        title: taskId,
        ...(opts.description ? { description: opts.description } : {}),
      },
    },
  });
}

function pushMakerText(
  sessionId: string,
  persistId: string | undefined,
  text: string,
  isFinal: boolean,
  agentMeta?: Record<string, unknown>,
): void {
  remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
    sessionId,
    ...(persistId ? { persistId } : {}),
    event: {
      type: 'text',
      data: { text, isFinal },
      ...(agentMeta ? { agentMeta } : {}),
    },
  });
}

function projection(sessionId: string, clientId = 'q-1'): InputProjection {
  return {
    sessionId,
    pendingQueue: [{
      clientId,
      text: 'queued',
      persistedContent: JSON.stringify({ text: 'queued', images: [], files: [] }),
      model: 'claude',
      effort: 'medium',
      permissionMode: 'ask',
      workingDir: '/repo',
      createOpts: {
        agentKind: 'claude-code',
        workingDir: '/repo',
        model: 'claude',
      },
      chatMessage: {
        clientId,
        role: 'user',
        content: 'queued',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    }],
    steeringQueueClientIds: [],
    queuePaused: true,
    queueExpanded: false,
    queueInteractionLocks: [],
    queueEditLocks: [],
    queueAbortPending: false,
    error: null,
    errorRetryText: null,
    credentialSwitchWait: null,
  };
}

function pending(kind: string, requestId?: string, persistId?: string): PendingInteraction {
  return {
    persistId,
    request: {
      kind,
      ...(requestId ? { requestId } : {}),
    },
  };
}

describe('remoteSessionStore', () => {
  beforeEach(() => remoteSessionStore.clear());

  it('normalizes same-timestamp messages by host rowid', () => {
    const createdAt = '2026-01-01T00:00:00.000Z';
    remoteSessionStore.setMessages('s1', [
      { ...message('a-newer', 's1'), createdAt, rowid: 5 },
      { ...message('z-older', 's1'), createdAt, rowid: 4 },
    ]);

    expect(remoteSessionStore.getMessages('s1').map((item) => item.id)).toEqual([
      'z-older',
      'a-newer',
    ]);
  });

  it('preserves arrival order for same-timestamp messages without host rowid', () => {
    const createdAt = '2026-01-01T00:00:00.000Z';
    remoteSessionStore.setMessages('s1', [
      { ...message('z-first', 's1'), createdAt },
      { ...message('a-second', 's1'), createdAt },
    ]);

    expect(remoteSessionStore.getMessages('s1').map((item) => item.id)).toEqual([
      'z-first',
      'a-second',
    ]);
  });

  it('stamps sessions with device-link origin and indexes session ids', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);

    expect(remoteSessionStore.getSessions()[0]).toMatchObject({
      id: 's1',
      deviceLinkDeviceId: 'dev-1',
      deviceLinkDeviceName: 'Mac',
    });
    expect(remoteSessionStore.getSessionDeviceId('s1')).toBe('dev-1');
  });

  it('mirrors new-maker worktree preference pushes, including explicit false and same-value revisions', () => {
    expect(remoteSessionStore.getNewMakerWorktreePreference('dev-1')).toEqual({
      enabled: false,
      revision: 0,
    });

    remoteSessionStore.applyRemotePush('dev-1', 'maker:new-maker-draft:changed', {
      claudeCode: { worktreeEnabled: true },
      codex: { worktreeEnabled: true },
    });
    expect(remoteSessionStore.getNewMakerWorktreePreference('dev-1')).toEqual({
      enabled: true,
      revision: 1,
    });

    remoteSessionStore.applyRemotePush('dev-1', 'maker:new-maker-draft:changed', {
      codex: { worktreeEnabled: false },
    });
    expect(remoteSessionStore.getNewMakerWorktreePreference('dev-1')).toEqual({
      enabled: false,
      revision: 2,
    });

    // 同值 push 仍可能晚于在途 pull，revision 必须推进让旧响应失去写权。
    remoteSessionStore.applyRemotePush('dev-1', 'maker:new-maker-draft:changed', {
      claudeCode: { worktreeEnabled: false },
    });
    expect(remoteSessionStore.getNewMakerWorktreePreference('dev-1')).toEqual({
      enabled: false,
      revision: 3,
    });

    remoteSessionStore.applyRemotePush('dev-1', 'maker:new-maker-draft:changed', {
      claudeCode: { worktreeEnabled: 'yes' },
    });
    expect(remoteSessionStore.getNewMakerWorktreePreference('dev-1').revision).toBe(3);
  });

  it('isolates new-maker worktree preferences by device and removes their revisions with the device', () => {
    remoteSessionStore.setNewMakerWorktreePreference('dev-1', true);
    remoteSessionStore.setNewMakerWorktreePreference('dev-2', false);
    remoteSessionStore.setNewMakerWorktreePreference('dev-2', true);

    expect(remoteSessionStore.getNewMakerWorktreePreference('dev-1')).toEqual({
      enabled: true,
      revision: 1,
    });
    expect(remoteSessionStore.getNewMakerWorktreePreference('dev-2')).toEqual({
      enabled: true,
      revision: 2,
    });

    remoteSessionStore.removeDevice('dev-1');
    expect(remoteSessionStore.getNewMakerWorktreePreference('dev-1')).toEqual({
      enabled: false,
      revision: 0,
    });
    expect(remoteSessionStore.getNewMakerWorktreePreference('dev-2')).toEqual({
      enabled: true,
      revision: 2,
    });

    remoteSessionStore.clear();
    expect(remoteSessionStore.getNewMakerWorktreePreference('dev-2')).toEqual({
      enabled: false,
      revision: 0,
    });
  });

  it('mirrors host-revisioned worktree branches without coupling them to the checkbox', () => {
    remoteSessionStore.setNewMakerWorktreePreference('dev-1', true);

    remoteSessionStore.applyRemotePush(
      'dev-1',
      'maker:new-maker-worktree-branch:changed',
      { baseRepo: '/repo/a', sourceBranch: 'feature/mobile', revision: 1 },
    );
    expect(remoteSessionStore.getNewMakerWorktreeBranchPreference('dev-1', '/repo/a')).toEqual({
      baseRepo: '/repo/a',
      sourceBranch: 'feature/mobile',
      revision: 1,
    });
    expect(remoteSessionStore.getNewMakerWorktreePreference('dev-1')).toEqual({
      enabled: true,
      revision: 1,
    });

    // 同一分支的较新 host snapshot 仍要推进 revision，给在途 pull / apply 回包做 fence。
    remoteSessionStore.applyRemotePush(
      'dev-1',
      'maker:new-maker-worktree-branch:changed',
      { baseRepo: '/repo/a', sourceBranch: 'feature/mobile', revision: 2 },
    );
    expect(remoteSessionStore.getNewMakerWorktreeBranchPreference('dev-1', '/repo/a')?.revision)
      .toBe(2);

    // 更旧 revision 以及同 revision 的冲突值都无权覆盖已接受的宿主快照。
    remoteSessionStore.applyRemotePush(
      'dev-1',
      'maker:new-maker-worktree-branch:changed',
      { baseRepo: '/repo/a', sourceBranch: 'stale', revision: 1 },
    );
    remoteSessionStore.applyRemotePush(
      'dev-1',
      'maker:new-maker-worktree-branch:changed',
      { baseRepo: '/repo/a', sourceBranch: 'conflict', revision: 2 },
    );
    expect(remoteSessionStore.getNewMakerWorktreeBranchPreference('dev-1', '/repo/a')).toEqual({
      baseRepo: '/repo/a',
      sourceBranch: 'feature/mobile',
      revision: 2,
    });
  });

  it('isolates worktree branch snapshots by device and canonical repo, then clears their shards', () => {
    remoteSessionStore.setNewMakerWorktreeBranchPreference('dev-1', {
      baseRepo: '/repo/a', sourceBranch: 'main', revision: 1,
    });
    remoteSessionStore.setNewMakerWorktreeBranchPreference('dev-1', {
      baseRepo: '/repo/b', sourceBranch: 'release', revision: 4,
    });
    remoteSessionStore.setNewMakerWorktreeBranchPreference('dev-2', {
      baseRepo: '/repo/a', sourceBranch: 'develop', revision: 2,
    });

    expect(remoteSessionStore.getNewMakerWorktreeBranchPreference('dev-1', '/repo/a')?.sourceBranch)
      .toBe('main');
    expect(remoteSessionStore.getNewMakerWorktreeBranchPreference('dev-1', '/repo/b')?.sourceBranch)
      .toBe('release');
    expect(remoteSessionStore.getNewMakerWorktreeBranchPreference('dev-2', '/repo/a')?.sourceBranch)
      .toBe('develop');
    expect(remoteSessionStore.getNewMakerWorktreeBranchPreference('dev-2', '/repo/b')).toBeNull();

    remoteSessionStore.removeDevice('dev-1');
    expect(remoteSessionStore.getNewMakerWorktreeBranchPreference('dev-1', '/repo/a')).toBeNull();
    expect(remoteSessionStore.getNewMakerWorktreeBranchPreference('dev-1', '/repo/b')).toBeNull();
    expect(remoteSessionStore.getNewMakerWorktreeBranchPreference('dev-2', '/repo/a')?.sourceBranch)
      .toBe('develop');

    remoteSessionStore.clear();
    expect(remoteSessionStore.getNewMakerWorktreeBranchPreference('dev-2', '/repo/a')).toBeNull();
  });

  it('ignores malformed worktree branch pushes without disturbing an accepted snapshot', () => {
    remoteSessionStore.setNewMakerWorktreeBranchPreference('dev-1', {
      baseRepo: '/repo/a', sourceBranch: 'main', revision: 3,
    });
    for (const payload of [
      null,
      { baseRepo: '', sourceBranch: 'release', revision: 4 },
      { baseRepo: '/repo/a', sourceBranch: '', revision: 4 },
      { baseRepo: '/repo/a', sourceBranch: 'release', revision: -1 },
      { baseRepo: '/repo/a', sourceBranch: 'release', revision: 3.5 },
      { baseRepo: '/repo/a', sourceBranch: 'release', revision: '4' },
    ]) {
      remoteSessionStore.applyRemotePush(
        'dev-1',
        'maker:new-maker-worktree-branch:changed',
        payload,
      );
    }
    expect(remoteSessionStore.getNewMakerWorktreeBranchPreference('dev-1', '/repo/a')).toEqual({
      baseRepo: '/repo/a',
      sourceBranch: 'main',
      revision: 3,
    });
  });

  it('mirrors structured session money and legacy USD usage pushes', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);

    // 被控端裸 UPDATE 不发 sessions:patched,这两条(sessions topic)是唯一更新通道。
    remoteSessionStore.applyRemotePush('dev-1', 'usage:session-spend-changed', {
      sessionId: 's1',
      totalCostUsd: 1.23,
    });
    remoteSessionStore.applyRemotePush('dev-1', 'usage:session-tokens-changed', {
      sessionId: 's1',
      totalTokens: 45_000,
    });
    expect(remoteSessionStore.getSessions()[0]).toMatchObject({
      id: 's1',
      totalCostUsd: 1.23,
      totalTokenUsage: 45_000,
    });

    remoteSessionStore.applyRemotePush('dev-1', 'usage:session-spend-changed', {
      sessionId: 's1',
      totalMoney: {
        amount: 8.24,
        currency: 'CNY',
        approximate: false,
        kind: 'actual-cost',
      },
    });
    expect(remoteSessionStore.getSessions()[0]).toMatchObject({
      totalMoney: {
        amount: 8.24,
        currency: 'CNY',
      },
    });

    // 跨设备 payload 防御:NaN / 负数不入镜像。
    remoteSessionStore.applyRemotePush('dev-1', 'usage:session-spend-changed', {
      sessionId: 's1',
      totalCostUsd: Number.NaN,
    });
    remoteSessionStore.applyRemotePush('dev-1', 'usage:session-tokens-changed', {
      sessionId: 's1',
      totalTokens: -1,
    });
    expect(remoteSessionStore.getSessions()[0]).toMatchObject({
      totalCostUsd: 1.23,
      totalTokenUsage: 45_000,
    });
  });

  it('removes archived sessions from the active mirror', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1'), session('s2')]);
    remoteSessionStore.applySessionPatch('dev-1', 's1', { status: 'archived' });

    expect(remoteSessionStore.getSessions().map((s) => s.id)).toEqual(['s2']);
  });

  it('upserts forked sessions at the top of the controlled device shard', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1'), session('s2')]);
    remoteSessionStore.upsertDeviceSession('dev-1', 'Mac', session('forked', { title: 'Forked' }));

    expect(remoteSessionStore.getSessions().map((s) => s.id)).toEqual(['forked', 's1', 's2']);
    expect(remoteSessionStore.getSessionDeviceId('forked')).toBe('dev-1');

    remoteSessionStore.upsertDeviceSession('dev-1', 'Mac', session('s1', { title: 'Updated' }));
    expect(remoteSessionStore.getSessions().map((s) => [s.id, s.title])).toEqual([
      ['s1', 'Updated'],
      ['forked', 'Forked'],
      ['s2', 's2'],
    ]);
  });

  it('preserves the main-memory Agent switch intent across SQLite session snapshots', () => {
    const intent = {
      targetAgentKind: 'codex' as const,
      model: 'gpt-5.5',
      providerId: 'openai',
      effort: 'high',
      fastMode: true,
    };
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    remoteSessionStore.applySessionPatch('dev-1', 's1', { agentSwitchIntent: intent });

    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1', { title: 'Fresh list' })]);
    expect(remoteSessionStore.getSessions()[0]).toMatchObject({
      title: 'Fresh list',
      agentSwitchIntent: intent,
    });

    remoteSessionStore.upsertDeviceSession('dev-1', 'Mac', session('s1', { title: 'Fresh detail' }));
    expect(remoteSessionStore.getSessions()[0]).toMatchObject({
      title: 'Fresh detail',
      agentSwitchIntent: intent,
    });

    remoteSessionStore.applySessionPatch('dev-1', 's1', { agentSwitchIntent: null });
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1', { title: 'After cancel' })]);
    expect(remoteSessionStore.getSessions()[0].agentSwitchIntent).toBeNull();
  });

  it('does not let a draft sentinel snapshot replace an optimistic first-message title', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [
      session('s1', { title: '帮我排查登录失败' }),
    ]);
    remoteSessionStore.setPendingTitlePreview('s1', '帮我排查登录失败');
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [
      session('s1', { title: 'New Maker' }),
    ]);
    expect(remoteSessionStore.getSessions()[0]?.title).toBe('帮我排查登录失败');

    remoteSessionStore.applySessionPatch('dev-1', 's1', { title: 'New Maker' });
    expect(remoteSessionStore.getSessions()[0]?.title).toBe('帮我排查登录失败');

    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [
      session('s1', { title: '登录失败排查' }),
    ]);
    expect(remoteSessionStore.getSessions()[0]?.title).toBe('登录失败排查');
  });

  it('keeps the first-message preview after pendingLocalCreation settles', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [
      session('s1', { title: '帮我排查登录失败', pendingLocalCreation: true }),
    ]);
    remoteSessionStore.setPendingTitlePreview('s1', '帮我排查登录失败');
    remoteSessionStore.applySessionPatch('dev-1', 's1', { pendingLocalCreation: false });
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [
      session('s1', { title: 'New Maker' }),
    ]);
    expect(remoteSessionStore.getSessions()[0]?.title).toBe('帮我排查登录失败');
    expect(remoteSessionStore.getSessions()[0]?.pendingLocalCreation).toBeFalsy();
  });

  it('lets an authoritative New Maker rename through after the preview is cleared', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [
      session('s1', { title: '帮我排查登录失败' }),
    ]);
    remoteSessionStore.setPendingTitlePreview('s1', '帮我排查登录失败');
    remoteSessionStore.clearPendingTitlePreview('s1');
    remoteSessionStore.applySessionPatch('dev-1', 's1', { title: 'New Maker' });
    expect(remoteSessionStore.getSessions()[0]?.title).toBe('New Maker');
  });

  it('keeps a title preview across a stale list that temporarily omits the new session', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [
      session('s-old'),
    ]);
    remoteSessionStore.upsertDeviceSession(
      'dev-1',
      'Mac',
      session('s-new', { title: '帮我排查登录失败', pendingLocalCreation: true }),
    );
    remoteSessionStore.setPendingTitlePreview('s-new', '帮我排查登录失败');
    remoteSessionStore.applySessionPatch('dev-1', 's-new', { pendingLocalCreation: false });
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [
      session('s-old'),
    ]);
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [
      session('s-old'),
      session('s-new', { title: 'New Maker' }),
    ]);
    expect(remoteSessionStore.getSessions().find((row) => row.id === 's-new')?.title).toBe('帮我排查登录失败');
  });

  it('dedupes an unchanged message push by id or client id', () => {
    remoteSessionStore.setMessages('s1', [message('m1', 's1')]);
    const versionAfterSet = remoteSessionStore.getMessageVersion();
    remoteSessionStore.appendMessage('s1', message('m1', 's1'));

    expect(remoteSessionStore.getMessages('s1')).toHaveLength(1);
    expect(remoteSessionStore.getMessageVersion()).toBe(versionAfterSet);
  });

  it('upserts a changed message push instead of keeping the stale duplicate', () => {
    remoteSessionStore.applyRemotePush('dev-1', 'local-db:messages:created', {
      sessionId: 's1',
      message: message('m1', 's1'),
    });
    const versionAfterCreate = remoteSessionStore.getMessageVersion();

    remoteSessionStore.applyRemotePush('dev-1', 'local-db:messages:created', {
      sessionId: 's1',
      message: { ...message('m1', 's1'), content: 'updated' },
    });

    expect(remoteSessionStore.getMessages('s1')).toHaveLength(1);
    expect(remoteSessionStore.getMessages('s1')[0].content).toBe('updated');
    expect(remoteSessionStore.getMessageVersion()).toBeGreaterThan(versionAfterCreate);
  });

  it('removes a deleted AI round from the device-link transcript mirror', () => {
    remoteSessionStore.setMessages('s1', [
      message('m1', 's1'),
      message('m2', 's1'),
      message('m3', 's1'),
    ]);
    remoteSessionStore.markSessionMessagesSynced('s1', {
      _count: { messages: 3 },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    pushMakerTaskUpdate('s1', 'm1');
    expect(remoteSessionStore.getSessionTaskUpdates('s1').size).toBeGreaterThan(0);

    remoteSessionStore.applyRemotePush('dev-1', 'local-db:messages:deleted', {
      sessionId: 's1',
      clientId: 'm1',
      clientIds: ['m1', 'm2'],
    });

    expect(remoteSessionStore.getMessages('s1').map((item) => item.clientId)).toEqual(['m3']);
    expect(remoteSessionStore.getSessionTaskUpdates('s1').size).toBe(0);
    expect(remoteSessionStore.isSessionMessageWindowSynced('s1', {
      _count: { messages: 3 },
      updatedAt: '2026-01-01T00:00:00.000Z',
    })).toBe(false);
  });

  it('removes an orphan task update even when its deleted message is not cached', () => {
    remoteSessionStore.setMessages('s1', [message('m1', 's1')]);
    pushMakerTaskUpdate('s1', 'orphan-task');
    expect(remoteSessionStore.getSessionTaskUpdates('s1').size).toBeGreaterThan(0);

    remoteSessionStore.applyRemotePush('dev-1', 'local-db:messages:deleted', {
      sessionId: 's1',
      clientId: 'orphan-task',
      clientIds: ['orphan-task'],
    });

    expect(remoteSessionStore.getMessages('s1').map((item) => item.clientId)).toEqual(['m1']);
    expect(remoteSessionStore.getSessionTaskUpdates('s1').size).toBe(0);
  });

  it('batches maker text deltas into one streaming assistant row', () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const unsubscribe = remoteSessionStore.subscribe(notify);
    try {
      pushMakerText('s1', 'persist-1', 'hello', false);
      pushMakerText('s1', 'persist-1', ' world', false);

      expect(remoteSessionStore.getMessages('s1')).toHaveLength(0);
      expect(notify).not.toHaveBeenCalled();

      vi.runOnlyPendingTimers();

      expect(remoteSessionStore.getMessages('s1')).toHaveLength(1);
      expect(remoteSessionStore.getMessages('s1')[0]).toMatchObject({
        id: 'persist-1',
        clientId: 'persist-1',
        role: 'assistant',
        content: 'hello world',
        agentMeta: { isStreaming: true },
      });
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });

  it('treats final text as a complete block and clears streaming at done', () => {
    pushMakerText('s1', 'persist-1', 'hello', false);
    pushMakerText('s1', 'persist-1', 'hello world', true, { model: 'claude' });

    expect(remoteSessionStore.getMessages('s1')).toMatchObject([{
      clientId: 'persist-1',
      content: 'hello world',
      agentMeta: { isStreaming: true, model: 'claude' },
    }]);

    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: { type: 'done', data: {} },
    });

    expect(remoteSessionStore.getMessages('s1')[0].agentMeta).toEqual({ model: 'claude' });
  });

  it('appends a fallback-tail final event to the accumulated streaming text', () => {
    vi.useFakeTimers();
    try {
      pushMakerText('s1', 'persist-1', 'already visible ', false);
      vi.runOnlyPendingTimers();

      pushMakerText('s1', 'persist-1', 'recovered tail', true);

      expect(remoteSessionStore.getMessages('s1')).toMatchObject([{
        clientId: 'persist-1',
        content: 'already visible recovered tail',
        agentMeta: { isStreaming: true },
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits once when done flushes text and closes the running turn', () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    const unsubscribe = remoteSessionStore.subscribe(notify);
    try {
      pushMakerStatus('s1', { isRunning: true });
      notify.mockClear();

      pushMakerText('s1', 'persist-1', 'complete on done', false);
      remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
        sessionId: 's1',
        event: { type: 'done', data: {} },
      });

      expect(notify).toHaveBeenCalledTimes(1);
      expect(remoteSessionStore.getMessages('s1')).toMatchObject([{
        clientId: 'persist-1',
        content: 'complete on done',
        agentMeta: null,
      }]);
      expect(remoteSessionStore.isSessionRunning('s1')).toBe(false);
      expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(false);
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });

  it('replaces the temporary streaming row when the persisted message arrives', () => {
    vi.useFakeTimers();
    try {
      pushMakerText('s1', 'persist-1', 'partial', false);
      vi.runOnlyPendingTimers();

      remoteSessionStore.applyRemotePush('dev-1', 'local-db:messages:created', {
        sessionId: 's1',
        message: {
          id: 'message-1',
          clientId: 'persist-1',
          sessionId: 's1',
          role: 'assistant',
          content: 'partial and complete',
          toolUseId: null,
          agentMeta: { model: 'claude' },
          createdAt: '2026-01-01T00:00:01.000Z',
        },
      });
      vi.runOnlyPendingTimers();

      expect(remoteSessionStore.getMessages('s1')).toMatchObject([{
        id: 'message-1',
        clientId: 'persist-1',
        content: 'partial and complete',
        agentMeta: { model: 'claude' },
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconciles a generated fallback row when DB create has a new identity', () => {
    vi.useFakeTimers();
    try {
      pushMakerText('s1', undefined, 'partial answer', false);
      vi.runOnlyPendingTimers();

      const temporary = remoteSessionStore.getMessages('s1')[0];
      expect(temporary.clientId).toMatch(/^mobile-stream-/);

      remoteSessionStore.applyRemotePush('dev-1', 'local-db:messages:created', {
        sessionId: 's1',
        message: {
          id: 'persisted-1',
          clientId: 'persisted-1',
          sessionId: 's1',
          role: 'assistant',
          content: 'partial answer and complete',
          toolUseId: null,
          agentMeta: null,
          createdAt: '2026-01-01T00:00:01.000Z',
        },
      });

      expect(remoteSessionStore.getMessages('s1')).toMatchObject([{
        id: 'persisted-1',
        clientId: 'persisted-1',
        content: 'partial answer and complete',
        agentMeta: null,
      }]);
      expect(remoteSessionStore.getMessages('s1')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconciles a generated fallback row when history sync is the first DB identity', () => {
    vi.useFakeTimers();
    try {
      pushMakerText('s1', undefined, 'partial answer', false);
      vi.runOnlyPendingTimers();

      remoteSessionStore.setLatestMessageWindow('s1', [{
        id: 'history-persisted-1',
        clientId: 'history-persisted-1',
        sessionId: 's1',
        role: 'assistant',
        content: 'partial answer and complete',
        toolUseId: null,
        agentMeta: null,
        createdAt: '2026-01-01T00:00:01.000Z',
      }]);

      expect(remoteSessionStore.getMessages('s1')).toMatchObject([{
        id: 'history-persisted-1',
        clientId: 'history-persisted-1',
        content: 'partial answer and complete',
      }]);
      expect(remoteSessionStore.getMessages('s1')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retire a generated fallback on a short ambiguous prefix', () => {
    vi.useFakeTimers();
    try {
      pushMakerText('s1', undefined, 'Sure', false);
      vi.runOnlyPendingTimers();

      remoteSessionStore.applyRemotePush('dev-1', 'local-db:messages:created', {
        sessionId: 's1',
        message: {
          id: 'old-persisted-2',
          clientId: 'old-persisted-2',
          sessionId: 's1',
          role: 'assistant',
          content: 'Sure, that was the previous turn',
          toolUseId: null,
          agentMeta: null,
          createdAt: '2026-01-01T00:00:01.000Z',
        },
      });

      expect(remoteSessionStore.getMessages('s1')).toHaveLength(2);
      expect(remoteSessionStore.getMessages('s1').find((row) => row.clientId.startsWith('mobile-stream-'))).toMatchObject({
        content: 'Sure',
        agentMeta: { isStreaming: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not replace a live fallback row with an unrelated delayed DB message', () => {
    vi.useFakeTimers();
    try {
      pushMakerText('s1', undefined, 'new turn partial', false);
      vi.runOnlyPendingTimers();

      remoteSessionStore.applyRemotePush('dev-1', 'local-db:messages:created', {
        sessionId: 's1',
        message: {
          id: 'old-persisted-1',
          clientId: 'old-persisted-1',
          sessionId: 's1',
          role: 'assistant',
          content: 'old turn answer',
          toolUseId: null,
          agentMeta: null,
          createdAt: '2026-01-01T00:00:01.000Z',
        },
      });

      const rows = remoteSessionStore.getMessages('s1');
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.clientId.startsWith('mobile-stream-'))).toMatchObject({
        content: 'new turn partial',
        agentMeta: { isStreaming: true },
      });
      expect(rows.find((row) => row.id === 'old-persisted-1')).toMatchObject({ content: 'old turn answer' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('migrates a fallback streaming row when a later event carries persistId', () => {
    pushMakerText('s1', undefined, 'partial ', false);
    pushMakerText('s1', 'persist-1', 'partial and complete', true);

    expect(remoteSessionStore.getMessages('s1')).toMatchObject([{
      id: 'persist-1',
      clientId: 'persist-1',
      content: 'partial and complete',
      agentMeta: { isStreaming: true },
    }]);
  });

  it('ends the current streaming block at a tool boundary', () => {
    vi.useFakeTimers();
    try {
      pushMakerText('s1', 'persist-1', 'before tool', false);
      remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
        sessionId: 's1',
        event: { type: 'tool_use', data: { toolUseId: 'tool-1' } },
      });

      expect(remoteSessionStore.getMessages('s1')[0].agentMeta).toBeNull();

      pushMakerText('s1', 'persist-2', 'after tool', false);
      vi.runOnlyPendingTimers();
      expect(remoteSessionStore.getMessages('s1')).toMatchObject([
        { clientId: 'persist-1', content: 'before tool', agentMeta: null },
        { clientId: 'persist-2', content: 'after tool', agentMeta: { isStreaming: true } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('finalizes live text on idle recovery and does not erase it from an empty window', () => {
    vi.useFakeTimers();
    try {
      pushMakerText('s1', 'persist-1', 'still streaming', false);
      remoteSessionStore.applyRemotePush('dev-1', 'local-db:sessions:activity', {
        sessionId: 's1',
        phase: 'completed',
        compactDetail: '',
      });
      vi.runOnlyPendingTimers();

      remoteSessionStore.setLatestMessageWindow('s1', []);
      expect(remoteSessionStore.getMessages('s1')).toMatchObject([{
        clientId: 'persist-1',
        content: 'still streaming',
        agentMeta: null,
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('finalizes live text when a reconnect snapshot restores a pending interaction', () => {
    vi.useFakeTimers();
    try {
      pushMakerText('s1', 'persist-1', 'waiting for approval', false);
      vi.runOnlyPendingTimers();

      remoteSessionStore.setPendingInteractions(
        's1',
        [pending('permission', 'req-1')],
        { finalizeStreaming: true },
      );

      expect(remoteSessionStore.getMessages('s1')).toMatchObject([{
        clientId: 'persist-1',
        content: 'waiting for approval',
        agentMeta: null,
      }]);
      expect(remoteSessionStore.getPendingInteractions('s1')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not finalize streaming when the reconnect pending snapshot is empty', () => {
    vi.useFakeTimers();
    try {
      pushMakerText('s1', 'persist-1', 'still generating', false);
      vi.runOnlyPendingTimers();

      remoteSessionStore.setPendingInteractions('s1', [], { finalizeStreaming: true });

      expect(remoteSessionStore.getMessages('s1')).toMatchObject([{
        clientId: 'persist-1',
        content: 'still generating',
        agentMeta: { isStreaming: true },
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('matches persisted rows by clientId without content-prefix guesses', () => {
    vi.useFakeTimers();
    try {
      pushMakerText('s1', 'persist-1', 'partial', false);
      vi.runOnlyPendingTimers();

      remoteSessionStore.setLatestMessageWindow('s1', [{
        ...messageAt('message-1', 's1', '2026-01-01T00:00:01.000Z'),
        clientId: 'persist-1',
        content: 'partial and complete',
        agentMeta: { model: 'claude' },
      }]);

      expect(remoteSessionStore.getMessages('s1')).toMatchObject([{
        id: 'message-1',
        clientId: 'persist-1',
        content: 'partial and complete',
        agentMeta: { model: 'claude' },
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps accumulated text when the final event is device-link truncated', () => {
    pushMakerText('s1', 'persist-1', '前半段', false);
    pushMakerText('s1', 'persist-1', '后半段', false);
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      persistId: 'persist-1',
      event: {
        type: 'text',
        __deviceLinkTruncated: true,
        data: { text: '前半段\n[device-link truncated]', isFinal: true, __deviceLinkTruncated: true },
      },
    });

    expect(remoteSessionStore.getMessages('s1')[0]).toMatchObject({
      content: '前半段后半段',
      agentMeta: { isStreaming: true },
    });
  });

  it('applies live update_plan snapshots to the persisted task row', () => {
    const initialPlan = {
      ...message('plan-row-1', 's1'),
      role: 'tool_use' as const,
      toolUseId: 'plan:turn-1',
      content: {
        toolUseId: 'plan:turn-1',
        toolName: 'update_plan',
        input: {
          plan: [
            { step: 'Inspect', status: 'in_progress' },
            { step: 'Patch', status: 'pending' },
          ],
        },
      },
    };
    remoteSessionStore.setMessages('s1', [initialPlan]);

    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      persistId: 'plan-row-1',
      event: {
        type: 'tool_use',
        data: {
          toolUseId: 'plan:turn-1',
          toolName: 'update_plan',
          input: {
            plan: [
              { step: 'Inspect', status: 'completed' },
              { step: 'Patch', status: 'completed' },
            ],
          },
        },
      },
    });

    expect(remoteSessionStore.getMessages('s1')).toHaveLength(1);
    expect(remoteSessionStore.getMessages('s1')[0]).toMatchObject({
      id: 'plan-row-1',
      toolUseId: 'plan:turn-1',
      content: {
        toolUseId: 'plan:turn-1',
        toolName: 'update_plan',
        input: {
          plan: [
            { step: 'Inspect', status: 'completed' },
            { step: 'Patch', status: 'completed' },
          ],
        },
      },
    });
  });

  it('stamps the turn plan as failed on a codex terminal error, through live-plan overlays', () => {
    // 没有 done 的 codex 终态 error:这一轮的计划行等不到章。手机端要自己补失败
    // 印记,否则全勾完的失败计划按旧数据兜底退场;而印记只写内存行、不写 live
    // 缓存时,overlay 会用旧缓存把 main 随后广播的落库印记盖回去(review P1)。
    const planRow = {
      ...message('plan-row-1', 's1'),
      role: 'tool_use' as const,
      toolUseId: 'plan:turn-err',
      content: {
        toolUseId: 'plan:turn-err',
        toolName: 'update_plan',
        input: { plan: [{ step: 'Ship', status: 'completed' }] },
      },
    };
    remoteSessionStore.setMessages('s1', [planRow]);
    // 先按真实链路让 live 缓存记住这一行(update_plan 推送)。
    remoteSessionStore.applyMakerEvent('s1', {
      type: 'tool_use',
      data: {
        toolUseId: 'plan:turn-err',
        toolName: 'update_plan',
        input: { plan: [{ step: 'Ship', status: 'completed' }] },
      },
    }, 'plan-row-1');

    remoteSessionStore.applyMakerEvent('s1', {
      type: 'error',
      source: 'codex',
      data: { message: 'stream disconnected' },
    });

    expect(remoteSessionStore.getMessages('s1')[0]).toMatchObject({
      content: {
        turnCompleted: false,
        input: { plan: [{ step: 'Ship', status: 'completed' }] },
      },
    });

    // main 落库前的行重新到达(无印记):overlay 用 live 缓存覆盖 content,
    // 缓存已带印记 → 不回退成"已完成的旧计划"。
    remoteSessionStore.mergeMessages('s1', [planRow]);
    expect(remoteSessionStore.getMessages('s1')[0]).toMatchObject({
      content: { turnCompleted: false },
    });
  });

  it('coalesces update_plan with streaming finalization into one notification', () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    try {
      remoteSessionStore.setMessages('s1', [{
        ...message('plan-row-1', 's1'),
        role: 'tool_use',
        toolUseId: 'plan:turn-1',
        content: {
          toolUseId: 'plan:turn-1',
          toolName: 'update_plan',
          input: { plan: [{ step: 'Inspect', status: 'pending' }] },
        },
      }]);
      pushMakerText('s1', 'assistant-1', 'before plan', false);
      vi.runOnlyPendingTimers();
      const unsubscribe = remoteSessionStore.subscribe(notify);
      try {
        remoteSessionStore.applyMakerEvent('s1', {
          type: 'tool_use',
          data: {
            toolUseId: 'plan:turn-1',
            toolName: 'update_plan',
            input: { plan: [{ step: 'Inspect', status: 'completed' }] },
          },
        }, 'plan-row-1');
      } finally {
        unsubscribe();
      }

      expect(notify).toHaveBeenCalledTimes(1);
      const rows = remoteSessionStore.getMessages('s1');
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.clientId === 'assistant-1')).toMatchObject({ agentMeta: null });
      expect(rows.find((row) => row.id === 'plan-row-1')).toMatchObject({
        content: {
          input: { plan: [{ step: 'Inspect', status: 'completed' }] },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the stable update_plan toolUseId when a live push has no persistId', () => {
    remoteSessionStore.setMessages('s1', [{
      ...message('plan-row-1', 's1'),
      role: 'tool_use',
      toolUseId: 'plan:turn-1',
      content: {
        toolUseId: 'plan:turn-1',
        toolName: 'update_plan',
        input: { plan: [{ step: 'Inspect', status: 'pending' }] },
      },
    }]);

    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: {
        type: 'tool_use',
        data: {
          toolUseId: 'plan:turn-1',
          toolName: 'update_plan',
          input: { plan: [{ step: 'Inspect', status: 'completed' }] },
        },
      },
    });

    expect(remoteSessionStore.getMessages('s1')[0].content).toMatchObject({
      input: { plan: [{ step: 'Inspect', status: 'completed' }] },
    });
  });

  it('keeps the latest live update_plan snapshot when the initial DB row arrives later', () => {
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      persistId: 'plan-row-1',
      event: {
        type: 'tool_use',
        data: {
          toolUseId: 'plan:turn-1',
          toolName: 'update_plan',
          input: { plan: [{ step: 'Inspect', status: 'completed' }] },
        },
      },
    });
    expect(remoteSessionStore.getMessages('s1')).toHaveLength(0);

    remoteSessionStore.applyRemotePush('dev-1', 'local-db:messages:created', {
      sessionId: 's1',
      message: {
        ...message('plan-row-1', 's1'),
        role: 'tool_use',
        toolUseId: 'plan:turn-1',
        content: {
          toolUseId: 'plan:turn-1',
          toolName: 'update_plan',
          input: { plan: [{ step: 'Inspect', status: 'pending' }] },
        },
      },
    });

    expect(remoteSessionStore.getMessages('s1')[0].content).toMatchObject({
      input: { plan: [{ step: 'Inspect', status: 'completed' }] },
    });
  });

  it('keeps the honest live snapshot when done precedes the initial plan DB row', () => {
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      persistId: 'plan-row-1',
      event: {
        type: 'tool_use',
        data: {
          toolUseId: 'plan:turn-1',
          toolName: 'update_plan',
          input: {
            plan: [
              { step: 'Inspect', status: 'in_progress' },
              { step: 'Patch', status: 'pending' },
            ],
          },
        },
      },
    });
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: {
        type: 'done',
        source: 'codex',
        data: {
          raw: { id: 'turn-1', status: 'completed' },
          plan: [
            { step: 'Inspect', status: 'in_progress' },
            { step: 'Patch', status: 'pending' },
          ],
        },
      },
    });

    remoteSessionStore.applyRemotePush('dev-1', 'local-db:messages:created', {
      sessionId: 's1',
      message: {
        ...message('plan-row-1', 's1'),
        role: 'tool_use',
        toolUseId: 'plan:turn-1',
        content: {
          toolUseId: 'plan:turn-1',
          toolName: 'update_plan',
          input: {
            plan: [
              { step: 'Inspect', status: 'in_progress' },
              { step: 'Patch', status: 'pending' },
            ],
          },
        },
      },
    });

    // 成功收尾封的是生命周期,不改步骤事实:agent 报告什么就显示什么,
    // 晚到的 DB 行也不能把 live 快照拉回更旧的内容。
    expect(remoteSessionStore.getMessages('s1')[0].content).toMatchObject({
      input: {
        plan: [
          { step: 'Inspect', status: 'in_progress' },
          { step: 'Patch', status: 'pending' },
        ],
      },
    });
  });

  it('does not let a delayed message window revert the live plan snapshot', () => {
    const stalePlanRow = {
      ...message('plan-row-1', 's1'),
      role: 'tool_use' as const,
      toolUseId: 'plan:turn-1',
      content: {
        toolUseId: 'plan:turn-1',
        toolName: 'update_plan',
        input: { plan: [{ step: 'Inspect', status: 'in_progress' }] },
      },
    };
    remoteSessionStore.setMessages('s1', [stalePlanRow]);
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      persistId: 'plan-row-1',
      event: {
        type: 'tool_use',
        data: {
          toolUseId: 'plan:turn-1',
          toolName: 'update_plan',
          input: { plan: [{ step: 'Inspect', status: 'in_progress' }] },
        },
      },
    });
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: {
        type: 'done',
        source: 'codex',
        data: {
          raw: { id: 'turn-1', status: 'completed' },
          plan: [{ step: 'Inspect', status: 'in_progress' }],
        },
      },
    });

    remoteSessionStore.setLatestMessageWindow('s1', [stalePlanRow]);

    // 步骤保持 agent 实际报告的状态,不因成功收尾被改写成 completed。
    expect(remoteSessionStore.getMessages('s1')[0].content).toMatchObject({
      input: { plan: [{ step: 'Inspect', status: 'in_progress' }] },
    });
  });

  it('finalizes pre-compact streaming rows and de-duplicates the same boundary replay', () => {
    vi.useFakeTimers();
    try {
      remoteSessionStore.setMessages('s1', [{
        ...messageAt('before-compact', 's1', '2026-01-01T00:00:01.000Z'),
        content: { text: 'before', isStreaming: true, streaming: true },
        agentMeta: { isStreaming: true, streaming: true },
      }]);
      vi.setSystemTime(new Date('2026-01-01T00:00:10.000Z'));
      remoteSessionStore.applyMakerEvent('s1', {
        type: 'compact_boundary',
        data: { boundaryId: 'compact-1', trigger: 'auto' },
      });

      const afterBoundary = remoteSessionStore.getMessages('s1');
      expect(afterBoundary).toHaveLength(2);
      expect(afterBoundary[0]).toMatchObject({
        id: 'before-compact',
        agentMeta: { isStreaming: false, streaming: false },
        content: { text: 'before', isStreaming: false, streaming: false },
      });
      expect(afterBoundary[1]).toMatchObject({
        id: 'mobile-system-compact:compact-1',
        systemCardType: 'compact',
        systemCardData: { boundaryId: 'compact-1', trigger: 'auto' },
      });

      remoteSessionStore.appendMessage('s1', {
        ...messageAt('after-compact', 's1', '2026-01-01T00:00:11.000Z'),
        agentMeta: { isStreaming: true },
      });
      const versionBeforeReplay = remoteSessionStore.getMessageVersion();
      remoteSessionStore.applyMakerEvent('s1', {
        type: 'compact_boundary',
        data: { boundaryId: 'compact-1', trigger: 'auto' },
      });

      const afterReplay = remoteSessionStore.getMessages('s1');
      expect(afterReplay).toHaveLength(3);
      expect(afterReplay.find((item) => item.id === 'after-compact')?.agentMeta?.isStreaming).toBe(true);
      expect(remoteSessionStore.getMessageVersion()).toBe(versionBeforeReplay);
    } finally {
      vi.useRealTimers();
    }
  });

  it('de-duplicates a replayed id-less compact boundary before it can end newer work', () => {
    const firstData = { trigger: 'auto', preTokens: 100, postTokens: 20, durationMs: 50 };
    remoteSessionStore.setMessages('s1', [{
      ...messageAt('before-compact', 's1', '2026-01-01T00:00:01.000Z'),
      agentMeta: { isStreaming: true },
    }]);
    remoteSessionStore.applyMakerEvent('s1', { type: 'compact_boundary', data: firstData });
    remoteSessionStore.appendMessage('s1', {
      ...messageAt('after-compact', 's1', '2026-01-01T00:00:02.000Z'),
      agentMeta: { isStreaming: true },
    });
    const versionBeforeReplay = remoteSessionStore.getMessageVersion();

    // 相同数据换 key 顺序，仍应映射到同一个 canonical fallback identity。
    remoteSessionStore.applyMakerEvent('s1', {
      type: 'compact_boundary',
      data: { durationMs: 50, postTokens: 20, preTokens: 100, trigger: 'auto' },
    });

    const afterReplay = remoteSessionStore.getMessages('s1');
    expect(afterReplay.filter((item) => item.systemCardType === 'compact')).toHaveLength(1);
    expect(afterReplay.find((item) => item.id === 'after-compact')?.agentMeta?.isStreaming).toBe(true);
    expect(remoteSessionStore.getMessageVersion()).toBe(versionBeforeReplay);

    remoteSessionStore.applyMakerEvent('s1', {
      type: 'compact_boundary',
      data: { ...firstData, preTokens: 180 },
    });
    const afterDistinctBoundary = remoteSessionStore.getMessages('s1');
    expect(afterDistinctBoundary.filter((item) => item.systemCardType === 'compact')).toHaveLength(2);
    expect(afterDistinctBoundary.find((item) => item.id === 'after-compact')?.agentMeta?.isStreaming).toBe(false);
  });

  it('treats a new compact boundary as the end of the current post-compact activity segment', () => {
    vi.useFakeTimers();
    try {
      remoteSessionStore.setMessages('s1', [{
        ...messageAt('active-1', 's1', '2026-01-01T00:00:01.000Z'),
        agentMeta: { isStreaming: true },
      }]);
      vi.setSystemTime(new Date('2026-01-01T00:00:10.000Z'));
      remoteSessionStore.applyMakerEvent('s1', {
        type: 'compact_boundary',
        data: { boundaryId: 'compact-1' },
      });
      remoteSessionStore.appendMessage('s1', {
        ...messageAt('active-2', 's1', '2026-01-01T00:00:11.000Z'),
        agentMeta: { isStreaming: true },
      });

      vi.setSystemTime(new Date('2026-01-01T00:00:12.000Z'));
      remoteSessionStore.applyMakerEvent('s1', {
        type: 'compact_boundary',
        data: { boundaryId: 'compact-2' },
      });

      const stored = remoteSessionStore.getMessages('s1');
      expect(stored.filter((item) => item.systemCardType === 'compact').map((item) => item.id)).toEqual([
        'mobile-system-compact:compact-1',
        'mobile-system-compact:compact-2',
      ]);
      expect(stored.find((item) => item.id === 'active-2')?.agentMeta?.isStreaming).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not finish a live turn when a background compact_boundary arrives', () => {
    remoteSessionStore.setMessages('s1', [{
      ...messageAt('live-after-idle-compact', 's1', '2026-01-01T00:00:01.000Z'),
      content: { text: '正在回答', isStreaming: true, streaming: true },
      agentMeta: { isStreaming: true, streaming: true },
    }]);
    remoteSessionStore.applyMakerEvent('s1', {
      type: 'compact_boundary',
      turnScope: 'background',
      data: { boundaryId: 'idle-compact', trigger: 'auto' },
    });

    const stored = remoteSessionStore.getMessages('s1');
    expect(stored.find((item) => item.id === 'live-after-idle-compact')).toMatchObject({
      agentMeta: { isStreaming: true, streaming: true },
      content: { text: '正在回答', isStreaming: true, streaming: true },
    });
    expect(stored.at(-1)).toMatchObject({
      id: 'mobile-system-compact:idle-compact',
      systemCardType: 'compact',
    });
  });

  it('does not flip product isRunning for background compact status', () => {
    remoteSessionStore.applyMakerEvent('s1', {
      type: 'status',
      data: { isRunning: true, status: 'Thinking…', tokenUsage: 80 },
    });
    expect(remoteSessionStore.getSessionRunStatus('s1').isRunning).toBe(true);
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(true);

    remoteSessionStore.applyMakerEvent('s1', {
      type: 'status',
      turnScope: 'background',
      data: { isRunning: true, status: 'Compacting context…' },
    });
    expect(remoteSessionStore.getSessionRunStatus('s1')).toMatchObject({
      isRunning: true,
      status: 'Compacting context…',
      tokenUsage: 80,
    });
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(true);

    remoteSessionStore.applyMakerEvent('s1', {
      type: 'status',
      turnScope: 'background',
      data: { isRunning: false, status: 'Done' },
    });
    expect(remoteSessionStore.getSessionRunStatus('s1')).toMatchObject({
      isRunning: true,
      status: 'Compacting context…',
    });
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(true);
  });

  it('increments message version when searchable message windows change', () => {
    const initialVersion = remoteSessionStore.getMessageVersion();
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    remoteSessionStore.setMessages('s1', [message('m1', 's1')]);
    expect(remoteSessionStore.getMessageVersion()).toBeGreaterThan(initialVersion);

    const versionAfterSet = remoteSessionStore.getMessageVersion();
    remoteSessionStore.appendMessage('s1', message('m2', 's1'));
    expect(remoteSessionStore.getMessageVersion()).toBeGreaterThan(versionAfterSet);

    const versionAfterAppend = remoteSessionStore.getMessageVersion();
    remoteSessionStore.removeDevice('dev-1');
    expect(remoteSessionStore.getMessageVersion()).toBeGreaterThan(versionAfterAppend);
  });

  it('tracks which session metadata the message window has been synced against', () => {
    const meta = session('s1', {
      updatedAt: '2026-01-01T00:00:01.000Z',
      _count: { messages: 2 },
    });
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [meta]);

    expect(remoteSessionStore.isSessionMessageWindowSynced('s1', meta)).toBe(false);

    remoteSessionStore.markSessionMessagesSynced('s1', meta);
    expect(remoteSessionStore.isSessionMessageWindowSynced('s1', meta)).toBe(true);
    expect(remoteSessionStore.isSessionMessageWindowSynced('s1', {
      ...meta,
      updatedAt: '2026-01-01T00:00:02.000Z',
    })).toBe(false);
    expect(remoteSessionStore.isSessionMessageWindowSynced('s1', {
      ...meta,
      _count: { messages: 3 },
    })).toBe(false);

    remoteSessionStore.removeDevice('dev-1');
    expect(remoteSessionStore.isSessionMessageWindowSynced('s1', meta)).toBe(false);
  });

  it('appends local mobile system cards as transient messages', () => {
    const id = remoteSessionStore.appendLocalSystemCard(
      's1',
      'pwd',
      { workingDir: '/repo' },
      new Date('2026-01-01T00:00:01.000Z'),
    );

    expect(remoteSessionStore.getMessages('s1')).toEqual([
      expect.objectContaining({
        id,
        clientId: id,
        role: 'system',
        systemCardType: 'pwd',
        systemCardData: { workingDir: '/repo' },
        createdAt: '2026-01-01T00:00:01.000Z',
      }),
    ]);
  });

  it('merges reloaded history without dropping live-pushed messages', () => {
    remoteSessionStore.setMessages('s1', [
      messageAt('m1', 's1', '2026-01-01T00:00:01.000Z'),
      messageAt('m3', 's1', '2026-01-01T00:00:03.000Z'),
    ]);

    remoteSessionStore.mergeMessages('s1', [
      messageAt('m1', 's1', '2026-01-01T00:00:01.000Z'),
      messageAt('m2', 's1', '2026-01-01T00:00:02.000Z'),
    ]);

    expect(remoteSessionStore.getMessages('s1').map((item) => item.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('replaces a stale cached window when syncing a non-overlapping latest page', () => {
    remoteSessionStore.setMessages('s1', [
      messageAt('old-1', 's1', '2026-01-01T00:00:01.000Z'),
      messageAt('old-2', 's1', '2026-01-01T00:00:02.000Z'),
    ]);

    remoteSessionStore.setLatestMessageWindow('s1', [
      messageAt('latest-1', 's1', '2026-01-01T10:00:01.000Z'),
      messageAt('latest-2', 's1', '2026-01-01T10:00:02.000Z'),
    ]);

    expect(remoteSessionStore.getMessages('s1').map((item) => item.id)).toEqual(['latest-1', 'latest-2']);
  });

  it('keeps live-pushed tail messages when a latest-page sync resolves late', () => {
    remoteSessionStore.setMessages('s1', [
      messageAt('old-1', 's1', '2026-01-01T00:00:01.000Z'),
      messageAt('live-1', 's1', '2026-01-01T10:00:03.000Z'),
    ]);

    remoteSessionStore.setLatestMessageWindow('s1', [
      messageAt('latest-1', 's1', '2026-01-01T10:00:01.000Z'),
      messageAt('latest-2', 's1', '2026-01-01T10:00:02.000Z'),
    ]);

    expect(remoteSessionStore.getMessages('s1').map((item) => item.id)).toEqual([
      'latest-1',
      'latest-2',
      'live-1',
    ]);
  });

  it('keeps a same-timestamp live tail with a larger host rowid', () => {
    const createdAt = '2026-01-01T10:00:02.000Z';
    remoteSessionStore.setMessages('s1', [
      { ...messageAt('old-1', 's1', '2026-01-01T00:00:01.000Z'), rowid: 1 },
      { ...messageAt('live-3', 's1', createdAt), rowid: 3 },
    ]);

    remoteSessionStore.setLatestMessageWindow('s1', [
      { ...messageAt('latest-1', 's1', '2026-01-01T10:00:01.000Z'), rowid: 1 },
      { ...messageAt('latest-2', 's1', createdAt), rowid: 2 },
    ]);

    expect(remoteSessionStore.getMessages('s1').map((item) => item.id)).toEqual([
      'latest-1',
      'latest-2',
      'live-3',
    ]);
  });

  it('keeps a same-timestamp pending live assistant during latest-window reconciliation', () => {
    vi.useFakeTimers();
    try {
      const createdAt = '2026-01-01T10:00:02.000Z';
      pushMakerText('s1', 'live-3', 'still streaming', false);
      vi.runOnlyPendingTimers();
      remoteSessionStore.setMessages('s1', remoteSessionStore.getMessages('s1').map((item) => ({
        ...item,
        createdAt,
      })));

      remoteSessionStore.setLatestMessageWindow('s1', [
        { ...messageAt('latest-1', 's1', '2026-01-01T10:00:01.000Z'), rowid: 1 },
        { ...messageAt('latest-2', 's1', createdAt), rowid: 2 },
      ]);

      const rows = remoteSessionStore.getMessages('s1');
      expect(rows.map((item) => item.id)).toEqual([
        'latest-1',
        'live-3',
        'latest-2',
      ]);
      expect(rows.find((item) => item.clientId === 'live-3')).toMatchObject({
        content: 'still streaming',
        agentMeta: { isStreaming: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('丢弃无法确认相接的更早缓存段：本页上沿之外服务端还有历史时（#1222）', () => {
    // 「有交集」不等于「连续」:交集只说明两段有共同的行,不排除更早那一段与本页之间还隔着
    // 服务端仍有、本地从未加载的行。断连期间漏收几十上百条 push 时就是这样,而漏收的量不大时
    // 两侧时间差很小 —— 时间阈值的空洞检测发现不了,窗口会静默留下孤岛。
    // moreBeyondWindow(本页满页 / 被裁行)为真时,更早的缓存段一律丢弃,窗口保持连续区间。
    // 用冷开缓存入口种入:它刻意不登记「已验证连续」,正是"来源不明"的那类段。
    remoteSessionStore.hydrateMessagesIfEmpty('s1', [
      messageAt('cached-old', 's1', '2026-01-01T00:00:01.000Z'),
      messageAt('latest-1', 's1', '2026-01-01T10:00:01.000Z'),
    ]);

    remoteSessionStore.setLatestMessageWindow('s1', [
      messageAt('latest-1', 's1', '2026-01-01T10:00:01.000Z'),
      messageAt('latest-2', 's1', '2026-01-01T10:00:02.000Z'),
    ], { moreBeyondWindow: true });

    expect(remoteSessionStore.getMessages('s1').map((item) => item.id)).toEqual([
      'latest-1',
      'latest-2',
    ]);
  });

  it('用户「加载更早」翻出来的历史在满页重连时保留（已验证连续）', () => {
    // 回归(#1210 review):只凭"最新页满页"就清空更早的行,会把用户一路翻出来的历史与滚动锚点
    // 一起丢掉,而且补齐也不会拉回(裁完窗口里已没有内部跳变可发现)。「加载更早」是沿 before 从
    // 窗口最旧端连续取的,登记进已验证连续区间后必须保住。
    remoteSessionStore.setMessages('s1', [
      messageAt('latest-1', 's1', '2026-01-01T10:00:01.000Z'),
    ]);
    remoteSessionStore.mergeEarlierMessages('s1', [
      messageAt('earlier-1', 's1', '2026-01-01T09:00:01.000Z'),
      messageAt('earlier-2', 's1', '2026-01-01T09:30:01.000Z'),
    ]);

    // 断连重连:最新快照恰好满页 → moreBeyondWindow=true,但这些行在已验证区间内。
    remoteSessionStore.setLatestMessageWindow('s1', [
      messageAt('latest-1', 's1', '2026-01-01T10:00:01.000Z'),
      messageAt('latest-2', 's1', '2026-01-01T10:00:02.000Z'),
    ], { moreBeyondWindow: true });

    expect(remoteSessionStore.getMessages('s1').map((item) => item.id)).toEqual([
      'earlier-1',
      'earlier-2',
      'latest-1',
      'latest-2',
    ]);
  });

  it('断流后先到的一条 push 不能让旧段继续被连续性结论背书（#1210 review）', () => {
    // 只记「下界」时,它断言的是"从下界到**窗口最新端**连续"——而窗口最新端会被断流期间漏收的行
    // 悄悄作废:旧窗 09:00 那两行,掉线期间服务端产出一大段(本端全漏),重连后先到一条尾部 push,
    // 于是"有交集"仅靠这条 push 成立,旧下界却还在背书,窗口重新变成孤岛(而这些行若在半小时内
    // 产生,自动探测也发现不了)。上界显式记下来后,"接不上"就是一次比较。
    remoteSessionStore.setMessages('s1', [
      messageAt('old-1', 's1', '2026-01-01T09:00:01.000Z'),
      messageAt('old-2', 's1', '2026-01-01T09:00:02.000Z'),
    ]);
    remoteSessionStore.noteLiveStreamInterrupted();
    remoteSessionStore.appendMessage('s1', messageAt('resumed-tail', 's1', '2026-01-01T10:00:09.000Z'));

    remoteSessionStore.setLatestMessageWindow('s1', [
      messageAt('gap-tail', 's1', '2026-01-01T10:00:08.000Z'),
      messageAt('resumed-tail', 's1', '2026-01-01T10:00:09.000Z'),
    ], { moreBeyondWindow: true });

    expect(remoteSessionStore.getMessages('s1').map((item) => item.id)).toEqual([
      'gap-tail',
      'resumed-tail',
    ]);
  });

  it('订阅未断时实时 push 推进上界，涨过一页后满页刷新仍保留更早的已验证历史', () => {
    // 上一条的反面:订阅已 ACK、又没断流时,推送是顺序且完整的,窗口从下界一直连续到最新那条
    // push。这时最新页只回尾段(会话已涨过一页)不代表更早的行来源不明——收紧过头会在活跃会话里
    // 反复清空历史。
    remoteSessionStore.noteLiveStreamAcked('s1');
    remoteSessionStore.setMessages('s1', [
      messageAt('a1', 's1', '2026-01-01T09:00:01.000Z'),
      messageAt('a2', 's1', '2026-01-01T09:00:02.000Z'),
    ]);
    remoteSessionStore.appendMessage('s1', messageAt('live-1', 's1', '2026-01-01T09:30:00.000Z'));
    remoteSessionStore.appendMessage('s1', messageAt('live-2', 's1', '2026-01-01T09:30:01.000Z'));

    remoteSessionStore.setLatestMessageWindow('s1', [
      messageAt('live-1', 's1', '2026-01-01T09:30:00.000Z'),
      messageAt('live-2', 's1', '2026-01-01T09:30:01.000Z'),
    ], { moreBeyondWindow: true });

    expect(remoteSessionStore.getMessages('s1').map((item) => item.id)).toEqual([
      'a1',
      'a2',
      'live-1',
      'live-2',
    ]);
  });

  it('断流只作用于被中断的会话（退后台释放的是各自的 session 订阅）', () => {
    remoteSessionStore.noteLiveStreamAcked('s1');
    remoteSessionStore.noteLiveStreamAcked('s2');
    remoteSessionStore.setMessages('s1', [messageAt('a1', 's1', '2026-01-01T09:00:01.000Z')]);
    // 另一个会话的订阅被释放,不能顺带作废 s1 的上界。
    remoteSessionStore.noteLiveStreamInterrupted('s2');
    remoteSessionStore.appendMessage('s1', messageAt('live-1', 's1', '2026-01-01T09:30:00.000Z'));

    remoteSessionStore.setLatestMessageWindow('s1', [
      messageAt('live-1', 's1', '2026-01-01T09:30:00.000Z'),
    ], { moreBeyondWindow: true });

    expect(remoteSessionStore.getMessages('s1').map((item) => item.id)).toEqual(['a1', 'live-1']);
  });

  it('最新页与缓存逐行相同时也登记连续性（#1210 review）', () => {
    // 冷开缓存恰好等于服务端最新页是常态。相等早退发生在记账之前时,这次权威响应白来:之后
    // 会话靠 push 涨过一页、再遇一次满页重连刷新,这些**已被权威页确认过**的行会被当成来源不明
    // 全部丢弃,用户当前历史与滚动位置随之消失。
    remoteSessionStore.noteLiveStreamAcked('s1');
    remoteSessionStore.hydrateMessagesIfEmpty('s1', [
      messageAt('c1', 's1', '2026-01-01T09:00:01.000Z'),
      messageAt('c2', 's1', '2026-01-01T09:00:02.000Z'),
    ]);
    remoteSessionStore.setLatestMessageWindow('s1', [
      messageAt('c1', 's1', '2026-01-01T09:00:01.000Z'),
      messageAt('c2', 's1', '2026-01-01T09:00:02.000Z'),
    ]);
    remoteSessionStore.appendMessage('s1', messageAt('live-1', 's1', '2026-01-01T09:30:00.000Z'));

    remoteSessionStore.setLatestMessageWindow('s1', [
      messageAt('live-1', 's1', '2026-01-01T09:30:00.000Z'),
    ], { moreBeyondWindow: true });

    expect(remoteSessionStore.getMessages('s1').map((item) => item.id)).toEqual(['c1', 'c2', 'live-1']);
  });

  it('整窗替换与缓存逐行相同时也登记连续性', () => {
    // setMessages 的相等早退同理:两条路径的记账必须一致,否则走哪条入口决定历史保不保得住。
    remoteSessionStore.noteLiveStreamAcked('s1');
    remoteSessionStore.hydrateMessagesIfEmpty('s1', [
      messageAt('c1', 's1', '2026-01-01T09:00:01.000Z'),
      messageAt('c2', 's1', '2026-01-01T09:00:02.000Z'),
    ]);
    remoteSessionStore.setMessages('s1', [
      messageAt('c1', 's1', '2026-01-01T09:00:01.000Z'),
      messageAt('c2', 's1', '2026-01-01T09:00:02.000Z'),
    ]);
    remoteSessionStore.appendMessage('s1', messageAt('live-1', 's1', '2026-01-01T09:30:00.000Z'));

    remoteSessionStore.setLatestMessageWindow('s1', [
      messageAt('live-1', 's1', '2026-01-01T09:30:00.000Z'),
    ], { moreBeyondWindow: true });

    expect(remoteSessionStore.getMessages('s1').map((item) => item.id)).toEqual(['c1', 'c2', 'live-1']);
  });

  it('订阅 ACK 之前落库的权威页，尾部不算可信（#1210 review）', () => {
    // 屏幕侧的 openAndSubscribe / startFocusedTopicSubscription 都是 `void subscribe(...)`,不等
    // ACK 就拉页(订阅只管之后的推送,不该挡数据读),所以"页比订阅先到"是常态。这个空窗里被控端
    // 写下的行既不在这一页、也不会被推过来;若这时仍把尾部标成可信,之后一条 push 就会把上界抬过
    // 那几行,而等尾部涨过一页后最新页已不含它们,事实自检也发现不了 —— 孤岛就此固化下来。
    remoteSessionStore.setMessages('s1', [
      messageAt('a1', 's1', '2026-01-01T09:00:01.000Z'),
      messageAt('a2', 's1', '2026-01-01T09:00:02.000Z'),
    ]);
    // 空窗里服务端写了 m81/m82(本端全没收到);订阅生效后才收到更新的这一条。
    remoteSessionStore.noteLiveStreamAcked('s1');
    remoteSessionStore.appendMessage('s1', messageAt('live-1', 's1', '2026-01-01T09:30:00.000Z'));

    remoteSessionStore.setLatestMessageWindow('s1', [
      messageAt('live-1', 's1', '2026-01-01T09:30:00.000Z'),
    ], { moreBeyondWindow: true });

    // 上界仍是 09:00:02,接不上 09:30 的页 → a1/a2 丢弃,窗口保持连续。
    expect(remoteSessionStore.getMessages('s1').map((item) => item.id)).toEqual(['live-1']);
  });

  it.each([
    ['socket 掉线（不带 sessionId）', undefined],
    ['退后台释放 / 离开会话（按 sessionId）', 's1'],
  ])('断流时 ACK 记录一并作废：%s', (_label, interruptedSessionId) => {
    // 断流清掉信任位只管**既有**区间;若 ACK 记录还留着,断线后才落库的在途页(请求在断线前发出、
    // 响应迟到)会重新把尾部标成可信,重连后先到的 push 又把上界抬过漏收的行 —— 绕一圈回到同一个
    // 孤岛。生效与失效必须成对。
    remoteSessionStore.noteLiveStreamAcked('s1');
    remoteSessionStore.setMessages('s1', [
      messageAt('a1', 's1', '2026-01-01T09:00:01.000Z'),
      messageAt('a2', 's1', '2026-01-01T09:00:02.000Z'),
    ]);
    remoteSessionStore.noteLiveStreamInterrupted(interruptedSessionId);
    // 断线后才落库的在途页(内容与窗口相同,走相等早退,但记账照做)。
    remoteSessionStore.setMessages('s1', [
      messageAt('a1', 's1', '2026-01-01T09:00:01.000Z'),
      messageAt('a2', 's1', '2026-01-01T09:00:02.000Z'),
    ]);
    remoteSessionStore.appendMessage('s1', messageAt('live-1', 's1', '2026-01-01T09:30:00.000Z'));

    remoteSessionStore.setLatestMessageWindow('s1', [
      messageAt('live-1', 's1', '2026-01-01T09:30:00.000Z'),
    ], { moreBeyondWindow: true });

    expect(remoteSessionStore.getMessages('s1').map((item) => item.id)).toEqual(['live-1']);
  });

  it('最新页在已验证区间内带来窗口没有的行时，旧结论作废', () => {
    // 覆盖区间是对服务端事实的断言,可以被更新的权威页推翻(桌面侧改写历史、迟到落库)。
    // 区间内出现窗口没有的行 → 断言本来就是假的,当次按"未知"处置,不能继续背书更早的段。
    remoteSessionStore.setMessages('s1', [
      messageAt('a1', 's1', '2026-01-01T09:00:01.000Z'),
      messageAt('a3', 's1', '2026-01-01T09:00:03.000Z'),
    ]);

    remoteSessionStore.setLatestMessageWindow('s1', [
      messageAt('a2', 's1', '2026-01-01T09:00:02.000Z'),
      messageAt('a3', 's1', '2026-01-01T09:00:03.000Z'),
      messageAt('a4', 's1', '2026-01-01T09:00:04.000Z'),
    ], { moreBeyondWindow: true });

    expect(remoteSessionStore.getMessages('s1').map((item) => item.id)).toEqual(['a2', 'a3', 'a4']);
  });

  it('断流后到达的 push 不推进上界（本页被裁到只剩那条 push 时，信任位是唯一守卫）', () => {
    // 上界只有在"实时推送链路自它建立以来没断过"时才能被 push 续推:断流期间漏收的行与新到的
    // push 之间可能隔着任意多行,续推等于凭空声明覆盖了它们。
    // 这里刻意把最新页裁到只剩那条 push(device-link payload 超限时的常态,moreBeyondWindow 仍为
    // 真):本页没带来任何"区间内缺失"的行,事实自检无从发现 —— 信任位是这一档唯一的守卫。
    remoteSessionStore.setMessages('s1', [
      messageAt('a1', 's1', '2026-01-01T09:00:01.000Z'),
      messageAt('a2', 's1', '2026-01-01T09:00:02.000Z'),
    ]);
    remoteSessionStore.noteLiveStreamInterrupted('s1');
    // 断线期间服务端还产出了 09:10 / 09:20 等行,本端全漏;重连后先到的是更新的这一条。
    remoteSessionStore.appendMessage('s1', messageAt('resumed', 's1', '2026-01-01T09:30:00.000Z'));

    remoteSessionStore.setLatestMessageWindow('s1', [
      messageAt('resumed', 's1', '2026-01-01T09:30:00.000Z'),
    ], { moreBeyondWindow: true });

    expect(remoteSessionStore.getMessages('s1').map((item) => item.id)).toEqual(['resumed']);
  });

  it('rewind / clear 之后连续性结论失效，来源不明的旧段照旧丢弃', () => {
    // 连续性是对"窗口"的结论:rewind 可能删掉中间的行,不能让旧结论继续背书。
    remoteSessionStore.setMessages('s1', [
      messageAt('latest-1', 's1', '2026-01-01T10:00:01.000Z'),
    ]);
    remoteSessionStore.mergeEarlierMessages('s1', [
      messageAt('earlier-1', 's1', '2026-01-01T09:00:01.000Z'),
    ]);
    // 被控端删除某行 → 窗口连续性结论重置。
    remoteSessionStore.removeMessages('s1', ['latest-1']);

    remoteSessionStore.setLatestMessageWindow('s1', [
      messageAt('latest-2', 's1', '2026-01-01T10:00:02.000Z'),
      messageAt('latest-3', 's1', '2026-01-01T10:00:03.000Z'),
    ], { moreBeyondWindow: true });

    expect(remoteSessionStore.getMessages('s1').map((item) => item.id)).toEqual([
      'latest-2',
      'latest-3',
    ]);
  });

  it('丢弃更早缓存段时仍保留比本页更新的实时 push 行与本地系统卡', () => {
    // 收紧的只是"更早那一段"这一条判据:尾部的 live push 与没有服务端对应行的本地卡不受影响。
    remoteSessionStore.hydrateMessagesIfEmpty('s1', [
      messageAt('cached-old', 's1', '2026-01-01T00:00:01.000Z'),
      messageAt('latest-1', 's1', '2026-01-01T10:00:01.000Z'),
      messageAt('live-tail', 's1', '2026-01-01T10:00:09.000Z'),
      messageAt('mobile-system-pwd-1', 's1', '2026-01-01T00:00:05.000Z'),
    ]);

    remoteSessionStore.setLatestMessageWindow('s1', [
      messageAt('latest-1', 's1', '2026-01-01T10:00:01.000Z'),
      messageAt('latest-2', 's1', '2026-01-01T10:00:02.000Z'),
    ], { moreBeyondWindow: true });

    expect(remoteSessionStore.getMessages('s1').map((item) => item.id)).toEqual([
      'mobile-system-pwd-1',
      'latest-1',
      'latest-2',
      'live-tail',
    ]);
  });

  it('preserves loaded older pages when the refreshed latest page overlaps the current window', () => {
    // 未给 moreBeyondWindow(或为 false)= 本页已到会话起点,不存在中间缺口,旧段可信照旧保留。
    remoteSessionStore.setMessages('s1', [
      messageAt('older-1', 's1', '2026-01-01T00:00:01.000Z'),
      messageAt('latest-1', 's1', '2026-01-01T10:00:01.000Z'),
      messageAt('latest-2', 's1', '2026-01-01T10:00:02.000Z'),
    ]);

    remoteSessionStore.setLatestMessageWindow('s1', [
      messageAt('latest-1', 's1', '2026-01-01T10:00:01.000Z'),
      messageAt('latest-2', 's1', '2026-01-01T10:00:02.000Z'),
      messageAt('latest-3', 's1', '2026-01-01T10:00:03.000Z'),
    ]);

    expect(remoteSessionStore.getMessages('s1').map((item) => item.id)).toEqual([
      'older-1',
      'latest-1',
      'latest-2',
      'latest-3',
    ]);
  });

  it('keeps in-window complete rows when a payload-limited latest sync sends truncated rows', () => {
    // 会话重开路径走 setLatestMessageWindow:实时 push 已拿到完整内容的行,
    // 不能被帧超限刷新(agentMeta.remoteContentTruncated)的占位串覆盖——
    // 窗口内重叠行必须进入截断保护的比较基准(existingByKey)。
    const full = {
      ...messageAt('m1', 's1', '2026-01-01T10:00:01.000Z'),
      content: '完整的长内容',
    };
    const truncated = {
      ...messageAt('m1', 's1', '2026-01-01T10:00:01.000Z'),
      content: '[remote content truncated: payload too large]',
      agentMeta: { remoteContentTruncated: true, agentTaskStatus: 'failed' as const },
    };
    remoteSessionStore.setMessages('s1', [full]);

    remoteSessionStore.setLatestMessageWindow('s1', [
      truncated,
      messageAt('m2', 's1', '2026-01-01T10:00:02.000Z'),
    ]);

    const rows = remoteSessionStore.getMessages('s1');
    expect(rows.map((item) => item.id)).toEqual(['m1', 'm2']);
    expect(rows[0].content).toBe('完整的长内容');
    expect(rows[0].agentMeta?.agentTaskStatus).toBe('failed');
    expect(rows[0].agentMeta?.remoteContentTruncated).not.toBe(true);
  });

  it('does not emit when a reseed returns the same session list or message window', () => {
    const notify = vi.fn();
    const unsubscribe = remoteSessionStore.subscribe(notify);
    try {
      remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
      notify.mockClear();

      remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
      expect(notify).not.toHaveBeenCalled();

      remoteSessionStore.setMessages('s1', [message('m1', 's1')]);
      const versionAfterSet = remoteSessionStore.getMessageVersion();
      notify.mockClear();

      remoteSessionStore.mergeMessages('s1', [message('m1', 's1')]);
      expect(notify).not.toHaveBeenCalled();
      expect(remoteSessionStore.getMessageVersion()).toBe(versionAfterSet);
    } finally {
      unsubscribe();
    }
  });

  it('does not emit when pending interactions or input projection are unchanged', () => {
    const notify = vi.fn();
    const unchangedPending = [pending('permission', 'permission-1')];
    const unchangedProjection = projection('s1');
    const unsubscribe = remoteSessionStore.subscribe(notify);
    try {
      remoteSessionStore.setPendingInteractions('s1', unchangedPending);
      remoteSessionStore.setInputProjection('s1', unchangedProjection);
      notify.mockClear();

      remoteSessionStore.setPendingInteractions('s1', unchangedPending);
      remoteSessionStore.setInputProjection('s1', unchangedProjection);

      expect(notify).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('tracks session running state from active snapshots without clearing other devices', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    remoteSessionStore.setDeviceSessions('dev-2', 'Mac mini', [session('s2')]);

    remoteSessionStore.setActiveSessionSnapshots('dev-1', [{ sessionId: 's1', isTurnRunning: true }]);
    remoteSessionStore.setActiveSessionSnapshots('dev-2', [{ sessionId: 's2', isTurnRunning: true }]);
    expect(remoteSessionStore.isSessionRunning('s1')).toBe(true);
    expect(remoteSessionStore.isSessionRunning('s2')).toBe(true);

    remoteSessionStore.setActiveSessionSnapshots('dev-1', [{ sessionId: 's1', isTurnRunning: false }]);
    expect(remoteSessionStore.isSessionRunning('s1')).toBe(false);
    expect(remoteSessionStore.isSessionRunning('s2')).toBe(true);
  });

  it('does not treat an absent active-session row as an idle assertion', () => {
    vi.useFakeTimers();
    try {
      remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
      pushMakerStatus('s1', { isRunning: true });
      pushMakerText('s1', undefined, 'still generating', false);
      vi.runOnlyPendingTimers();

      // This response may have started before the turn and completed after the
      // live push. Absence must not finalize the current streaming row.
      remoteSessionStore.setActiveSessionSnapshots('dev-1', []);

      expect(remoteSessionStore.isSessionRunning('s1')).toBe(true);
      expect(remoteSessionStore.getMessages('s1')).toMatchObject([{
        content: 'still generating',
        agentMeta: { isStreaming: true },
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears stale reconnect progress from an active snapshot without erasing newer retry events', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: { type: 'error', data: { message: 'Reconnecting... 1/5', willRetry: true } },
    });

    const currentSnapshotEpoch = remoteSessionStore.captureActiveSessionSnapshotEpoch();
    remoteSessionStore.setActiveSessionSnapshots(
      'dev-1',
      [{ sessionId: 's1', isTurnRunning: true }],
      currentSnapshotEpoch,
    );
    expect(remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt).toBeNull();

    const staleSnapshotEpoch = remoteSessionStore.captureActiveSessionSnapshotEpoch();
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: { type: 'error', data: { message: 'Reconnecting... 2/5', willRetry: true } },
    });
    remoteSessionStore.setActiveSessionSnapshots(
      'dev-1',
      [{ sessionId: 's1', isTurnRunning: true }],
      staleSnapshotEpoch,
    );
    expect(remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt).toEqual({
      attempt: 2,
      maxAttempts: 5,
    });
  });

  it('projects the overload auto-retry marker as an overload attempt', () => {
    // 上游过载退避与传输层重连共用同一个 attempt 字段, 但必须能分辨: 不认
    // `(auto-retry N/M)` 的话, 整个退避窗口(最长约 30s)手机端只显示笼统的「思考中」
    // (review #844 codex P1)。
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: {
        type: 'error',
        data: {
          message:
            'Selected model is at capacity. Please try a different model. (auto-retry 2/4)',
          isTerminal: false,
          willRetry: true,
        },
      },
    });
    expect(remoteSessionStore.isSessionRunning('s1')).toBe(true);
    expect(remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt).toEqual({
      attempt: 2,
      maxAttempts: 4,
      kind: 'overload',
    });

    // Claude 侧的 529 走同一后缀。
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: {
        type: 'error',
        data: {
          message: 'SDK API request failed: overloaded (HTTP 529) (auto-retry 3/10)',
          isTerminal: false,
          willRetry: true,
        },
      },
    });
    expect(remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt).toEqual({
      attempt: 3,
      maxAttempts: 10,
      kind: 'overload',
    });

    // 重连仍是老形状(不带 kind), 既有投影与用例不受影响。
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: { type: 'error', data: { message: 'Reconnecting... 1/5', willRetry: true } },
    });
    expect(remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt).toEqual({
      attempt: 1,
      maxAttempts: 5,
    });
  });

  it('projects terminal 429 retries as rate-limit attempts only with their reason', () => {
    const message =
      'exceeded retry limit, last status: 429 Too Many Requests (rate-limit-retry 1/2)';
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: {
        type: 'error',
        data: {
          message,
          reason: 'terminal-rate-limit-retry',
          isTerminal: false,
          willRetry: true,
        },
      },
    });
    expect(remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt).toEqual({
      attempt: 1,
      maxAttempts: 2,
      kind: 'rate-limit',
    });

    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: {
        type: 'error',
        data: { message, isTerminal: false, willRetry: true },
      },
    });
    expect(remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt).toBeNull();

    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: {
        type: 'error',
        data: {
          message: 'provider failed (auto-retry 1/2)',
          reason: 'terminal-rate-limit-retry',
          isTerminal: false,
          willRetry: true,
        },
      },
    });
    expect(remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt).toBeNull();
  });

  it('tracks session running state from maker event push boundaries', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:10.000Z'));
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: { type: 'status', data: { isRunning: true } },
    });
    expect(remoteSessionStore.isSessionRunning('s1')).toBe(true);
    expect(remoteSessionStore.getSessionRunStatus('s1')).toMatchObject({
      isRunning: true,
      startedAt: Date.parse('2026-01-01T00:00:10.000Z'),
      tokenUsage: 0,
    });

    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: { type: 'error', data: { message: 'Reconnecting... 1/5', willRetry: true } },
    });
    expect(remoteSessionStore.isSessionRunning('s1')).toBe(true);
    expect(remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt).toEqual({
      attempt: 1,
      maxAttempts: 5,
    });

    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: {
        type: 'error',
        data: {
          message: 'Reconnecting... 2/5 (stream disconnected before completion)',
          isTerminal: false,
          willRetry: true,
        },
      },
    });
    expect(remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt).toEqual({
      attempt: 2,
      maxAttempts: 5,
    });

    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: { type: 'error', data: { message: 'Waiting before retry', willRetry: true } },
    });
    expect(remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt).toBeNull();

    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: { type: 'error', data: { message: 'Reconnecting... 3/5', willRetry: true } },
    });
    pushMakerText('s1', 'persist-reconnected', 'resumed', false);
    expect(remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt).toBeNull();

    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: { type: 'error', data: { message: 'Reconnecting... 4/5', willRetry: true } },
    });
    remoteSessionStore.applyInteractionRequest('s1', pending('permission', 'permission-1'));
    expect(remoteSessionStore.getSessionRunStatus('s1').reconnectAttempt).toBeNull();

    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: { type: 'error', data: { message: 'Reconnecting... 5/5', willRetry: true } },
    });

    vi.setSystemTime(new Date('2026-01-01T00:00:20.000Z'));
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: { type: 'status', data: { isRunning: true, status: 'Thinking', tokenUsage: 1200 } },
    });
    expect(remoteSessionStore.getSessionRunStatus('s1')).toMatchObject({
      isRunning: true,
      startedAt: Date.parse('2026-01-01T00:00:10.000Z'),
      reconnectAttempt: null,
      status: 'Thinking',
      tokenUsage: 1200,
    });

    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: { type: 'status', data: { isRunning: false } },
    });
    expect(remoteSessionStore.isSessionRunning('s1')).toBe(false);
    expect(remoteSessionStore.getSessionRunStatus('s1')).toMatchObject({
      isRunning: false,
      startedAt: null,
      tokenUsage: 1200,
    });

    vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'));
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: { type: 'status', data: { isRunning: true } },
    });
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: { type: 'done', data: {} },
    });
    expect(remoteSessionStore.isSessionRunning('s1')).toBe(false);
    vi.useRealTimers();
  });

  it('keeps live generation fields from the first post-reconnect status', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    pushMakerStatus('s1', {
      isRunning: true,
      outputTokens: 12,
      generationDurationMs: 400,
      generationActive: true,
      generationReliable: true,
    });
    remoteSessionStore.markDeviceOffline('dev-1');
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(false);

    remoteSessionStore.setActiveSessionSnapshots('dev-1', [{ sessionId: 's1', isTurnRunning: true }]);
    expect(remoteSessionStore.getSessionRunStatus('s1').isRunning).toBe(true);
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(false);

    pushMakerStatus('s1', {
      isRunning: true,
      status: 'Generating...',
      tokenUsage: 235,
      outputTokens: 40,
      generationDurationMs: 800,
      generationActive: true,
      generationReliable: true,
    });
    expect(remoteSessionStore.getSessionRunStatus('s1')).toMatchObject({
      isRunning: true,
      tokenUsage: 235,
      outputTokens: 40,
      generationDurationMs: 800,
      generationActive: true,
      generationReliable: true,
    });
  });

  it('still zeros leftover live metrics when a new turn starts without them', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    pushMakerStatus('s1', {
      isRunning: true,
      outputTokens: 99,
      generationDurationMs: 5_000,
      generationActive: true,
      generationReliable: false,
    });
    pushMakerStatus('s1', { isRunning: false });
    pushMakerStatus('s1', { isRunning: true, status: 'Thinking' });
    expect(remoteSessionStore.getSessionRunStatus('s1')).toMatchObject({
      isRunning: true,
      outputTokens: 0,
      generationDurationMs: 0,
      generationActive: false,
      generationReliable: true,
    });
  });

  it('clears leftover tok/s when activity restores wide running before the next maker status', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    pushMakerStatus('s1', {
      isRunning: true,
      outputTokens: 40,
      generationDurationMs: 800,
      generationActive: true,
      generationReliable: true,
    });
    pushMakerStatus('s1', { isRunning: false });
    expect(remoteSessionStore.getSessionRunStatus('s1').outputTokens).toBe(40);

    remoteSessionStore.applySessionActivity('dev-1', { sessionId: 's1', phase: 'running' });
    expect(remoteSessionStore.getSessionRunStatus('s1')).toMatchObject({
      isRunning: true,
      outputTokens: 0,
      generationDurationMs: 0,
      generationActive: false,
      generationReliable: true,
    });
  });

  it('clears leftover task updates on a real turn start, scoped to that session', () => {
    // Turn 1 on s1 spawns a sub-agent, then the turn ends — the live update lingers.
    pushMakerStatus('s1', { isRunning: true });
    pushMakerTaskUpdate('s1', 'task-old');
    pushMakerTaskUpdate('s2', 'task-other-session');
    pushMakerStatus('s1', { isRunning: false });
    expect(remoteSessionStore.getSessionTaskUpdates('s1').size).toBe(1);

    // A NEW turn on s1 must not resurface turn-1's sub-agent cards; s2 is untouched.
    pushMakerStatus('s1', { isRunning: true });
    expect(remoteSessionStore.getSessionTaskUpdates('s1').size).toBe(0);
    expect(remoteSessionStore.getSessionTaskUpdates('s2').size).toBe(1);

    // Updates pushed within the new turn are kept across same-turn status refreshes.
    pushMakerTaskUpdate('s1', 'task-new');
    pushMakerStatus('s1', { isRunning: true, status: 'Thinking', tokenUsage: 100 });
    expect(remoteSessionStore.getSessionTaskUpdates('s1').size).toBe(1);
    expect([...remoteSessionStore.getSessionTaskUpdates('s1').values()][0]?.taskId).toBe('task-new');
  });

  it('preserves Pi as the source of agent task updates', () => {
    pushMakerTaskUpdate('s1', 'pi-task', { source: 'pi' });
    expect([...remoteSessionStore.getSessionTaskUpdates('s1').values()][0]?.provider).toBe('pi');
  });

  it('sweeps everything on a side-task start too, recalling the worker on its next update', () => {
    // Leftovers from a finished turn: a claude sub-agent, a completed codex worker, and the
    // still-running collab worker (the side task's own subject).
    pushMakerStatus('s1', { isRunning: true });
    pushMakerTaskUpdate('s1', 'claude-leftover', { source: 'claude-code' });
    pushMakerTaskUpdate('s1', 'codex-done-leftover', { source: 'codex', status: 'completed' });
    pushMakerTaskUpdate('s1', 'collab-worker', { source: 'codex' });
    pushMakerStatus('s1', { isRunning: false });

    // A side-task start flips the maker turn boundary true, which OPENS the orphan render
    // gate — so it must sweep like a real turn start (skipTurnReset is no exemption), or
    // the leftovers would replay immediately. Pre-existing entries all leave the visible
    // map (the running worker is parked, not dropped).
    pushMakerStatus('s1', { isRunning: true, skipTurnReset: true });
    expect(remoteSessionStore.getSessionTaskUpdates('s1').size).toBe(0);

    // The live side-task worker pushes its next update — post-boundary evidence — and is
    // recalled; the stale leftovers stay gone.
    pushMakerTaskUpdate('s1', 'collab-worker', { source: 'codex' });
    const visible = remoteSessionStore.getSessionTaskUpdates('s1');
    expect([...new Set([...visible.values()].map((u) => u.taskId))]).toEqual(['collab-worker']);
  });

  it('emits when the maker turn boundary changes even if the broad run status did not', () => {
    // The activity stream opened the broad running flag first (the boundary stays closed —
    // idle-recovery paths may close it but only maker status can open it).
    remoteSessionStore.applyRemotePush('dev-1', 'local-db:sessions:activity', {
      sessionId: 's1',
      phase: 'running',
      compactDetail: '',
    });
    expect(remoteSessionStore.isSessionRunning('s1')).toBe(true);
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(false);

    // The maker status then arrives with nothing new for the broad status object — only
    // the turn boundary flips. Subscribers (the orphan render gate) must still be notified.
    const before = remoteSessionStore.getStoreVersion();
    pushMakerStatus('s1', { isRunning: true });
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(true);
    expect(remoteSessionStore.getStoreVersion()).toBeGreaterThan(before);
  });

  it('parks a running codex worker at turn start and recalls it with merged history on its next update', () => {
    // A collab worker lives in its own codex session across turns; its updates land in the
    // MAIN session's map. A stale "missed terminal, stays running" leftover is indistinguishable
    // from an alive-but-quiet worker, so NO pre-existing entry may render in the new turn —
    // only post-boundary updates count as evidence of life (park, don't drop).
    pushMakerStatus('s1', { isRunning: true });
    pushMakerTaskUpdate('s1', 'claude-subagent', { source: 'claude-code' });
    pushMakerTaskUpdate('s1', 'codex-worker', { source: 'codex', description: 'original prompt' });
    pushMakerTaskUpdate('s1', 'codex-worker-done', { source: 'codex', status: 'completed' });
    pushMakerStatus('s1', { isRunning: false });

    // New turn: nothing pre-existing is visible — the exact card the user reported can no
    // longer replay, no matter how fresh the stale entry looks.
    pushMakerStatus('s1', { isRunning: true });
    expect(remoteSessionStore.getSessionTaskUpdates('s1').size).toBe(0);

    // The worker's next update recalls the parked entry and merges its history: the new
    // update carries no description, yet the original prompt survives.
    pushMakerTaskUpdate('s1', 'codex-worker', { source: 'codex' });
    const visible = remoteSessionStore.getSessionTaskUpdates('s1');
    const recalled = [...visible.values()].find((u) => u.taskId === 'codex-worker');
    expect(recalled?.description).toBe('original prompt');
    expect([...new Set([...visible.values()].map((u) => u.taskId))]).toEqual(['codex-worker']);
  });

  it('still clears stale updates when activity pushes marked the session running first', () => {
    // Leftover from a finished turn.
    pushMakerStatus('s1', { isRunning: true });
    pushMakerTaskUpdate('s1', 'task-old');
    pushMakerStatus('s1', { isRunning: false });

    // Reconnect/foreground path: the lightweight activity push (or active-session snapshot)
    // flips the broad running flag before any maker status event arrives.
    remoteSessionStore.applyRemotePush('dev-1', 'local-db:sessions:activity', {
      sessionId: 's1',
      phase: 'running',
      compactDetail: '…',
    });
    expect(remoteSessionStore.isSessionRunning('s1')).toBe(true);
    // The orphan-render gate must stay closed until the maker turn boundary confirms.
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(false);

    // First maker status still detects the turn start (its own boundary, not the broad
    // flag) and sweeps the stale entries before the orphan gate opens.
    pushMakerStatus('s1', { isRunning: true });
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(true);
    expect(remoteSessionStore.getSessionTaskUpdates('s1').size).toBe(0);
  });

  it('discards a parked worker that crossed a second boundary, while a later update still self-heals', () => {
    pushMakerStatus('s1', { isRunning: true });
    pushMakerTaskUpdate('s1', 'codex-worker', { source: 'codex', description: 'original prompt' });
    pushMakerStatus('s1', { isRunning: false });

    // Boundary 1: parked (invisible). Boundary 2: still no post-boundary update → dropped.
    pushMakerStatus('s1', { isRunning: true });
    pushMakerStatus('s1', { isRunning: false });
    pushMakerStatus('s1', { isRunning: true });
    expect(remoteSessionStore.getSessionTaskUpdates('s1').size).toBe(0);

    // If the task somehow pushes again after being dropped, it rebuilds as a fresh entry
    // (self-healing; the parked history is gone, so no merged description).
    pushMakerTaskUpdate('s1', 'codex-worker', { source: 'codex' });
    const rebuilt = [...remoteSessionStore.getSessionTaskUpdates('s1').values()].find((u) => u.taskId === 'codex-worker');
    expect(rebuilt).toBeDefined();
    expect(rebuilt?.description).toBeUndefined();
  });

  it('closes the maker turn gate from authoritative idle recovery paths', () => {
    // Boundary stuck true: the terminal maker event was missed while backgrounded.
    pushMakerStatus('s1', { isRunning: true });
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(true);

    // (a) completed/error activity push closes the gate.
    remoteSessionStore.applyRemotePush('dev-1', 'local-db:sessions:activity', {
      sessionId: 's1',
      phase: 'completed',
      compactDetail: '',
    });
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(false);

    // (b) an active-session snapshot without the session closes the gate too.
    remoteSessionStore.setDeviceSessions('dev-1', 'MacBook', [session('s1')]);
    pushMakerStatus('s1', { isRunning: true });
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(true);
    remoteSessionStore.setActiveSessionSnapshots('dev-1', [{ sessionId: 's1', isTurnRunning: false }]);
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(false);

    // Neither idle path may OPEN the gate — that stays maker-status-only.
    remoteSessionStore.applyRemotePush('dev-1', 'local-db:sessions:activity', {
      sessionId: 's1',
      phase: 'running',
      compactDetail: '',
    });
    remoteSessionStore.setActiveSessionSnapshots('dev-1', [{ sessionId: 's1', isTurnRunning: true }]);
    expect(remoteSessionStore.isSessionRunning('s1')).toBe(true);
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(false);
  });

  it('closes the maker turn boundary on done and terminal error events', () => {
    pushMakerStatus('s1', { isRunning: true });
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(true);
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: { type: 'done', data: {} },
    });
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(false);
  });

  it('keeps the product turn running across claimed mobile continuation boundaries', () => {
    vi.useFakeTimers();
    try {
      pushMakerStatus('s1', { isRunning: true });
      pushMakerText('s1', 'persist-1', 'first segment', false);
      vi.runOnlyPendingTimers();

      remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
        sessionId: 's1',
        event: {
          type: 'status',
          turnContinuationId: 7,
          data: { isRunning: false, status: 'Done' },
        },
      });
      remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
        sessionId: 's1',
        event: { type: 'done', turnContinuationId: 7, data: {} },
      });

      expect(remoteSessionStore.isSessionRunning('s1')).toBe(true);
      expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(true);
      expect(remoteSessionStore.getSessionRunStatus('s1').startedAt).not.toBeNull();
      expect(remoteSessionStore.getMessages('s1')[0]?.agentMeta?.isStreaming).toBe(true);

      remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
        sessionId: 's1',
        event: { type: 'done', data: {} },
      });

      expect(remoteSessionStore.isSessionRunning('s1')).toBe(false);
      expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(false);
      expect(remoteSessionStore.getMessages('s1')[0]?.agentMeta?.isStreaming).not.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves boundary agent metadata when finalizing a streaming row', () => {
    vi.useFakeTimers();
    try {
      pushMakerText('s1', 'persist-1', 'sub-agent answer', false);
      vi.runOnlyPendingTimers();

      remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
        sessionId: 's1',
        event: {
          type: 'done',
          agentMeta: { parentUuid: 'parent-1', uuid: 'child-1' },
          data: {},
        },
      });

      expect(remoteSessionStore.getMessages('s1')).toMatchObject([{
        clientId: 'persist-1',
        content: 'sub-agent answer',
        agentMeta: { parentUuid: 'parent-1', uuid: 'child-1' },
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stores and clears list-level live activity from the sessions stream', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:10.000Z'));

    remoteSessionStore.applyRemotePush('dev-1', 'local-db:sessions:activity', {
      sessionId: 's1',
      phase: 'running',
      compactDetail: '正在检查失败测试',
    });

    expect(remoteSessionStore.isSessionRunning('s1')).toBe(true);
    expect(remoteSessionStore.getSessionLiveActivity('s1')).toMatchObject({
      sessionId: 's1',
      phase: 'running',
      compactDetail: '正在检查失败测试',
    });
    expect(remoteSessionStore.getSessionRunStatus('s1').startedAt).toBe(
      Date.parse('2026-01-01T00:00:10.000Z'),
    );

    remoteSessionStore.applyRemotePush('dev-1', 'local-db:sessions:activity', {
      sessionId: 's1',
      phase: 'completed',
      compactDetail: '',
    });

    expect(remoteSessionStore.getSessionLiveActivity('s1')).toBeNull();
    expect(remoteSessionStore.isSessionRunning('s1')).toBe(false);
    vi.useRealTimers();
  });

  it('keeps empty snapshots referentially stable for useSyncExternalStore', () => {
    expect(remoteSessionStore.getMessages('missing')).toBe(remoteSessionStore.getMessages('missing'));
    expect(remoteSessionStore.getPendingInteractions('missing')).toBe(
      remoteSessionStore.getPendingInteractions('missing'),
    );
  });

  it('applies realtime session patches from device-link push', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1', { title: 'Old' })]);
    remoteSessionStore.applyRemotePush('dev-1', 'local-db:sessions:patched', {
      sessionId: 's1',
      patch: { title: 'New' },
    });

    expect(remoteSessionStore.getSessions()[0].title).toBe('New');
  });

  it('mirrors goal status pushes per session and clears on null goal', () => {
    const goal = {
      sessionId: 's1',
      status: 'active',
      objective: '修完登录 bug',
      turnsUsed: 2,
      tokensUsed: 1200,
      maxTurns: 20,
      noProgressLimit: 3,
      budgetTokens: null,
      usageResetAt: null,
      startedAt: 1,
      lastReason: null,
    };
    remoteSessionStore.applyRemotePush('dev-1', 'maker:goal:status-changed', {
      sessionId: 's1',
      goal,
    });
    expect(remoteSessionStore.getGoalStatus('s1')).toEqual(goal);
    // 未拉取过的会话是 undefined(unknown),不能压平成 null——见 getGoalStatus 注释。
    expect(remoteSessionStore.getGoalStatus('other')).toBeUndefined();

    remoteSessionStore.applyRemotePush('dev-1', 'maker:goal:status-changed', {
      sessionId: 's1',
      goal: null,
    });
    expect(remoteSessionStore.getGoalStatus('s1')).toBeNull();
  });

  it('requests a reseed when a push cannot be applied from local mirror state', () => {
    const reseed = vi.fn();
    remoteSessionStore.registerReseedHandler('dev-1', reseed);

    remoteSessionStore.applyRemotePush('dev-1', 'local-db:sessions:created', { sessionId: 's2' });
    remoteSessionStore.applyRemotePush('dev-1', 'local-db:sessions:patched', {
      sessionId: 's3',
      patch: { status: 'active' },
    });

    expect(reseed).toHaveBeenCalledTimes(2);
  });

  it('requests a reseed when unpinning a mirrored session that may have been included only because it was pinned', () => {
    const reseed = vi.fn();
    remoteSessionStore.registerReseedHandler('dev-1', reseed);
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [
      session('old-pinned', { pinnedAt: '2026-01-02T00:00:00.000Z' }),
    ]);

    remoteSessionStore.applyRemotePush('dev-1', 'local-db:sessions:patched', {
      sessionId: 'old-pinned',
      patch: { pinnedAt: null },
    });

    expect(remoteSessionStore.getSessions()[0].pinnedAt).toBeNull();
    expect(reseed).toHaveBeenCalledTimes(1);
  });

  it('fans reseed out to every subscriber and only unregisters the one that left', () => {
    const home = vi.fn();
    const detail = vi.fn();
    const unregisterHome = remoteSessionStore.registerReseedHandler('dev-1', home);
    remoteSessionStore.registerReseedHandler('dev-1', detail);

    remoteSessionStore.applyRemotePush('dev-1', 'local-db:sessions:created', { sessionId: 's2' });
    expect(home).toHaveBeenCalledTimes(1);
    expect(detail).toHaveBeenCalledTimes(1);

    // Detail screen unmounts; Home must keep reseeding (regression: a shared Map dropped it).
    unregisterHome();
    remoteSessionStore.applyRemotePush('dev-1', 'local-db:sessions:created', { sessionId: 's3' });
    expect(home).toHaveBeenCalledTimes(1);
    expect(detail).toHaveBeenCalledTimes(2);
  });

  it('keeps cached messages but invalidates sync marker and marks pendingRefresh on local-db:session:error-persisted push', () => {
    remoteSessionStore.setMessages('s1', [message('m1', 's1')]);
    remoteSessionStore.markSessionMessagesSynced('s1', { _count: { messages: 1 }, updatedAt: '2026-01-01T00:00:00.000Z' });

    expect(remoteSessionStore.getMessages('s1')).toHaveLength(1);
    expect(remoteSessionStore.isSessionMessageWindowSynced('s1', { _count: { messages: 1 }, updatedAt: '2026-01-01T00:00:00.000Z' })).toBe(true);
    expect(remoteSessionStore.hasPendingRefresh('s1')).toBe(false);

    remoteSessionStore.applyRemotePush('dev-1', 'local-db:session:error-persisted', { sessionId: 's1' });

    // 消息保留(避免空白帧),sync marker 失效,待刷新标记置 true。
    expect(remoteSessionStore.getMessages('s1')).toHaveLength(1);
    expect(remoteSessionStore.isSessionMessageWindowSynced('s1', { _count: { messages: 1 }, updatedAt: '2026-01-01T00:00:00.000Z' })).toBe(false);
    expect(remoteSessionStore.hasPendingRefresh('s1')).toBe(true);
  });

  it('clears messages and sync marker, then marks pendingRefresh when error arrives before initial cache', () => {
    // 未缓存但页面可能正在首次 listMessages：仍需 pendingRefresh 触发下一轮拉取，避免 in-flight 旧响应盖住新 error。
    expect(remoteSessionStore.getMessages('s2')).toHaveLength(0);

    remoteSessionStore.applyRemotePush('dev-1', 'local-db:session:error-persisted', { sessionId: 's2' });

    expect(remoteSessionStore.getMessages('s2')).toHaveLength(0);
    expect(remoteSessionStore.hasPendingRefresh('s2')).toBe(true);
  });

  it('consumePendingRefresh returns true and clears the flag', () => {
    remoteSessionStore.setMessages('s1', [message('m1', 's1')]);
    remoteSessionStore.applyRemotePush('dev-1', 'local-db:session:error-persisted', { sessionId: 's1' });

    expect(remoteSessionStore.hasPendingRefresh('s1')).toBe(true);
    expect(remoteSessionStore.consumePendingRefresh('s1')).toBe(true);
    expect(remoteSessionStore.hasPendingRefresh('s1')).toBe(false);
    // 二次消费返回 false。
    expect(remoteSessionStore.consumePendingRefresh('s1')).toBe(false);
  });

  it('applies realtime message and interaction pushes', () => {
    remoteSessionStore.applyRemotePush('dev-1', 'local-db:messages:created', {
      sessionId: 's1',
      message: message('m1', 's1'),
    });
    remoteSessionStore.applyRemotePush('dev-1', 'maker:interaction-request', {
      sessionId: 's1',
      request: { kind: 'permission', requestId: 'req-1' },
    });

    expect(remoteSessionStore.getMessages('s1').map((item) => item.id)).toEqual(['m1']);
    expect(remoteSessionStore.getPendingInteractions('s1')).toHaveLength(1);

    remoteSessionStore.applyRemotePush('dev-1', 'maker:interaction-dismissed', {
      sessionId: 's1',
      requestId: 'req-1',
    });

    expect(remoteSessionStore.getPendingInteractions('s1')).toHaveLength(0);
  });

  it('keeps pending interactions sorted by desktop priority and preserves invalid requests', () => {
    remoteSessionStore.setPendingInteractions('s1', [
      pending('issue_confirm', 'issue-1'),
      pending('permission', 'permission-1'),
      pending('permission', 'permission-1'),
      pending('plan_review', 'plan-1'),
      pending('ask_user_question', undefined, 'ask-persist'),
    ]);

    expect(remoteSessionStore.getPendingInteractions('s1').map((item) => item.request.kind)).toEqual([
      'plan_review',
      'permission',
      'ask_user_question',
      'issue_confirm',
    ]);
    expect(remoteSessionStore.getPendingInteractions('s1').map((item) => item.request.requestId ?? item.persistId)).toEqual([
      'plan-1',
      'permission-1',
      'ask-persist',
      'issue-1',
    ]);
  });

  it('does not finalize streaming for a reconnect snapshot containing only a suppressed interaction', () => {
    vi.useFakeTimers();
    try {
      remoteSessionStore.beginOptimisticInteractionDismiss('s1', 'req-stale');
      remoteSessionStore.settleOptimisticInteractionDismiss('s1', 'req-stale', { kind: 'confirmed' });
      pushMakerText('s1', 'persist-1', 'still generating', false);
      vi.runOnlyPendingTimers();

      remoteSessionStore.setPendingInteractions(
        's1',
        [pending('permission', 'req-stale')],
        { finalizeStreaming: true },
      );

      expect(remoteSessionStore.getPendingInteractions('s1')).toHaveLength(0);
      expect(remoteSessionStore.getMessages('s1')).toMatchObject([{
        content: 'still generating',
        agentMeta: { isStreaming: true },
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('dismisses one pending interaction by requestId without clearing same-session siblings', () => {
    remoteSessionStore.setPendingInteractions('s1', [
      pending('permission', 'permission-1'),
      pending('ask_user_question', 'ask-1'),
      pending('plan_review', 'plan-1'),
    ]);

    remoteSessionStore.dismissInteraction('s1', 'ask-1');

    expect(remoteSessionStore.getPendingInteractions('s1').map((item) => item.request.requestId)).toEqual([
      'plan-1',
      'permission-1',
    ]);
  });

  it('patches existing messages from realtime turn cost pushes', () => {
    remoteSessionStore.setMessages('s1', [message('m1', 's1')]);

    remoteSessionStore.applyRemotePush('dev-1', 'usage:message-turn-cost', {
      sessionId: 's1',
      clientId: 'm1',
      turnMoney: {
        amount: 0.29,
        currency: 'CNY',
        approximate: true,
        kind: 'value-estimate',
        estimateReasons: ['sdk-estimate'],
      },
      turnCostIsCustomProvider: true,
      turnCostProviderId: 'custom-provider',
    });

    expect(remoteSessionStore.getMessages('s1')[0].agentMeta).toMatchObject({
      turnCost: {
        amount: 0.29,
        currency: 'CNY',
        estimateReasons: ['sdk-estimate'],
      },
      turnCostIsEstimate: true,
      turnCostIsCustomProvider: true,
      turnCostProviderId: 'custom-provider',
    });
  });

  // 无当前 segment 金额、只有整轮累计 + token 明细 = 桌面自动续跑的无价收尾轮。
  // 累计金额必须一起落进 agentMeta,否则操作行会用 token 顶掉这一轮已经花掉的钱
  // (不变量正本见 apps/desktop/src/shared/turnCostPayload.ts)。
  it('keeps the user-round total from usage-only turn cost pushes', () => {
    remoteSessionStore.setMessages('s1', [message('m1', 's1')]);

    remoteSessionStore.applyRemotePush('dev-1', 'usage:message-turn-cost', {
      sessionId: 's1',
      clientId: 'm1',
      userTurnMoney: {
        amount: 1.25,
        currency: 'USD',
        approximate: false,
        kind: 'actual-cost',
      },
      userTurnCostUsd: 1.25,
      userTurnCostIsEstimate: true,
      turnUsageDetails: { totalTokens: 2_100_000 },
    });

    const meta = remoteSessionStore.getMessages('s1')[0].agentMeta;
    expect(meta).toMatchObject({
      userTurnCost: { amount: 1.25, currency: 'USD' },
      userTurnCostUsd: 1.25,
      userTurnCostIsEstimate: true,
      turnUsageDetails: { totalTokens: 2_100_000 },
    });
    // 当前 segment 没有报价 → 不写任何 segment 金额字段(不记账)。
    expect(meta?.turnCost).toBeUndefined();
    expect(meta?.turnCostUsd).toBeUndefined();
  });

  it('patches existing messages from realtime model mismatch pushes', () => {
    remoteSessionStore.setMessages('s1', [message('m1', 's1')]);

    remoteSessionStore.applyRemotePush('dev-1', 'usage:message-model-mismatch', {
      sessionId: 's1',
      clientId: 'm1',
      modelMismatch: { selected: 'claude-fable-5', actual: 'claude-opus-4-8' },
    });

    expect(remoteSessionStore.getMessages('s1')[0].agentMeta).toMatchObject({
      modelMismatch: { selected: 'claude-fable-5', actual: 'claude-opus-4-8' },
    });

    // 字段不全的 push 一律忽略,不写入半截标记。
    remoteSessionStore.setMessages('s2', [message('m2', 's2')]);
    remoteSessionStore.applyRemotePush('dev-1', 'usage:message-model-mismatch', {
      sessionId: 's2',
      clientId: 'm2',
      modelMismatch: { selected: 'claude-fable-5' },
    });
    expect(remoteSessionStore.getMessages('s2')[0].agentMeta?.modelMismatch).toBeUndefined();
  });

  it('applies input projection push and exposes an empty stable fallback', () => {
    expect(remoteSessionStore.getInputProjection('missing')).toBe(
      remoteSessionStore.getInputProjection('missing'),
    );

    remoteSessionStore.applyRemotePush('dev-1', 'maker:input:projection', projection('s1'));

    expect(remoteSessionStore.getInputProjection('s1')).toMatchObject({
      sessionId: 's1',
      pendingQueue: [{ clientId: 'q-1', text: 'queued' }],
      queuePaused: true,
    });
  });

  it('rejects a late projection query after a newer push and terminal boundary', () => {
    const ownerProjection = {
      ...projection('s1'),
      continuationTurnClientId: 'resume-1',
    };
    const expectedEpoch = remoteSessionStore.captureInputProjectionAuthorityEpoch('s1');
    remoteSessionStore.setInputProjection('s1', ownerProjection);
    const queryEpoch = remoteSessionStore.captureInputProjectionAuthorityEpoch('s1');

    remoteSessionStore.applyRemotePush('dev-1', 'maker:input:projection', {
      ...projection('s1'),
      continuationTurnClientId: null,
    });
    remoteSessionStore.applyRemotePush('dev-1', 'maker:event', {
      sessionId: 's1',
      event: { type: 'done', data: {} },
    });

    expect(remoteSessionStore.setInputProjectionIfCurrent('s1', ownerProjection, queryEpoch)).toBe(false);
    expect(remoteSessionStore.getInputProjection('s1').continuationTurnClientId).toBeNull();
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(false);
    expect(remoteSessionStore.captureInputProjectionAuthorityEpoch('s1')).not.toBe(expectedEpoch);
  });

  it('accepts a projection query result when no newer authority event arrived', () => {
    const expectedEpoch = remoteSessionStore.captureInputProjectionAuthorityEpoch('s1');
    expect(remoteSessionStore.setInputProjectionIfCurrent('s1', projection('s1'), expectedEpoch)).toBe(true);
    expect(remoteSessionStore.getInputProjection('s1').pendingQueue[0]?.clientId).toBe('q-1');
  });

  it('clears a continuation owner at a terminal boundary without a projection clear push', () => {
    const ownerProjection = {
      ...projection('s1'),
      continuationTurnClientId: 'resume-1',
    };
    remoteSessionStore.setInputProjection('s1', ownerProjection);
    remoteSessionStore.setSessionRunning('s1', true);
    const operationEpoch = remoteSessionStore.captureInputProjectionAuthorityEpoch('s1');

    remoteSessionStore.applyRemotePush('dev-1', 'maker:status-changed', {
      sessionId: 's1',
      status: 'closed',
    });

    expect(remoteSessionStore.getInputProjection('s1').continuationTurnClientId).toBeNull();
    expect(remoteSessionStore.isSessionMakerTurnRunning('s1')).toBe(false);
    expect(remoteSessionStore.setInputProjectionIfCurrent('s1', ownerProjection, operationEpoch)).toBe(false);
  });

  it('soft-invalidates an offline device without deleting sessions or messages', () => {
    const meta = session('s1', {
      updatedAt: '2026-01-01T00:00:01.000Z',
      _count: { messages: 1 },
    });
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [meta]);
    remoteSessionStore.setDeviceSessions('dev-2', 'Windows', [session('s2')]);
    remoteSessionStore.setMessages('s1', [message('m1', 's1')]);
    pushMakerText('s1', 'live-1', 'streaming', false);
    remoteSessionStore.setMessages('s2', [message('m2', 's2')]);
    remoteSessionStore.markSessionMessagesSynced('s1', meta);
    remoteSessionStore.setPendingInteractions('s1', [{ request: { requestId: 'req-1' } }]);
    remoteSessionStore.setInputProjection('s1', projection('s1'));
    remoteSessionStore.setSessionRunning('s1', true);
    remoteSessionStore.setGoalStatus('s1', { status: 'running' } as never);

    remoteSessionStore.markDeviceOffline('dev-1');

    expect(remoteSessionStore.getSessions().map((item) => item.id).sort()).toEqual(['s1', 's2']);
    expect(remoteSessionStore.getSessionDeviceId('s1')).toBe('dev-1');
    expect(remoteSessionStore.getMessages('s1')).toEqual([
      expect.objectContaining({ id: 'm1' }),
      expect.objectContaining({ content: 'streaming', agentMeta: expect.not.objectContaining({ isStreaming: true }) }),
    ]);
    expect(remoteSessionStore.isSessionMessageWindowSynced('s1', meta)).toBe(false);
    expect(remoteSessionStore.getPendingInteractions('s1')).toEqual([]);
    expect(remoteSessionStore.getInputProjection('s1').pendingQueue).toEqual([]);
    expect(remoteSessionStore.getSessionRunStatus('s1').isRunning).toBe(false);
    expect(remoteSessionStore.getGoalStatus('s1')).toBeUndefined();
    expect(remoteSessionStore.getMessages('s2')).toHaveLength(1);

    // 重复离线通知幂等,不会清掉保留的 last-known 内容。
    remoteSessionStore.markDeviceOffline('dev-1');
    expect(remoteSessionStore.getMessages('s1')).toHaveLength(2);
  });

  it('emits when soft offline only clears pending-refresh metadata', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    remoteSessionStore.applyRemotePush('dev-1', 'local-db:session:error-persisted', {
      sessionId: 's1',
    });
    expect(remoteSessionStore.hasPendingRefresh('s1')).toBe(true);

    const notify = vi.fn();
    const unsubscribe = remoteSessionStore.subscribe(notify);
    try {
      remoteSessionStore.markDeviceOffline('dev-1');
      expect(remoteSessionStore.hasPendingRefresh('s1')).toBe(false);
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('removes a device shard with its messages and pending interactions', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    remoteSessionStore.setDeviceSessions('dev-2', 'Windows', [session('s2')]);
    remoteSessionStore.setMessages('s1', [message('m1', 's1')]);
    remoteSessionStore.setMessages('s2', [message('m2', 's2')]);
    remoteSessionStore.setPendingInteractions('s1', [{ request: { requestId: 'req-1' } }]);
    remoteSessionStore.setInputProjection('s1', projection('s1'));

    remoteSessionStore.removeDevice('dev-1');

    expect(remoteSessionStore.getSessions().map((item) => item.id)).toEqual(['s2']);
    expect(remoteSessionStore.getMessages('s1')).toEqual([]);
    expect(remoteSessionStore.getPendingInteractions('s1')).toEqual([]);
    expect(remoteSessionStore.getInputProjection('s1').pendingQueue).toEqual([]);
    expect(remoteSessionStore.getMessages('s2')).toHaveLength(1);
  });

  it('writes canonicalDeviceId for a stale shard uniquely matching a current device, keeping deviceLinkDeviceId physical', () => {
    remoteSessionStore.setDeviceIdentity([{ deviceId: 'current-mac', name: 'Lizi Mac' }]);
    remoteSessionStore.setDeviceSessions('current-mac', 'Lizi Mac', [session('s-current')]);
    remoteSessionStore.setDeviceSessions('stale-mac', 'Lizi Mac', [session('s-stale')]);

    const byId = new Map(remoteSessionStore.getSessions().map((s) => [s.id, s]));
    // 展示维度:两条都认领到 current-mac(详情页按 canonicalDeviceId 过滤时同时可见)。
    expect(byId.get('s-current')?.canonicalDeviceId).toBe('current-mac');
    expect(byId.get('s-stale')?.canonicalDeviceId).toBe('current-mac');
    // 路由维度:deviceLinkDeviceId 保持物理 shard id,sessionDeviceIndex 指向物理 shard(patch 不丢)。
    expect(byId.get('s-stale')?.deviceLinkDeviceId).toBe('stale-mac');
    expect(remoteSessionStore.getSessionDeviceId('s-stale')).toBe('stale-mac');
  });

  it('dedupes the same session id across stale/current shards, keeping the current shard copy', () => {
    remoteSessionStore.setDeviceIdentity([{ deviceId: 'current-mac', name: 'Lizi Mac' }]);
    // 同一 session id 同时出现在 stale 与 current 两个 shard(re-link 后旧 shard 残留)。
    remoteSessionStore.setDeviceSessions('stale-mac', 'Lizi Mac', [session('dup')]);
    remoteSessionStore.setDeviceSessions('current-mac', 'Lizi Mac', [session('dup')]);

    const rows = remoteSessionStore.getSessions().filter((s) => s.id === 'dup');
    expect(rows).toHaveLength(1); // 去重,不重复渲染
    expect(rows[0]?.deviceLinkDeviceId).toBe('current-mac'); // 保留 current shard 的真身
    expect(remoteSessionStore.getSessionDeviceId('dup')).toBe('current-mac');
  });

  it('does not merge two unknown same-name shards (canonicalDeviceId stays the original id)', () => {
    remoteSessionStore.setDeviceIdentity([]);
    remoteSessionStore.setDeviceSessions('ghost-1', 'MacBook Pro', [session('g1')]);
    remoteSessionStore.setDeviceSessions('ghost-2', 'MacBook Pro', [session('g2')]);

    const byId = new Map(remoteSessionStore.getSessions().map((s) => [s.id, s.canonicalDeviceId]));
    expect(byId.get('g1')).toBe('ghost-1');
    expect(byId.get('g2')).toBe('ghost-2');
  });

  it('leaves canonicalDeviceId equal to the physical shard id before any device identity is injected', () => {
    remoteSessionStore.setDeviceSessions('stale-mac', 'Lizi Mac', [session('s1')]);
    const s = remoteSessionStore.getSessions()[0];
    expect(s?.deviceLinkDeviceId).toBe('stale-mac');
    expect(s?.canonicalDeviceId).toBe('stale-mac');
  });

  it('does not claim when two stale shards share a name matching one current device', () => {
    remoteSessionStore.setDeviceIdentity([{ deviceId: 'current-mbp', name: 'MacBook Pro' }]);
    remoteSessionStore.setDeviceSessions('stale-1', 'MacBook Pro', [session('a')]);
    remoteSessionStore.setDeviceSessions('stale-2', 'MacBook Pro', [session('b')]);

    const byId = new Map(remoteSessionStore.getSessions().map((s) => [s.id, s.canonicalDeviceId]));
    // stale 侧同名歧义 → 不认领,保留各自物理 id,不并到 current-mbp。
    expect(byId.get('a')).toBe('stale-1');
    expect(byId.get('b')).toBe('stale-2');
  });

  it('ignores placeholder device names when claiming stale shards', () => {
    remoteSessionStore.setDeviceIdentity([{ deviceId: 'current-x', name: 'unknown' }]);
    remoteSessionStore.setDeviceSessions('stale-x', 'unknown', [session('p')]);
    // placeholder 名(unknown)不参与认领,stale-x 保留物理 id。
    expect(remoteSessionStore.getSessions().find((s) => s.id === 'p')?.canonicalDeviceId).toBe('stale-x');
  });
});

describe('maker:session-model-pref:changed push 路由', () => {
  it('路由进 sessionModelMirror(镜像可读),非法 payload 静默忽略', async () => {
    const { makeSessionMirrorAccessors, clearSessionMirror } = await import('@/session/sessionModelMirror');
    const acc = makeSessionMirrorAccessors('s-pref', vi.fn());
    remoteSessionStore.applyRemotePush('dev-1', 'maker:session-model-pref:changed', {
      sessionId: 's-pref',
      agent: 'codex',
      providerId: 'xd',
      model: 'gpt-5.5',
      effort: 'xhigh',
      fast: true,
    });
    expect(acc.getEffort('codex', 'xd', 'gpt-5.5')).toBe('xhigh');
    expect(acc.getFast('codex', 'xd', 'gpt-5.5')).toBe(true);

    remoteSessionStore.applyRemotePush('dev-1', 'maker:session-model-pref:changed', { nope: 1 });
    expect(acc.getEffort('codex', 'xd', 'nope')).toBeUndefined();
    clearSessionMirror('s-pref');
  });
});

describe('setDeviceSessions 对在途乐观创建行(pendingLocalCreation)的保护', () => {
  beforeEach(() => remoteSessionStore.clear());

  it('比建成更早发出的旧列表不含该 id:合成行保留,不从列表消失', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s-old')]);
    remoteSessionStore.upsertDeviceSession('dev-1', 'Mac', session('s-new', { pendingLocalCreation: true }));

    // 首页 in-flight 的 sessions:list 响应此刻返回(发出时被控端还没建这个任务)。
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s-old')]);
    const rows = remoteSessionStore.getSessions();
    expect(rows.map((s) => s.id)).toContain('s-new');
    expect(rows.find((s) => s.id === 's-new')?.pendingLocalCreation).toBe(true);
  });

  it('建成后 enqueue 落定前的新列表含该 id 但无标:合并权威字段并保留禁发标', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', []);
    remoteSessionStore.upsertDeviceSession('dev-1', 'Mac', session('s-new', { pendingLocalCreation: true, title: '本地草稿标题' }));

    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s-new', { title: '权威标题' })]);
    const row = remoteSessionStore.getSessions().find((s) => s.id === 's-new');
    expect(row?.title).toBe('权威标题');
    expect(row?.pendingLocalCreation).toBe(true);
  });

  it('管线清标(pendingLocalCreation: false)后,列表对账恢复正常替换语义', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', []);
    remoteSessionStore.upsertDeviceSession('dev-1', 'Mac', session('s-new', { pendingLocalCreation: true }));
    remoteSessionStore.applySessionPatch('dev-1', 's-new', { pendingLocalCreation: false });

    // 不含该 id 的列表到达:行不再受保护(正常对账,如会话被其它控制端删除)。
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s-old')]);
    expect(remoteSessionStore.getSessions().map((s) => s.id)).toEqual(['s-old']);
  });
});

describe('setDeviceSessions 在途元数据写保护(sessionPendingWrites)', () => {
  beforeEach(() => remoteSessionStore.clear());

  it('在途字段不被旧快照冲掉,其余字段照常吃快照(review P1:重连全量对账)', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1', { title: '旧名' })]);
    const release = sessionPendingWrites.track('s1', ['title']);
    remoteSessionStore.applySessionPatch('dev-1', 's1', { title: '新名' });
    // 重连全量拉到旧快照:title 仍是旧名,但 updatedAt 已推进
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [
      session('s1', { title: '旧名', updatedAt: '2026-01-02T00:00:00.000Z' }),
    ]);
    const row = remoteSessionStore.getSessions().find((s) => s.id === 's1');
    expect(row?.title).toBe('新名');
    expect(row?.updatedAt).toBe('2026-01-02T00:00:00.000Z');
    // overlay 藏掉了与本地不同的权威快照值 → 留差异痕,由写的结局 consume 触发 reseed
    expect(sessionPendingWrites.consumeMaskedPush('s1', ['title'])).toBe(true);
    release();
  });

  it('乐观移出的行(删除/归档在途)不随旧快照复活;release 后恢复正常对账', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1'), session('s2')]);
    const release = sessionPendingWrites.track('s1', ['status']);
    remoteSessionStore.applySessionPatch('dev-1', 's1', { status: 'deleted' });
    expect(remoteSessionStore.getSessions().map((s) => s.id)).toEqual(['s2']);
    // 重连全量拉到旧快照(被控端还没处理删除,s1 仍在):不得复活
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1'), session('s2')]);
    expect(remoteSessionStore.getSessions().map((s) => s.id)).toEqual(['s2']);
    // 写 settle 后,后续快照按正常语义对账(若被控端确认删除,新快照不含 s1)
    release();
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s2')]);
    expect(remoteSessionStore.getSessions().map((s) => s.id)).toEqual(['s2']);
  });

  it('restore 在途把行加回列表:旧快照缺失该行时不抹掉,写 settle 后恢复正常对账(review P2)', () => {
    // 归档会话 s1 不在活跃列表;详情页 restore:乐观 status=active 把行加回
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s2')]);
    remoteSessionStore.upsertDeviceSession('dev-1', 'Mac', session('s1', { status: 'active' }));
    const release = sessionPendingWrites.track('s1', ['status']);
    // 重连全量拉到旧快照(被控端未处理 restore,s1 仍归档不在列表):不得抹掉乐观行
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s2')]);
    expect(remoteSessionStore.getSessions().map((s) => s.id).sort()).toEqual(['s1', 's2']);
    // 写 settle 后正常对账:后续快照不含 s1(如 restore 失败回滚)则移除
    release();
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s2')]);
    expect(remoteSessionStore.getSessions().map((s) => s.id)).toEqual(['s2']);
  });

  it('无在途写时全量对账语义不变', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1', { title: 'A' })]);
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1', { title: 'B' })]);
    expect(remoteSessionStore.getSessions().find((s) => s.id === 's1')?.title).toBe('B');
  });
});

describe('引用调和(2026-07-18 首页重渲染风暴修复)', () => {
  beforeEach(() => remoteSessionStore.clear());

  it('setDeviceSessions:单会话变化时,其余会话保留旧对象引用', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1'), session('s2'), session('s3')]);
    const before = remoteSessionStore.getSessions();
    const s1Before = before.find((s) => s.id === 's1');
    const s3Before = before.find((s) => s.id === 's3');
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [
      session('s1'),
      session('s2', { updatedAt: '2026-01-02T00:00:00.000Z' }),
      session('s3'),
    ]);
    const after = remoteSessionStore.getSessions();
    expect(after).not.toBe(before);
    expect(after.find((s) => s.id === 's1')).toBe(s1Before);
    expect(after.find((s) => s.id === 's3')).toBe(s3Before);
    expect(after.find((s) => s.id === 's2')).not.toBe(before.find((s) => s.id === 's2'));
  });

  it('upsert 置顶重排:数组换新但内容未变的会话对象引用保留', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1'), session('s2')]);
    const before = remoteSessionStore.getSessions();
    const s1Before = before.find((s) => s.id === 's1');
    const s2Before = before.find((s) => s.id === 's2');
    remoteSessionStore.upsertDeviceSession('dev-1', 'Mac', session('s2'));
    const after = remoteSessionStore.getSessions();
    expect(after[0]).toBe(s2Before);
    expect(after.find((s) => s.id === 's1')).toBe(s1Before);
  });

  it('设备身份归一化下,与会话内容无关的重算保留 mergedSessions 数组引用', () => {
    // 归一化分支每轮都会 {...session, canonicalDeviceId} 重铸对象,调和必须能吸收它,
    // 否则 useSyncExternalStore 快照逐 emit 换新引用,消费屏全量重渲染(风暴根因)。
    remoteSessionStore.setDeviceIdentity([{ deviceId: 'dev-1', name: 'Mac' }]);
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1'), session('s2')]);
    const before = remoteSessionStore.getSessions();
    remoteSessionStore.setDeviceIdentity([
      { deviceId: 'dev-1', name: 'Mac' },
      { deviceId: 'dev-9', name: 'Other' },
    ]);
    expect(remoteSessionStore.getSessions()).toBe(before);
  });

  it('跨设备:另一设备 shard 变化不换本设备会话的对象引用', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    const s1Before = remoteSessionStore.getSessions().find((s) => s.id === 's1');
    remoteSessionStore.setDeviceSessions('dev-2', 'Win', [session('w1')]);
    expect(remoteSessionStore.getSessions().find((s) => s.id === 's1')).toBe(s1Before);
    remoteSessionStore.removeDevice('dev-2');
    expect(remoteSessionStore.getSessions().find((s) => s.id === 's1')).toBe(s1Before);
  });

  it('风暴不变量:消息/运行态/活动高频 churn + 内容等价重算下,会话列表快照引用零漂移', () => {
    // 桌面端流式输出 = appendMessage / status / activity 事件以每秒多条的频率灌入,
    // 其间还夹杂设备表更新等触发 recomputeSessions 的内容等价重算(归一化分支每轮
    // 都会重铸对象,必须被引用调和吸收)。这些都不改变会话列表内容,getSessions()
    // 快照必须保持同一引用——它是 useRemoteSessions 消费屏(首页/设备详情)不被
    // 无关 emit 惊动的结构保证,重构后回归验证的核心断言(2026-07-18 风暴修复;
    // 每轮 setDeviceIdentity 在修复前的 store 上会真实打红本用例)。
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1'), session('s2')]);
    const snapshot = remoteSessionStore.getSessions();
    for (let i = 0; i < 50; i += 1) {
      remoteSessionStore.appendMessage('s1', {
        id: `m${i}`,
        clientId: `m${i}`,
        sessionId: 's1',
        role: 'assistant',
        content: `chunk ${i}`,
        toolUseId: null,
        agentMeta: null,
        createdAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
      remoteSessionStore.applyMakerEvent('s1', { type: 'status', data: { isRunning: true, tokenUsage: i + 1 } });
      remoteSessionStore.applySessionActivity('dev-1', {
        sessionId: 's1',
        phase: 'running',
        compactDetail: `step ${i}`,
      });
      // 每轮设备表变化(无关设备增补)强制走一次 recomputeSessions:会话内容等价,
      // 归一化重铸的对象必须被调和吸收,快照引用不许漂移。
      remoteSessionStore.setDeviceIdentity([
        { deviceId: 'dev-1', name: 'Mac' },
        { deviceId: `ghost-${i}`, name: `G${i}` },
      ]);
    }
    expect(remoteSessionStore.getSessions()).toBe(snapshot);
  });
});

describe('maker:event 微批拆包(CONTROLLER_CAPABILITY_MAKER_EVENT_BATCH_V1)', () => {
  it('批内事件按序走与逐帧完全相同的路径:流式增量拼接结果一致', () => {
    vi.useFakeTimers();
    try {
      // 逐帧基线
      pushMakerText('s-single', 'p-1', 'hello', false);
      pushMakerText('s-single', 'p-1', ' world', false);
      vi.runOnlyPendingTimers();
      const single = remoteSessionStore.getMessages('s-single');

      // 同样两条事件,这次由被控端合并成一帧微批下发
      remoteSessionStore.applyRemotePush('dev-1', MAKER_EVENT_BATCH_CHANNEL, {
        sessionId: 's-batch',
        events: [
          { sessionId: 's-batch', persistId: 'p-1', event: { type: 'text', data: { text: 'hello', isFinal: false } } },
          { sessionId: 's-batch', persistId: 'p-1', event: { type: 'text', data: { text: ' world', isFinal: false } } },
        ],
      });
      vi.runOnlyPendingTimers();
      const batched = remoteSessionStore.getMessages('s-batch');

      expect(batched).toHaveLength(1);
      expect(batched[0]).toMatchObject({ id: 'p-1', role: 'assistant', content: 'hello world' });
      // 与逐帧结果逐字段一致(仅 sessionId 不同)
      expect(batched[0]!.content).toBe(single[0]!.content);
    } finally {
      vi.useRealTimers();
    }
  });

  it('形状不符的批帧整体忽略;批内单条坏事件只跳过该条', () => {
    vi.useFakeTimers();
    try {
      // 缺 events / events 为空 / 非数组:整帧忽略,不抛
      for (const bad of [
        { sessionId: 's-bad' },
        { sessionId: 's-bad', events: [] },
        { sessionId: 's-bad', events: 'nope' },
        { events: [{}] },
        null,
      ]) {
        expect(() =>
          remoteSessionStore.applyRemotePush('dev-1', MAKER_EVENT_BATCH_CHANNEL, bad),
        ).not.toThrow();
      }
      vi.runOnlyPendingTimers();
      expect(remoteSessionStore.getMessages('s-bad')).toHaveLength(0);

      // 批内混入坏条目:好的照常生效
      remoteSessionStore.applyRemotePush('dev-1', MAKER_EVENT_BATCH_CHANNEL, {
        sessionId: 's-mixed',
        events: [
          'not-an-object',
          { sessionId: 's-mixed', persistId: 'p-9', event: { type: 'text', data: { text: 'ok', isFinal: true } } },
        ],
      });
      vi.runOnlyPendingTimers();
      expect(remoteSessionStore.getMessages('s-mixed')).toHaveLength(1);
      expect(remoteSessionStore.getMessages('s-mixed')[0]).toMatchObject({ content: 'ok' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('批内 sessionId 与顶层不一致的条目被丢弃:不绕过 topic 隔离', () => {
    // topic 路由只按**顶层** sessionId,批内混入其它会话的事件会把本端未订阅的
    // 会话数据投进来(坏帧/恶意帧场景)。fail-closed 跳过该条,不整批丢。
    vi.useFakeTimers();
    try {
      remoteSessionStore.applyRemotePush('dev-1', MAKER_EVENT_BATCH_CHANNEL, {
        sessionId: 's-own',
        events: [
          { sessionId: 's-other', persistId: 'p-x', event: { type: 'text', data: { text: 'leak', isFinal: true } } },
          { sessionId: 's-own', persistId: 'p-y', event: { type: 'text', data: { text: 'mine', isFinal: true } } },
        ],
      });
      vi.runOnlyPendingTimers();
      expect(remoteSessionStore.getMessages('s-other')).toHaveLength(0);
      expect(remoteSessionStore.getMessages('s-own')).toHaveLength(1);
      expect(remoteSessionStore.getMessages('s-own')[0]).toMatchObject({ content: 'mine' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('任务消息内存治理', () => {
  beforeEach(() => remoteSessionStore.clear());

  const manyMessages = (sessionId: string, count: number): RemoteMessage[] =>
    Array.from({ length: count }, (_, index) => messageAt(
      `${sessionId}-m-${index}`,
      sessionId,
      new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    ));

  const flushReclaim = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it('只按 source=scheduler 分类，标题与 source 缺失均保守按 regular', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [
      session('schedule', { source: 'scheduler', title: '普通标题' }),
      session('legacy-title', { title: '[Schedule] 旧标题' }),
      session('bound', { source: 'user', title: '被定时器绑定' }),
    ]);

    expect(remoteSessionStore.getSessionRetention('schedule')).toBe('schedule');
    expect(remoteSessionStore.getSessionRetention('legacy-title')).toBe('regular');
    expect(remoteSessionStore.getSessionRetention('bound')).toBe('regular');
  });

  it('旧详情代际的读取在 blur→refocus 后不能覆盖新窗口', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1', { source: 'scheduler' })]);
    const first = remoteSessionStore.enterSessionMessageDetail('s1');
    remoteSessionStore.setMessages('s1', [message('first', 's1')], { authority: first });
    remoteSessionStore.leaveSessionMessageDetail('s1', 'detail-blur', first);
    const second = remoteSessionStore.enterSessionMessageDetail('s1');

    remoteSessionStore.setMessages('s1', [message('stale', 's1')], { authority: first });
    expect(remoteSessionStore.getMessages('s1').map((row) => row.id)).toEqual(['first']);

    remoteSessionStore.setMessages('s1', [message('fresh', 's1')], { authority: second });
    expect(remoteSessionStore.getMessages('s1').map((row) => row.id)).toEqual(['fresh']);
  });

  it('从未打开的 regular 可更新全局镜像，首次进入或离场后不再接受无 authority 补读', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    const unenteredAuthority = remoteSessionStore.captureUnenteredSessionMessageAuthority('s1');
    expect(remoteSessionStore.hasSessionMessageDetailEntered('s1')).toBe(false);
    expect(remoteSessionStore.canCommitUnenteredSessionMessageWindow(unenteredAuthority, 'dev-1')).toBe(true);
    expect(remoteSessionStore.canCommitUnenteredSessionMessageWindow(unenteredAuthority, 'dev-2')).toBe(false);

    remoteSessionStore.setLatestMessageWindow('s1', [message('global-mirror', 's1')]);
    expect(remoteSessionStore.getMessages('s1').map((row) => row.id)).toEqual(['global-mirror']);

    const authority = remoteSessionStore.enterSessionMessageDetail('s1');
    expect(remoteSessionStore.hasSessionMessageDetailEntered('s1')).toBe(true);
    expect(remoteSessionStore.canCommitUnenteredSessionMessageWindow(unenteredAuthority, 'dev-1')).toBe(false);
    remoteSessionStore.leaveSessionMessageDetail('s1', 'detail-blur', authority);
    remoteSessionStore.setLatestMessageWindow('s1', [message('stale-reconnect', 's1')]);

    expect(remoteSessionStore.getMessages('s1').some((row) => row.id === 'stale-reconnect')).toBe(false);
  });

  it('从未打开的 schedule 不接受无 authority 的重连补读', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [
      session('s1', { source: 'scheduler' }),
    ]);

    const unenteredAuthority = remoteSessionStore.captureUnenteredSessionMessageAuthority('s1');
    expect(remoteSessionStore.hasSessionMessageDetailEntered('s1')).toBe(false);
    expect(remoteSessionStore.canCommitUnenteredSessionMessageWindow(unenteredAuthority, 'dev-1')).toBe(false);
    remoteSessionStore.setLatestMessageWindow('s1', [message('schedule-reconnect', 's1')]);
    expect(remoteSessionStore.getMessages('s1')).toEqual([]);
  });

  it('clear 后同设备同任务重建也拒绝 reset 前的未进入详情读取', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    const beforeReset = remoteSessionStore.captureUnenteredSessionMessageAuthority('s1');

    remoteSessionStore.clear();
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);

    expect(remoteSessionStore.canCommitUnenteredSessionMessageWindow(beforeReset, 'dev-1')).toBe(false);
    const afterReset = remoteSessionStore.captureUnenteredSessionMessageAuthority('s1');
    expect(remoteSessionStore.canCommitUnenteredSessionMessageWindow(afterReset, 'dev-1')).toBe(true);
  });

  it('schedule 失焦后回收到 0，后续 push 不会复活完整正文', async () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1', { source: 'scheduler' })]);
    const authority = remoteSessionStore.enterSessionMessageDetail('s1');
    remoteSessionStore.setMessages('s1', [message('m1', 's1')], { authority });

    remoteSessionStore.leaveSessionMessageDetail('s1', 'detail-blur', authority);
    await flushReclaim();
    expect(remoteSessionStore.getMessages('s1')).toEqual([]);

    remoteSessionStore.applyRemotePush('dev-1', 'local-db:messages:created', {
      sessionId: 's1',
      message: message('late-push', 's1'),
    });
    expect(remoteSessionStore.getMessages('s1')).toEqual([]);
  });

  it('regular 离场后旧订阅 push 与尚未 flush 的流式批次都不能复活窗口', async () => {
    vi.useFakeTimers();
    try {
      remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
      const authority = remoteSessionStore.enterSessionMessageDetail('s1');
      remoteSessionStore.setMessages('s1', manyMessages('s1', 2), { authority });
      pushMakerText('s1', 'stream-1', 'queued delta', false);

      remoteSessionStore.leaveSessionMessageDetail('s1', 'detail-blur', authority);
      const nextAuthority = remoteSessionStore.enterSessionMessageDetail('s1');
      vi.runOnlyPendingTimers();
      remoteSessionStore.applyRemotePush('dev-1', 'local-db:messages:created', {
        sessionId: 's1',
        message: message('late-subscription-push', 's1'),
      });

      expect(remoteSessionStore.isSessionMessageAuthorityCurrent(nextAuthority)).toBe(true);
      expect(remoteSessionStore.getMessages('s1').map((row) => row.id)).toEqual([
        's1-m-0',
        'late-subscription-push',
        's1-m-1',
      ]);
      // 上面的 push 是在新代际可见期间到达，应该保留；旧代际排队的 delta 不得出现。
      expect(remoteSessionStore.getMessages('s1').some((row) => row.id === 'stream-1')).toBe(false);

      remoteSessionStore.leaveSessionMessageDetail('s1', 'detail-blur', nextAuthority);
      await flushReclaim();
      remoteSessionStore.applyRemotePush('dev-1', 'local-db:messages:created', {
        sessionId: 's1',
        message: message('push-after-leave', 's1'),
      });
      expect(remoteSessionStore.getMessages('s1').some((row) => row.id === 'push-after-leave')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('页面卸载后本地工作排空仍会完成 deferred reclaim', async () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1', { source: 'scheduler' })]);
    const work = remoteSessionStore.acquireSessionMessageWork('s1', true);
    const authority = remoteSessionStore.enterSessionMessageDetail('s1');
    remoteSessionStore.setMessages('s1', [message('m1', 's1')], { authority });
    remoteSessionStore.leaveSessionMessageDetail('s1', 'session-switch', authority);

    await flushReclaim();
    expect(remoteSessionStore.getMessages('s1')).toHaveLength(1);
    work.release();
    await flushReclaim();
    expect(remoteSessionStore.getMessages('s1')).toEqual([]);
  });

  it('pending queue 暂缓 schedule 回收，queue 排空后由 store 主动补回收', async () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1', { source: 'scheduler' })]);
    const authority = remoteSessionStore.enterSessionMessageDetail('s1');
    remoteSessionStore.setMessages('s1', [message('m1', 's1')], { authority });
    remoteSessionStore.setInputProjection('s1', projection('s1'));
    remoteSessionStore.leaveSessionMessageDetail('s1', 'app-background', authority);

    await flushReclaim();
    expect(remoteSessionStore.getMessages('s1')).toHaveLength(1);
    remoteSessionStore.setInputProjection('s1', {
      ...projection('s1'),
      pendingQueue: [],
    });
    await flushReclaim();
    expect(remoteSessionStore.getMessages('s1')).toEqual([]);
  });

  it('regular 失焦压回单窗，同时保留窗口外的本地系统卡', async () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    const authority = remoteSessionStore.enterSessionMessageDetail('s1');
    const localCard = {
      ...messageAt('mobile-system-pwd-old', 's1', '2025-12-31T23:59:59.000Z'),
      role: 'system' as const,
    };
    remoteSessionStore.setMessages('s1', [localCard, ...manyMessages('s1', 100)], { authority });
    remoteSessionStore.leaveSessionMessageDetail('s1', 'detail-blur', authority);
    await flushReclaim();

    const rows = remoteSessionStore.getMessages('s1');
    expect(rows).toHaveLength(80);
    expect(rows.some((row) => row.id === localCard.id)).toBe(true);
    expect(rows.at(-1)?.id).toBe('s1-m-99');
  });

  it('regular 全局 LRU 不淘汰当前详情，且总量压回约 800 条', () => {
    const sessions = Array.from({ length: 9 }, (_, index) => session(`s${index}`));
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', sessions);
    remoteSessionStore.enterSessionMessageDetail('s0');
    for (const item of sessions) {
      remoteSessionStore.setMessages(item.id, manyMessages(item.id, 100));
    }

    const total = sessions.reduce(
      (sum, item) => sum + remoteSessionStore.getMessages(item.id).length,
      0,
    );
    expect(total).toBeLessThanOrEqual(800);
    expect(remoteSessionStore.getMessages('s0')).toHaveLength(100);
    expect(sessions.slice(1).some((item) => remoteSessionStore.getMessages(item.id).length === 0)).toBe(true);
  });

  it('regular LRU 只淘汰可重取正文，不丢尚未落盘的本地系统卡', () => {
    const sessions = Array.from({ length: 9 }, (_, index) => session(`s${index}`));
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', sessions);
    const localCard = {
      ...messageAt('mobile-system-local-only', 's0', '2025-12-31T23:59:59.000Z'),
      role: 'system' as const,
    };
    remoteSessionStore.setMessages('s0', [localCard, ...manyMessages('s0', 99)]);
    for (const item of sessions.slice(1)) {
      remoteSessionStore.setMessages(item.id, manyMessages(item.id, 100));
    }

    expect(remoteSessionStore.getMessages('s0')).toHaveLength(100);
    expect(remoteSessionStore.getMessages('s0').some((row) => row.id === localCard.id)).toBe(true);
  });

  it('regular 离场释放详情投影并拒绝离场前启动的旧投影查询', async () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    const authority = remoteSessionStore.enterSessionMessageDetail('s1');
    remoteSessionStore.setMessages('s1', [message('m1', 's1')], { authority });
    remoteSessionStore.setInputProjection('s1', {
      ...projection('s1'),
      pendingQueue: [],
    });
    const queryEpoch = remoteSessionStore.captureInputProjectionAuthorityEpoch('s1');

    remoteSessionStore.leaveSessionMessageDetail('s1', 'detail-blur', authority);
    await flushReclaim();

    expect(remoteSessionStore.getInputProjection('s1').pendingQueue).toEqual([]);
    expect(remoteSessionStore.setInputProjectionIfCurrent(
      's1',
      projection('s1'),
      queryEpoch,
    )).toBe(false);
  });

  it('source 晚到改判 schedule：当前详情立即压窗，失焦后归零', async () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    const authority = remoteSessionStore.enterSessionMessageDetail('s1');
    remoteSessionStore.setMessages('s1', manyMessages('s1', 100), { authority });

    remoteSessionStore.upsertDeviceSession('dev-1', 'Mac', session('s1', { source: 'scheduler' }));
    expect(remoteSessionStore.getSessionRetention('s1')).toBe('schedule');
    expect(remoteSessionStore.getMessages('s1')).toHaveLength(80);

    remoteSessionStore.leaveSessionMessageDetail('s1', 'detail-blur');
    await flushReclaim();
    expect(remoteSessionStore.getMessages('s1')).toEqual([]);
  });

  it('归档会话会撤销旧 authority，并拒绝迟到 push 复活正文', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    const authority = remoteSessionStore.enterSessionMessageDetail('s1');
    remoteSessionStore.setMessages('s1', [message('before-archive', 's1')], { authority });

    remoteSessionStore.applySessionPatch('dev-1', 's1', { status: 'archived' });
    remoteSessionStore.applyRemotePush('dev-1', 'local-db:messages:created', {
      sessionId: 's1',
      message: message('late-after-archive', 's1'),
    });

    expect(remoteSessionStore.isSessionMessageAuthorityCurrent(authority)).toBe(false);
    expect(remoteSessionStore.getMessages('s1')).toEqual([]);
  });

  it('显式失效 rewind 窗口会清正文、sync marker 并登记刷新', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);
    const authority = remoteSessionStore.enterSessionMessageDetail('s1');
    remoteSessionStore.setMessages('s1', [message('before-rewind', 's1')], { authority });
    const row = remoteSessionStore.getSessions().find((item) => item.id === 's1')!;
    remoteSessionStore.markSessionMessagesSynced('s1', row);

    remoteSessionStore.invalidateSessionMessageWindow('s1', 'dev-1');

    expect(remoteSessionStore.getMessages('s1')).toEqual([]);
    expect(remoteSessionStore.isSessionMessageWindowSynced('s1', row)).toBe(false);
    expect(remoteSessionStore.hasPendingRefresh('s1')).toBe(true);
    expect(remoteSessionStore.isSessionMessageAuthorityCurrent(authority)).toBe(true);
  });
});
