import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  opts: { source?: 'claude-code' | 'codex'; status?: string; description?: string } = {},
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

  it('stamps sessions with device-link origin and indexes session ids', () => {
    remoteSessionStore.setDeviceSessions('dev-1', 'Mac', [session('s1')]);

    expect(remoteSessionStore.getSessions()[0]).toMatchObject({
      id: 's1',
      deviceLinkDeviceId: 'dev-1',
      deviceLinkDeviceName: 'Mac',
    });
    expect(remoteSessionStore.getSessionDeviceId('s1')).toBe('dev-1');
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

  it('keeps synthetic completion when done precedes the initial plan DB row', () => {
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

    expect(remoteSessionStore.getMessages('s1')[0].content).toMatchObject({
      input: {
        plan: [
          { step: 'Inspect', status: 'completed' },
          { step: 'Patch', status: 'completed' },
        ],
      },
    });
  });

  it('does not let a delayed message window revert synthetic completion', () => {
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

    expect(remoteSessionStore.getMessages('s1')[0].content).toMatchObject({
      input: { plan: [{ step: 'Inspect', status: 'completed' }] },
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

  it('preserves loaded older pages when the refreshed latest page overlaps the current window', () => {
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
      agentMeta: { remoteContentTruncated: true },
    };
    remoteSessionStore.setMessages('s1', [full]);

    remoteSessionStore.setLatestMessageWindow('s1', [
      truncated,
      messageAt('m2', 's1', '2026-01-01T10:00:02.000Z'),
    ]);

    const rows = remoteSessionStore.getMessages('s1');
    expect(rows.map((item) => item.id)).toEqual(['m1', 'm2']);
    expect(rows[0].content).toBe('完整的长内容');
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
        approximate: false,
        kind: 'actual-cost',
      },
    });

    expect(remoteSessionStore.getMessages('s1')[0].agentMeta).toMatchObject({
      turnCost: {
        amount: 0.29,
        currency: 'CNY',
      },
      turnCostIsEstimate: false,
    });
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

    // 首页 in-flight 的 sessions:list 响应此刻返回(发出时被控端还没建这个会话)。
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
