import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentInputCoordinator } from '../agent-input-coordinator.js';
import type {
  AgentInputCoordinatorDeps,
  AgentInputHostSendFailureCode,
  AgentInputSendResult,
} from '../agent-input-coordinator.js';
import type {
  AgentInputProjection,
  AgentInputQueuedMessage,
} from '../../../shared/agentInputQueue.js';
import {
  CONTINUE_AFTER_APP_EXIT_PROMPT,
  CONTINUE_AFTER_ERROR_PROMPT,
} from '../../../shared/interruptedTurn.js';

const mocks = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    createMessage: vi.fn(async (...args: unknown[]) => {
      void args;
      return {};
    }),
    touchUserSendInDb: vi.fn(async () => {}),
    logger,
  };
});

vi.mock('../../localDb/ipc/messages.js', () => ({
  createMessage: mocks.createMessage,
}));

vi.mock('../../localDb/ipc/sessions.js', () => ({
  touchUserSendInDb: mocks.touchUserSendInDb,
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => mocks.logger,
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 16; i += 1) {
    await Promise.resolve();
  }
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeItem(
  clientId: string,
  text: string,
  patch: Partial<AgentInputQueuedMessage> = {},
): AgentInputQueuedMessage {
  return {
    clientId,
    text,
    persistedContent: text,
    model: 'claude-opus-4-7',
    effort: 'medium',
    permissionMode: 'default',
    workingDir: '/repo',
    chatMessage: {
      clientId,
      role: 'user',
      content: text,
      isStreaming: false,
      createdAt: '2026-06-07T00:00:00.000Z',
    },
    createOpts: {
      agentKind: 'claude-code',
      workingDir: '/repo',
      model: 'claude-opus-4-7',
      effort: 'medium',
      permissionMode: 'default',
      userPrompt: '',
      makerMemoryEnabled: true,
      displayReasoning: 'summarized',
    },
    ...patch,
  };
}

async function persistQueuedUserMessage(
  sessionId: string,
  sendOpts: Parameters<AgentInputCoordinatorDeps['sendToAgent']>[3],
): Promise<void> {
  const persist = sendOpts.persistUserMessage;
  if (!persist) return;
  (persist as { onPersisting?: () => void }).onPersisting?.();
  await mocks.createMessage(
    sessionId,
    {
      clientId: persist.clientId,
      role: 'user',
      content: persist.content,
      agentMeta: {
        delivery: persist.delivery,
        sdkSessionId: persist.sdkSessionId,
      },
    },
    { shouldBroadcast: persist.shouldBroadcast },
  );
  await persist.onPersisted?.();
}

function sendSuccess(source = 'test'): AgentInputSendResult {
  return { kind: 'session-dispatch', source, dispatched: true };
}

function hostSendFailure(
  code: AgentInputHostSendFailureCode,
  message: string,
  extra?: { busySessionIds?: string[] },
): AgentInputSendResult {
  return {
    kind: 'host-send',
    accepted: false,
    code,
    message,
    ...(extra?.busySessionIds ? { busySessionIds: extra.busySessionIds } : {}),
  };
}

function sessionDispatchFailure(context: string): AgentInputSendResult {
  return {
    kind: 'session-dispatch',
    source: 'maker-ipc',
    dispatched: false,
    reason: 'cancelled-before-dispatch',
    context,
    message: `Session send was cancelled before vendor dispatch: ${context}`,
  };
}

function sessionRunningError(): Error & { code: string } {
  return Object.assign(new Error('[SESSION_RUNNING] Session is already running a turn'), {
    code: 'SESSION_RUNNING',
  });
}

function createHarness() {
  let running = false;
  let pendingInteraction = false;
  let agentKind: 'claude-code' | 'codex' | null = 'claude-code';
  const projections: AgentInputProjection[] = [];

  const sendToAgent = vi.fn<AgentInputCoordinatorDeps['sendToAgent']>(async (sessionId, _message, _createOpts, sendOpts) => {
    await persistQueuedUserMessage(sessionId, sendOpts);
    running = true;
    return sendSuccess();
  });
  const steerToAgent = vi.fn<AgentInputCoordinatorDeps['steerToAgent']>(async () => {});
  const abortSession = vi.fn<AgentInputCoordinatorDeps['abortSession']>(async () => {});
  const getSdkSessionId = vi.fn<AgentInputCoordinatorDeps['getSdkSessionId']>(async () => 'sdk-session');
  const reconcileTurnIdle = vi.fn<NonNullable<AgentInputCoordinatorDeps['reconcileTurnIdle']>>(() => {});
  const beforeDispatchUserTurn = vi.fn<NonNullable<AgentInputCoordinatorDeps['beforeDispatchUserTurn']>>(() => {});
  const onUndispatchedUserTurn = vi.fn<NonNullable<AgentInputCoordinatorDeps['onUndispatchedUserTurn']>>(() => {});
  const onAcceptedQueuedMessage = vi.fn<NonNullable<AgentInputCoordinatorDeps['onAcceptedQueuedMessage']>>(() => {});
  const onDispatchedUserTurn = vi.fn<NonNullable<AgentInputCoordinatorDeps['onDispatchedUserTurn']>>(() => {});
  const noteSessionClearBoundary = vi.fn<NonNullable<AgentInputCoordinatorDeps['noteSessionClearBoundary']>>();
  const resolveSessionReferences = vi.fn<
    NonNullable<AgentInputCoordinatorDeps['resolveSessionReferences']>
  >(async () => []);
  const emitProjection = vi.fn((projection: AgentInputProjection) => {
    projections.push(projection);
  });

  let hasPendingCredentialSwitch: (() => boolean) | null = null;
  let screenUserMessage: NonNullable<AgentInputCoordinatorDeps['screenUserMessage']> | null = null;
  const onUserMessageBlocked = vi.fn<
    NonNullable<AgentInputCoordinatorDeps['onUserMessageBlocked']>
  >(() => {});
  const onUserMessageRewritten = vi.fn<
    NonNullable<AgentInputCoordinatorDeps['onUserMessageRewritten']>
  >(() => {});
  let hasAssistantProgressAfter:
    | ((sessionId: string, userClientId: string) => Promise<boolean>)
    | null = null;
  let loadQueueSnapshot: ((sessionId: string) => Promise<AgentInputQueuedMessage[]>) | null = null;
  let getPersistedClientIds: ((sessionId: string, clientIds: string[]) => Promise<Set<string>>) | undefined;
  const persistQueueSnapshot = vi.fn<
    NonNullable<AgentInputCoordinatorDeps['persistQueueSnapshot']>
  >();
  const coordinator = new AgentInputCoordinator({
    sendToAgent,
    steerToAgent,
    abortSession,
    isTurnRunning: () => running,
    reconcileTurnIdle,
    hasPendingInteraction: () => pendingInteraction,
    getAgentKind: () => agentKind,
    getSdkSessionId,
    hasAssistantProgressAfter: (sessionId, userClientId) =>
      hasAssistantProgressAfter
        ? hasAssistantProgressAfter(sessionId, userClientId)
        : Promise.resolve(false),
    beforeDispatchUserTurn,
    onUndispatchedUserTurn,
    onAcceptedQueuedMessage,
    onDispatchedUserTurn,
    noteSessionClearBoundary,
    resolveSessionReferences,
    hasPendingCredentialSwitch: () => hasPendingCredentialSwitch?.() === true,
    screenUserMessage: (sessionId, item) =>
      screenUserMessage ? screenUserMessage(sessionId, item) : Promise.resolve({ action: 'allow' }),
    onUserMessageBlocked,
    onUserMessageRewritten,
    emitProjection,
    persistQueueSnapshot,
    loadQueueSnapshot: (sessionId) =>
      loadQueueSnapshot ? loadQueueSnapshot(sessionId) : Promise.resolve([]),
    getPersistedClientIds: (sessionId, clientIds) =>
      getPersistedClientIds ? getPersistedClientIds(sessionId, clientIds) : Promise.resolve(new Set()),
  });

  return {
    coordinator,
    sendToAgent,
    steerToAgent,
    abortSession,
    getSdkSessionId,
    reconcileTurnIdle,
    beforeDispatchUserTurn,
    onUndispatchedUserTurn,
    onAcceptedQueuedMessage,
    onDispatchedUserTurn,
    noteSessionClearBoundary,
    resolveSessionReferences,
    emitProjection,
    projections,
    setRunning(value: boolean) {
      running = value;
    },
    setPendingInteraction(value: boolean) {
      pendingInteraction = value;
    },
    setAgentKind(value: 'claude-code' | 'codex' | null) {
      agentKind = value;
    },
    setHasPendingCredentialSwitch(fn: (() => boolean) | null) {
      hasPendingCredentialSwitch = fn;
    },
    onUserMessageBlocked,
    onUserMessageRewritten,
    setScreenUserMessage(
      fn: NonNullable<AgentInputCoordinatorDeps['screenUserMessage']> | null,
    ) {
      screenUserMessage = fn;
    },
    setHasAssistantProgressAfter(
      fn: ((sessionId: string, userClientId: string) => Promise<boolean>) | null,
    ) {
      hasAssistantProgressAfter = fn;
    },
    persistQueueSnapshot,
    setLoadQueueSnapshot(
      fn: ((sessionId: string) => Promise<AgentInputQueuedMessage[]>) | null,
    ) {
      loadQueueSnapshot = fn;
    },
    setGetPersistedClientIds(
      fn: ((sessionId: string, clientIds: string[]) => Promise<Set<string>>) | undefined,
    ) {
      getPersistedClientIds = fn;
    },
  };
}

function latestSnapshotClientIds(
  persistQueueSnapshot: ReturnType<typeof createHarness>['persistQueueSnapshot'],
): string[] {
  const call = persistQueueSnapshot.mock.calls.at(-1);
  if (!call) throw new Error('expected a persistQueueSnapshot call');
  return call[1].map((item) => item.clientId);
}

function latestProjection(projections: AgentInputProjection[]): AgentInputProjection {
  const latest = projections.at(-1);
  if (!latest) throw new Error('expected a projection');
  return latest;
}

function latestWarnPayload() {
  const call = mocks.logger.warn.mock.calls.at(-1);
  if (!call) throw new Error('expected a warn log');
  return call[1];
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AgentInputCoordinator trusted session reference snapshots', () => {
  const trustedContext = {
    sessionId: 'source-session',
    source: 'device-link' as const,
    deviceId: 'source-device',
    messages: [{ role: 'user' as const, content: 'authoritative remote history' }],
    range: 'recent' as const,
    messageCount: 1,
    truncated: false,
  };

  it('consumes the controller snapshot without re-resolving it on the controlled device', async () => {
    const h = createHarness();
    const item = makeItem('quoted-1', 'compare cindy://session/source-session', {
      persistedContent: JSON.stringify({ text: 'compare cindy://session/source-session' }),
      sessionRefs: [{ sessionId: 'source-session', deviceId: 'source-device' }],
      trustedSessionReferenceContexts: [trustedContext],
      sessionReferencesRequireTrustedSnapshot: true,
    });

    h.coordinator.enqueue('target-session', item);
    await flush();

    expect(h.resolveSessionReferences).not.toHaveBeenCalled();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.sendToAgent.mock.calls[0]?.[1])).toContain('authoritative remote history');
    expect(mocks.createMessage.mock.calls[0]?.[1]).toMatchObject({
      content: expect.stringContaining('"sessionReferences"'),
    });
  });

  it('fails closed instead of interpreting a controller ref against local SQLite', async () => {
    const h = createHarness();
    h.coordinator.enqueue('target-session', makeItem('quoted-2', 'compare cindy://session/source-session', {
      sessionRefs: [{ sessionId: 'source-session', deviceId: 'source-device' }],
      sessionReferencesRequireTrustedSnapshot: true,
    }));
    await flush();

    expect(h.resolveSessionReferences).not.toHaveBeenCalled();
    expect(h.sendToAgent).not.toHaveBeenCalled();
    expect(latestProjection(h.projections).error).toContain('snapshot is missing');
  });

  it('does not expose quoted history bodies through renderer projections', () => {
    const h = createHarness();
    h.setRunning(true);
    const projection = h.coordinator.enqueue('target-session', makeItem('quoted-3', 'queued quote', {
      sessionRefs: [{ sessionId: 'source-session', deviceId: 'source-device' }],
      trustedSessionReferenceContexts: [trustedContext],
      sessionReferencesRequireTrustedSnapshot: true,
    }));

    expect(projection.pendingQueue[0]?.sessionRefs).toHaveLength(1);
    expect(projection.pendingQueue[0]?.trustedSessionReferenceContexts).toBeUndefined();
    expect(projection.pendingQueue[0]?.sessionReferencesRequireTrustedSnapshot).toBeUndefined();
    expect(JSON.stringify(projection)).not.toContain('authoritative remote history');
  });

  it('uses the stored trusted snapshot when steering a projected queued item', async () => {
    const h = createHarness();
    const sid = 'target-session';
    h.setRunning(true);
    const projection = h.coordinator.enqueue(sid, makeItem('quoted-steer', 'queued quote', {
      sessionRefs: [{ sessionId: 'source-session', deviceId: 'source-device' }],
      trustedSessionReferenceContexts: [trustedContext],
      sessionReferencesRequireTrustedSnapshot: true,
    }));
    const projectedItem = projection.pendingQueue[0];

    expect(projectedItem?.trustedSessionReferenceContexts).toBeUndefined();
    expect(projectedItem?.sessionReferencesRequireTrustedSnapshot).toBeUndefined();
    await expect(h.coordinator.steer(sid, projectedItem!, { removeFromQueue: true })).resolves.toBe(true);

    expect(h.resolveSessionReferences).not.toHaveBeenCalled();
    expect(h.steerToAgent).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.steerToAgent.mock.calls[0]?.[1])).toContain('authoritative remote history');
    expect(latestProjection(h.projections).pendingQueue).toHaveLength(0);
  });

  it('merges a fresh device-link snapshot into a restored marker-only queued steer', async () => {
    const h = createHarness();
    const sid = 'target-session';
    h.setRunning(true);
    const refs = [{ sessionId: 'source-session', deviceId: 'source-device' }];
    h.coordinator.enqueue(sid, makeItem('quoted-restored', 'queued quote', {
      sessionRefs: refs,
      sessionReferencesRequireTrustedSnapshot: true,
    }));

    const incoming = makeItem('quoted-restored', 'queued quote', {
      sessionRefs: refs,
      trustedSessionReferenceContexts: [trustedContext],
      sessionReferencesRequireTrustedSnapshot: true,
    });
    await expect(h.coordinator.steer(sid, incoming, { removeFromQueue: true })).resolves.toBe(true);

    expect(h.resolveSessionReferences).not.toHaveBeenCalled();
    expect(h.steerToAgent).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(h.steerToAgent.mock.calls[0]?.[1])).toContain('authoritative remote history');
  });

  it('does not pass trusted reference bodies to crash-recovery persistence', async () => {
    const h = createHarness();
    const sid = 'target-session';
    await h.coordinator.ensureQueueRestored(sid);
    h.setRunning(true);

    h.coordinator.enqueue(sid, makeItem('quoted-persist', 'queued quote', {
      sessionRefs: [{ sessionId: 'source-session', deviceId: 'source-device' }],
      trustedSessionReferenceContexts: [trustedContext],
      sessionReferencesRequireTrustedSnapshot: true,
    }));
    await flush();

    const persisted = h.persistQueueSnapshot.mock.calls.at(-1)?.[1][0];
    expect(persisted?.trustedSessionReferenceContexts).toBeUndefined();
    expect(persisted?.sessionReferencesRequireTrustedSnapshot).toBe(true);
    expect(JSON.stringify(persisted)).not.toContain('authoritative remote history');
  });

  it('releases a stale trusted snapshot when a Ghost rewrite changes the visible reference', async () => {
    const h = createHarness();
    h.setScreenUserMessage(async () => ({
      action: 'rewrite',
      text: 'compare cindy://session/replacement',
      ghostId: 'ghost-1',
      ghostName: 'rewrite-test',
    }));
    h.coordinator.enqueue('target-session', makeItem('quoted-4', 'compare cindy://session/source-session', {
      sessionRefs: [{ sessionId: 'source-session', deviceId: 'source-device' }],
      trustedSessionReferenceContexts: [trustedContext],
      sessionReferencesRequireTrustedSnapshot: true,
    }));
    await flush();

    expect(h.resolveSessionReferences).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(latestProjection(h.projections).error).toBeNull();
  });

  it('clears a stale trusted snapshot on a full-content rewrite without refs', () => {
    const h = createHarness();
    const item = makeItem('quoted-content-rewrite', 'compare cindy://session/source-session', {
      sessionRefs: [{ sessionId: 'source-session', deviceId: 'source-device' }],
      trustedSessionReferenceContexts: [trustedContext],
      sessionReferencesRequireTrustedSnapshot: true,
    });
    h.coordinator.enqueue('target-session', item);

    h.coordinator.updateContent('target-session', item.clientId, makeItem(item.clientId, 'compare cindy://session/controller', {
      sessionRefs: [],
    }));

    const updated = latestProjection(h.projections).pendingQueue[0];
    expect(updated?.sessionRefs).toBeUndefined();
    expect(updated?.trustedSessionReferenceContexts).toBeUndefined();
    expect(updated?.sessionReferencesRequireTrustedSnapshot).toBeUndefined();
  });
});

describe('AgentInputCoordinator send transaction', () => {
  it('silently keeps a queue head when dispatch races with an already running turn', async () => {
    const h = createHarness();
    const sid = 'send-session-running-race';
    const first = makeItem('q-1', 'first');

    h.sendToAgent.mockImplementationOnce(async () => {
      h.setRunning(true);
      throw sessionRunningError();
    });

    h.coordinator.enqueue(sid, first);
    await flush();

    let projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(mocks.createMessage).not.toHaveBeenCalled();
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'first' });
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue).toEqual([]);
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();
  });

  it('silently keeps a queue head when host dispatch returns SESSION_RUNNING', async () => {
    const h = createHarness();
    const sid = 'send-session-running-host-result';
    const first = makeItem('q-1', 'first');

    h.sendToAgent.mockImplementationOnce(async () => {
      h.setRunning(true);
      return hostSendFailure('SESSION_RUNNING', '[SESSION_RUNNING] Session is already running a turn');
    });

    h.coordinator.enqueue(sid, first);
    await flush();

    let projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(mocks.createMessage).not.toHaveBeenCalled();
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'first' });
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue).toEqual([]);
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();
  });

  it('turns CREDENTIAL_SWITCH_BUSY into a visible wait and auto-dispatches when the blocker settles', async () => {
    // 回归锚点(2026-07-03 → 2026-07-04):凭证切换忙先被修成「可见错误 + 手动
    // Retry」;现在升级为**可见等待 + 自动派发** —— credentialSwitchWait 进
    // projection(renderer 显等待横幅),挡路会话 turn 结束(onExternalTurnSettled)
    // 自动重发。07-03 反对的是不可见假死,不是自动化;等待必须可见、可取消。
    const h = createHarness();
    const sid = 'send-credential-switch-busy';
    const first = makeItem('q-1', 'first');

    h.sendToAgent.mockImplementationOnce(async () =>
      hostSendFailure(
        'CREDENTIAL_SWITCH_BUSY',
        'CREDENTIAL_SWITCH_BUSY: Cannot switch Codex credential mode (oauth-bearer -> gateway-key) while local Codex session(s) are busy: other-session',
        { busySessionIds: ['other-session'] },
      ));

    h.coordinator.enqueue(sid, first);
    await flush();

    let projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(mocks.createMessage).not.toHaveBeenCalled();
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);
    // 等待态不是错误:error 为空,credentialSwitchWait 带挡路会话 ids。
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();
    expect(projection.credentialSwitchWait).toEqual({
      clientId: 'q-1',
      blockedBySessionIds: ['other-session'],
    });

    // 兜底定时器是 2s 档,300ms 内不应有静默重试(避免高频 lazy-create)。
    await wait(300);
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);

    // 无关会话结束不唤醒。
    h.coordinator.onExternalTurnSettled('unrelated-session');
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);

    // 挡路会话结束 → 自动重发,等待态清除。
    h.coordinator.onExternalTurnSettled('other-session');
    await flush();

    projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'first' });
    expect(projection.pendingQueue).toEqual([]);
    expect(projection.error).toBeNull();
    expect(projection.credentialSwitchWait).toBeNull();
  });

  it('queues an immediate compact while a pending credential switch is registered', async () => {
    // review P2(2026-07-04):compact() 的立即分支也要过 pending 门,否则 /compact
    // 会打到旧凭证形态的会话上;apply 完成后 wakeSession 放行。
    const h = createHarness();
    const sid = 'compact-pending-credential-switch';
    let pending = true;
    h.setHasPendingCredentialSwitch(() => pending);

    await h.coordinator.compact(sid, { agentKind: 'claude-code' } as never);
    await flush();
    expect(h.sendToAgent).not.toHaveBeenCalled();

    pending = false;
    h.coordinator.wakeSession(sid, 'pending-credential-switch-applied');
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({ type: 'user', content: '/compact' });
  });

  it('keeps the wait bound to its message: reorder clears it, removing another item does not', async () => {
    // review P2(2026-07-04):等待态必须按 clientId 绑定消息,不能绑定"队首"位置。
    // sendToAgent 持续返回 busy,模拟挡路任务贯穿整个交互过程。
    const h = createHarness();
    const sid = 'send-credential-switch-wait-binding';

    h.sendToAgent.mockImplementation(async () =>
      hostSendFailure('CREDENTIAL_SWITCH_BUSY', 'CREDENTIAL_SWITCH_BUSY: busy', {
        busySessionIds: ['other-session'],
      }));

    h.coordinator.enqueue(sid, makeItem('q-1', 'first'));
    await flush();
    h.coordinator.enqueue(sid, makeItem('q-2', 'second'));
    await flush();
    let projection = latestProjection(h.projections);
    expect(projection.credentialSwitchWait).toEqual({
      clientId: 'q-1',
      blockedBySessionIds: ['other-session'],
    });

    // 删除非等待项:等待保持,仍绑定 q-1。
    h.coordinator.remove(sid, 'q-2');
    await flush();
    projection = latestProjection(h.projections);
    expect(projection.credentialSwitchWait?.clientId).toBe('q-1');
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);

    // 重新排入 q-2 并拖到队首:q-1 不再是队首 → 旧等待清除,drain 为新队首 q-2
    // 撞同样的 busy 后以 q-2 的 clientId 重建等待。
    h.coordinator.enqueue(sid, makeItem('q-2', 'second'));
    await flush();
    h.coordinator.move(sid, 'q-2', 0);
    await flush();
    projection = latestProjection(h.projections);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-2', 'q-1']);
    expect(projection.credentialSwitchWait?.clientId).toBe('q-2');

    // 删除等待中的 q-2:该轮等待随消息一起取消;drain 随后为 q-1 重建自己的等待。
    h.coordinator.remove(sid, 'q-2');
    await flush();
    projection = latestProjection(h.projections);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);
    expect(projection.credentialSwitchWait?.clientId).toBe('q-1');
  });

  it('cancels the credential switch wait when the queued head is removed', async () => {
    const h = createHarness();
    const sid = 'send-credential-switch-busy-cancel';
    const first = makeItem('q-1', 'first');

    h.sendToAgent.mockImplementationOnce(async () =>
      hostSendFailure(
        'CREDENTIAL_SWITCH_BUSY',
        'CREDENTIAL_SWITCH_BUSY: busy',
        { busySessionIds: ['other-session'] },
      ));

    h.coordinator.enqueue(sid, first);
    await flush();
    expect(latestProjection(h.projections).credentialSwitchWait).not.toBeNull();

    // 删除队首 = 取消等待:等待态清除,挡路会话结束后也不再重发。
    h.coordinator.remove(sid, 'q-1');
    await flush();

    let projection = latestProjection(h.projections);
    expect(projection.pendingQueue).toEqual([]);
    expect(projection.credentialSwitchWait).toBeNull();

    h.coordinator.onExternalTurnSettled('other-session');
    await wait(50);
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    projection = latestProjection(h.projections);
    expect(projection.credentialSwitchWait).toBeNull();
  });

  it('clears a displaced credential-switch wait when continue is prepended ahead of the waited head', async () => {
    const h = createHarness();
    const sid = 'send-credential-switch-continue-prepend';

    h.sendToAgent.mockImplementation(async () =>
      hostSendFailure('CREDENTIAL_SWITCH_BUSY', 'CREDENTIAL_SWITCH_BUSY: busy', {
        busySessionIds: ['other-session'],
      }));

    h.coordinator.enqueue(sid, makeItem('q-1', 'first'));
    await flush();
    expect(latestProjection(h.projections).credentialSwitchWait).toEqual({
      clientId: 'q-1',
      blockedBySessionIds: ['other-session'],
    });

    h.coordinator.enqueue(sid, makeItem('q-continue', CONTINUE_AFTER_APP_EXIT_PROMPT));
    await flush();

    const projection = latestProjection(h.projections);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-continue', 'q-1']);
    // 旧 wait 目标已被顶走；drain 会为新队首重建 wait（仍 busy）。
    expect(projection.credentialSwitchWait?.clientId).toBe('q-continue');
  });

  it('retries a restored queue head when SESSION_RUNNING clears without a done event', async () => {
    const h = createHarness();
    const sid = 'send-session-running-retry-without-done';
    const first = makeItem('q-1', 'first');

    h.sendToAgent.mockImplementationOnce(async () => {
      h.setRunning(true);
      throw sessionRunningError();
    });

    h.coordinator.enqueue(sid, first);
    await flush();

    let projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();

    h.setRunning(false);
    await wait(300);
    await flush();

    projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'first' });
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue).toEqual([]);
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();
  });

  it('keeps retrying a restored queue head when a late done arrives before SESSION_RUNNING clears', async () => {
    const h = createHarness();
    const sid = 'send-session-running-late-done-before-idle';
    const first = makeItem('q-1', 'first');

    h.sendToAgent.mockImplementationOnce(async () => {
      h.setRunning(true);
      throw sessionRunningError();
    });

    h.coordinator.enqueue(sid, first);
    await flush();

    let projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);

    h.coordinator.onTurnEvent(sid, 'done');
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);

    h.setRunning(false);
    await wait(300);
    await flush();

    projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'first' });
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue).toEqual([]);
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();
  });

  it('drains queued input after an external turn error clears without a coordinator active turn', async () => {
    const h = createHarness();
    const sid = 'external-turn-error-drains-queue';
    const first = makeItem('q-1', 'first');

    h.setRunning(true);
    h.coordinator.enqueue(sid, first);
    await flush();

    let projection = latestProjection(h.projections);
    expect(h.sendToAgent).not.toHaveBeenCalled();
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);

    h.coordinator.onTurnEvent(sid, 'error', 'compact failed');
    await flush();
    expect(h.sendToAgent).not.toHaveBeenCalled();

    h.setRunning(false);
    await wait(300);
    await flush();

    projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({ type: 'user', content: 'first' });
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue).toEqual([]);
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();
  });

  it('keeps the external terminal error visible when the paired done follows (claude-code)', async () => {
    // 外部发起的 turn(scheduler/goal 直调 Session.send, coordinator 无 activeTurn)
    // 失败时, claude-code 的收尾是 terminal error → 紧随的 done 连发(与 codex 同构)。
    // 回归: 此前 pendingExternalTerminalDone 只对 codex 打标, claude 的 done 会落到
    // `state.error = null` 的尾部分支, projection 在 renderer 处理 done 事件前把
    // makerChatStore.error 清掉 → 失败的自动化 turn 又被通知成"已完成"。
    vi.useFakeTimers();
    try {
      const h = createHarness(); // harness 默认 agentKind = 'claude-code'
      const sid = 'external-turn-error-paired-done-claude';

      h.setRunning(true);
      h.coordinator.onTurnEvent(sid, 'error', 'model not available');
      await flush();
      let projection = latestProjection(h.projections);
      expect(projection.error).toBe('model not available');

      h.setRunning(false);
      h.coordinator.onTurnEvent(sid, 'done');
      await flush();
      projection = latestProjection(h.projections);
      // 配对 done 走 paired-done 分支: 清标记但保留 error, 不发 error:null 的 projection。
      expect(projection.error).toBe('model not available');

      // 标记已清, 后续入队照常派发(drain 不被残留标记卡死)。
      h.coordinator.enqueue(sid, makeItem('q-after-error', 'next'));
      await flush();
      await vi.advanceTimersByTimeAsync(300);
      await flush();
      expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the external terminal-done guard via fallback when no done follows (claude-code)', async () => {
    // claude 个别收尾只发 error 不发 done(empty-response / event loop crash)。
    // pendingExternalTerminalDone 的 250ms fallback timer 必须自清, 否则 drain 被
    // isDispatchBoundaryBusy 永久卡住。
    vi.useFakeTimers();
    try {
      const h = createHarness();
      const sid = 'external-turn-error-fallback-claude';

      h.setRunning(true);
      h.coordinator.onTurnEvent(sid, 'error', 'empty response');
      await flush();
      h.setRunning(false);
      // done 不会来, error 在 fallback 窗口内保持可见。
      expect(latestProjection(h.projections).error).toBe('empty response');

      // fallback timer(250ms)自清标记后, 新入队消息照常派发(drain 不被卡死);
      // 新派发按既有语义清掉旧 error banner。
      h.coordinator.enqueue(sid, makeItem('q-after-fallback', 'next'));
      await flush();
      await vi.advanceTimersByTimeAsync(300);
      await flush();
      expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not drain queued input after session close cancels external terminal-error wakeups', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      const sid = 'external-turn-error-close-cancels-drain';
      const first = makeItem('q-1', 'first');

      h.setRunning(true);
      h.coordinator.enqueue(sid, first);
      await flush();

      let projection = latestProjection(h.projections);
      expect(h.sendToAgent).not.toHaveBeenCalled();
      expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);

      h.coordinator.onTurnEvent(sid, 'error', 'compact failed');
      h.coordinator.onSessionClosed(sid);
      h.setRunning(false);
      await flush();
      await vi.advanceTimersByTimeAsync(300);
      await flush();

      projection = latestProjection(h.projections);
      expect(h.sendToAgent).not.toHaveBeenCalled();
      expect(mocks.createMessage).not.toHaveBeenCalled();
      expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);
      expect(projection.queueAbortPending).toBe(false);
      expect(projection.error).toBe('compact failed');
      expect(projection.recovery).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for paired Codex done before draining after an external terminal error', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      h.setAgentKind('codex');
      const sid = 'external-codex-error-waits-for-paired-done';
      const first = makeItem('q-1', 'first');

      h.setRunning(true);
      h.coordinator.enqueue(sid, first);
      await flush();

      let projection = latestProjection(h.projections);
      expect(h.sendToAgent).not.toHaveBeenCalled();
      expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);

      h.setRunning(false);
      h.coordinator.onTurnEvent(sid, 'error', 'compact failed');
      await flush();
      await vi.advanceTimersByTimeAsync(100);
      await flush();

      expect(h.sendToAgent).not.toHaveBeenCalled();
      projection = latestProjection(h.projections);
      expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);

      h.coordinator.onTurnEvent(sid, 'done');
      await flush();

      expect(h.sendToAgent).toHaveBeenCalledTimes(1);
      expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({ type: 'user', content: 'first' });
      expect(mocks.createMessage).toHaveBeenCalledTimes(1);

      h.setRunning(false);
      h.coordinator.onTurnEvent(sid, 'error', 'new turn failed');
      await flush();

      projection = latestProjection(h.projections);
      expect(projection.error).toBe('new turn failed');
      expect(projection.recovery).toEqual({ kind: 'active-turn', item: first });
      await vi.advanceTimersByTimeAsync(300);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the external Claude terminal error visible when the paired done follows', async () => {
    // P2 回归(PR #485): claude-code 失败收尾现已与 codex 对齐成 error → done 连发。
    // 外部发起的 turn(scheduler/goal 直调 Session.send, coordinator 无 active turn)
    // 失败时, 配对 done 必须走 pendingExternalTerminalDone 分支保留 state.error——
    // 之前该标记只对 codex 打, claude 的 done 会落到尾部 `state.error = null` 的
    // projection, 在 renderer 处理 done 事件前把 makerChatStore.error 清掉, 失败的
    // 自动化 turn 又被通知成"已完成"。
    const h = createHarness(); // 默认 agentKind='claude-code'
    const sid = 'external-claude-error-paired-done';

    h.coordinator.onTurnEvent(sid, 'error', 'claude turn failed');
    await flush();
    let projection = latestProjection(h.projections);
    expect(projection.error).toBe('claude turn failed');

    h.coordinator.onTurnEvent(sid, 'done');
    await flush();
    projection = latestProjection(h.projections);
    expect(projection.error, 'paired done must NOT wipe the terminal error projection').toBe('claude turn failed');
  });

  it('falls back and drains after a Codex terminal error when no done follows', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      h.setAgentKind('codex');
      const sid = 'external-codex-error-without-done-drains';
      const first = makeItem('q-1', 'first');

      h.setRunning(true);
      h.coordinator.enqueue(sid, first);
      await flush();

      h.setRunning(false);
      h.coordinator.onTurnEvent(sid, 'error', 'turn/start failed');
      await flush();

      expect(h.sendToAgent).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(300);
      await flush();

      const projection = latestProjection(h.projections);
      expect(h.sendToAgent).toHaveBeenCalledTimes(1);
      expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({ type: 'user', content: 'first' });
      expect(mocks.createMessage).toHaveBeenCalledTimes(1);
      expect(projection.pendingQueue).toEqual([]);
      expect(projection.error).toBeNull();
      expect(projection.recovery).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains queued input when an external live reservation clears without a terminal event', async () => {
    const h = createHarness();
    const sid = 'external-reservation-drains-queue';
    const first = makeItem('q-1', 'first');

    h.setRunning(true);
    h.coordinator.enqueue(sid, first);
    await flush();

    let projection = latestProjection(h.projections);
    expect(h.sendToAgent).not.toHaveBeenCalled();
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);

    h.setRunning(false);
    await wait(300);
    await flush();

    projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({ type: 'user', content: 'first' });
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue).toEqual([]);
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();
  });

  it('does not drain a queued input after session close cancels external-turn retry', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      const sid = 'external-reservation-close-cancels-queue-retry';
      const first = makeItem('q-1', 'first');

      h.setRunning(true);
      h.coordinator.enqueue(sid, first);
      await flush();

      let projection = latestProjection(h.projections);
      expect(h.sendToAgent).not.toHaveBeenCalled();
      expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);

      h.coordinator.onSessionClosed(sid);
      h.setRunning(false);
      await vi.advanceTimersByTimeAsync(300);
      await flush();

      projection = latestProjection(h.projections);
      expect(h.sendToAgent).not.toHaveBeenCalled();
      expect(mocks.createMessage).not.toHaveBeenCalled();
      expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);
      expect(projection.queueAbortPending).toBe(false);
      expect(projection.error).toBeNull();
      expect(projection.recovery).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a queued follow-up after turn done when an external live reservation clears without a terminal event', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      const sid = 'turn-done-external-reservation-drains-queue';
      const first = makeItem('q-1', 'first');
      const second = makeItem('q-2', 'second');

      h.coordinator.enqueue(sid, first);
      await flush();
      h.coordinator.enqueue(sid, second);
      await flush();

      let projection = latestProjection(h.projections);
      expect(h.sendToAgent).toHaveBeenCalledTimes(1);
      expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-2']);

      h.setRunning(false);
      h.coordinator.onTurnEvent(sid, 'done');
      h.setRunning(true);
      await flush();
      expect(h.sendToAgent).toHaveBeenCalledTimes(1);

      h.setRunning(false);
      await vi.advanceTimersByTimeAsync(300);
      await flush();

      projection = latestProjection(h.projections);
      expect(h.sendToAgent).toHaveBeenCalledTimes(2);
      expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'second' });
      expect(mocks.createMessage).toHaveBeenCalledTimes(2);
      expect(projection.pendingQueue).toEqual([]);
      expect(projection.error).toBeNull();
      expect(projection.recovery).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a resumed paused queue when an external live reservation clears without a terminal event', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      const sid = 'resume-paused-external-reservation';
      const first = makeItem('q-1', 'first');

      h.setRunning(true);
      h.coordinator.enqueue(sid, first);
      await flush();

      h.coordinator.stop(sid, { keepQueue: true, pauseQueue: true });
      h.setRunning(false);
      await flush();
      await vi.advanceTimersByTimeAsync(300);
      await flush();

      let projection = latestProjection(h.projections);
      expect(h.sendToAgent).not.toHaveBeenCalled();
      expect(projection.queuePaused).toBe(true);
      expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);

      h.setRunning(true);
      h.coordinator.resume(sid);
      await flush();
      expect(h.sendToAgent).not.toHaveBeenCalled();

      h.setRunning(false);
      await vi.advanceTimersByTimeAsync(300);
      await flush();

      projection = latestProjection(h.projections);
      expect(h.sendToAgent).toHaveBeenCalledTimes(1);
      expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({ type: 'user', content: 'first' });
      expect(mocks.createMessage).toHaveBeenCalledTimes(1);
      expect(projection.pendingQueue).toEqual([]);
      expect(projection.error).toBeNull();
      expect(projection.recovery).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries an interaction-unlocked queue when an external live reservation clears without a terminal event', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      const sid = 'interaction-unlock-external-reservation';
      const first = makeItem('q-1', 'first');

      h.setRunning(true);
      h.coordinator.setInteractionLock(sid, 'modal', true);
      h.coordinator.enqueue(sid, first);
      await flush();

      let projection = latestProjection(h.projections);
      expect(h.sendToAgent).not.toHaveBeenCalled();
      expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);

      h.coordinator.setInteractionLock(sid, 'modal', false);
      await flush();
      expect(h.sendToAgent).not.toHaveBeenCalled();

      h.setRunning(false);
      await vi.advanceTimersByTimeAsync(300);
      await flush();

      projection = latestProjection(h.projections);
      expect(h.sendToAgent).toHaveBeenCalledTimes(1);
      expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({ type: 'user', content: 'first' });
      expect(mocks.createMessage).toHaveBeenCalledTimes(1);
      expect(projection.pendingQueue).toEqual([]);
      expect(projection.error).toBeNull();
      expect(projection.recovery).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries an edit-unlocked queue head when an external live reservation clears without a terminal event', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      const sid = 'edit-unlock-external-reservation';
      const first = makeItem('q-1', 'first');

      h.setRunning(true);
      h.coordinator.setEditLock(sid, first.clientId, true);
      h.coordinator.enqueue(sid, first);
      await flush();

      h.setRunning(false);
      await vi.advanceTimersByTimeAsync(300);
      await flush();

      let projection = latestProjection(h.projections);
      expect(h.sendToAgent).not.toHaveBeenCalled();
      expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);

      h.setRunning(true);
      h.coordinator.setEditLock(sid, first.clientId, false);
      await flush();
      expect(h.sendToAgent).not.toHaveBeenCalled();

      h.setRunning(false);
      await vi.advanceTimersByTimeAsync(300);
      await flush();

      projection = latestProjection(h.projections);
      expect(h.sendToAgent).toHaveBeenCalledTimes(1);
      expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({ type: 'user', content: 'first' });
      expect(mocks.createMessage).toHaveBeenCalledTimes(1);
      expect(projection.pendingQueue).toEqual([]);
      expect(projection.error).toBeNull();
      expect(projection.recovery).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows a new retry after a stale retry timer sees a generation change', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      const sid = 'stale-retry-generation';
      const first = makeItem('q-1', 'first');
      const sdkSession = deferred<string>();

      h.getSdkSessionId.mockImplementationOnce(async () => sdkSession.promise);

      h.setRunning(true);
      h.coordinator.enqueue(sid, first);
      await flush();

      let projection = latestProjection(h.projections);
      expect(h.sendToAgent).not.toHaveBeenCalled();
      expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);

      h.setRunning(false);
      h.coordinator.onTurnEvent(sid, 'done');
      await flush();
      h.setRunning(true);
      h.coordinator.stop(sid, { keepQueue: true, pauseQueue: false });
      await vi.advanceTimersByTimeAsync(300);
      await flush();
      expect(h.sendToAgent).not.toHaveBeenCalled();

      h.setRunning(true);
      h.coordinator.onTurnEvent(sid, 'error', 'reservation failed');
      await flush();
      expect(h.sendToAgent).not.toHaveBeenCalled();

      h.setRunning(false);
      await vi.advanceTimersByTimeAsync(300);
      await flush();

      projection = latestProjection(h.projections);
      expect(h.sendToAgent).toHaveBeenCalledTimes(1);
      expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({ type: 'user', content: 'first' });
      expect(mocks.createMessage).toHaveBeenCalledTimes(1);
      expect(projection.pendingQueue).toEqual([]);
      expect(projection.error).toBeNull();
      expect(projection.recovery).toBeNull();
      sdkSession.resolve('sdk-session');
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces a stale retry timer before it fires after a generation change', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      const sid = 'replace-stale-retry-generation';
      const first = makeItem('q-1', 'first');
      const sdkSession = deferred<string>();

      h.getSdkSessionId.mockImplementationOnce(async () => sdkSession.promise);

      h.setRunning(true);
      h.coordinator.enqueue(sid, first);
      await flush();

      let projection = latestProjection(h.projections);
      expect(h.sendToAgent).not.toHaveBeenCalled();
      expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);

      h.setRunning(false);
      h.coordinator.onTurnEvent(sid, 'done');
      await flush();
      h.setRunning(true);
      h.coordinator.stop(sid, { keepQueue: true, pauseQueue: false });
      await flush();

      h.coordinator.onTurnEvent(sid, 'error', 'reservation failed');
      await flush();
      expect(h.sendToAgent).not.toHaveBeenCalled();

      h.setRunning(false);
      await vi.advanceTimersByTimeAsync(300);
      await flush();

      projection = latestProjection(h.projections);
      expect(h.sendToAgent).toHaveBeenCalledTimes(1);
      expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({ type: 'user', content: 'first' });
      expect(mocks.createMessage).toHaveBeenCalledTimes(1);
      expect(projection.pendingQueue).toEqual([]);
      expect(projection.error).toBeNull();
      expect(projection.recovery).toBeNull();
      sdkSession.resolve('sdk-session');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps Orca origin metadata in pending queue projections', async () => {
    const h = createHarness();
    const sid = 'orca-origin';
    h.setRunning(true);

    h.coordinator.enqueue(sid, makeItem('q-orca', '[From Orca Lead]\nhello', {
      persistedContent: JSON.stringify({ orcaSource: 'lead', content: 'hello' }),
      origin: { kind: 'orca', senderLabel: 'Lead', displayText: 'hello' },
    }));

    expect(latestProjection(h.projections).pendingQueue[0]?.origin).toEqual({
      kind: 'orca',
      senderLabel: 'Lead',
      displayText: 'hello',
    });
  });

  it('persists queued Orca messages with persistedContent and not agent-facing text', async () => {
    const h = createHarness();
    const sid = 'orca-persisted-content';
    const item = makeItem('q-orca', '[From Orca Lead]\nhello', {
      persistedContent: JSON.stringify({ orcaSource: 'lead', content: 'hello' }),
      origin: { kind: 'orca', senderLabel: 'Lead', displayText: 'hello' },
    });

    h.coordinator.enqueue(sid, item);
    await flush();

    expect(mocks.createMessage).toHaveBeenCalledWith(
      sid,
      expect.objectContaining({
        clientId: 'q-orca',
        content: JSON.stringify({ orcaSource: 'lead', content: 'hello' }),
      }),
      expect.anything(),
    );
    expect(mocks.createMessage).not.toHaveBeenCalledWith(
      sid,
      expect.objectContaining({ content: '[From Orca Lead]\nhello' }),
      expect.anything(),
    );
  });

  it('notifies host when a queued message crosses the accepted persistence boundary', async () => {
    const h = createHarness();
    const sid = 'orca-accepted-callback';
    const item = makeItem('q-orca', 'hello', {
      origin: { kind: 'orca', senderLabel: 'Lead' },
    });

    h.coordinator.enqueue(sid, item);
    await flush();

    expect(h.onAcceptedQueuedMessage).toHaveBeenCalledWith(sid, item);
  });

  it('awaits async onAcceptedQueuedMessage side effects before the accepted boundary resolves', async () => {
    const h = createHarness();
    const sid = 'orca-accepted-await';
    let callbackDone = false;
    h.onAcceptedQueuedMessage.mockImplementation(async () => {
      await Promise.resolve();
      await Promise.resolve();
      callbackDone = true;
    });
    // 副作用(置 running / autoBridgePending)必须先于 turn 启动完成: persist hook 链
    // resolve 时回调必须已经执行完, 否则快 worker 会在状态可见前结束 turn。
    let callbackDoneAtSendResolve: boolean | null = null;
    h.sendToAgent.mockImplementation(async (sessionId, _message, _createOpts, sendOpts) => {
      await persistQueuedUserMessage(sessionId, sendOpts);
      callbackDoneAtSendResolve = callbackDone;
      return sendSuccess();
    });

    h.coordinator.enqueue(sid, makeItem('q-await', 'hello', {
      origin: { kind: 'orca', senderLabel: 'Lead' },
    }));
    await flush();

    expect(callbackDoneAtSendResolve).toBe(true);
  });

  it('awaits the pre-dispatch hook after persistence and before vendor dispatch', async () => {
    const h = createHarness();
    const sid = 'before-dispatch-user-turn';
    const item = makeItem('q-before-dispatch', 'hello');
    const events: string[] = [];
    h.beforeDispatchUserTurn.mockImplementation(async () => {
      events.push('before-dispatch:start');
      await Promise.resolve();
      events.push('before-dispatch:end');
    });
    h.onAcceptedQueuedMessage.mockImplementation(() => {
      events.push('accepted-side-effect');
    });
    h.sendToAgent.mockImplementation(async (sessionId, _message, _createOpts, sendOpts) => {
      await persistQueuedUserMessage(sessionId, sendOpts);
      events.push('vendor-dispatch');
      return sendSuccess();
    });

    h.coordinator.enqueue(sid, item);
    await flush();

    expect(h.beforeDispatchUserTurn).toHaveBeenCalledWith(sid, item);
    expect(events).toEqual([
      'before-dispatch:start',
      'before-dispatch:end',
      'accepted-side-effect',
      'vendor-dispatch',
    ]);
    const createMessageOrder = mocks.createMessage.mock.invocationCallOrder[0];
    const beforeDispatchOrder = h.beforeDispatchUserTurn.mock.invocationCallOrder[0];
    expect(createMessageOrder).toBeDefined();
    expect(beforeDispatchOrder).toBeDefined();
    expect(createMessageOrder!).toBeLessThan(beforeDispatchOrder!);
  });

  it('logs dropped queued Orca messages when stop clears the queue', () => {
    const h = createHarness();
    const sid = 'orca-stop-drop';
    h.setRunning(true);
    h.coordinator.enqueue(sid, makeItem('q-orca', 'hello', {
      origin: { kind: 'orca', senderLabel: 'developer', displayText: 'hello' },
    }));

    h.coordinator.stop(sid);

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'dropping queued Orca message on stop',
      {
        sessionId: sid,
        clientId: 'q-orca',
        senderLabel: 'developer',
      },
    );
  });

  it('persists a user bubble only after maker-core accepts the turn', async () => {
    const h = createHarness();
    const sid = 'send-accepted';
    const first = makeItem('q-1', 'hello');
    const accepted = deferred<void>();
    h.sendToAgent.mockImplementationOnce(async (sessionId, _message, _createOpts, sendOpts) => {
      await accepted.promise;
      await persistQueuedUserMessage(sessionId, sendOpts);
      h.setRunning(true);
      return sendSuccess();
    });

    h.coordinator.enqueue(sid, first, { sendAtMs: 123 });
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent).toHaveBeenCalledWith(
      sid,
      { type: 'user', content: 'hello' },
      first.createOpts,
      expect.objectContaining({ userName: undefined, throwOnStartFailure: true }),
    );
    expect(mocks.touchUserSendInDb).toHaveBeenCalledWith(sid, 123);
    expect(mocks.createMessage).not.toHaveBeenCalled();
    expect(latestProjection(h.projections).pendingQueue).toEqual([]);

    accepted.resolve();
    await flush();

    expect(mocks.createMessage).toHaveBeenCalledWith(
      sid,
      expect.objectContaining({
        clientId: first.clientId,
        role: 'user',
        content: 'hello',
        agentMeta: expect.objectContaining({
          delivery: 'turn',
          sdkSessionId: 'sdk-session',
        }),
      }),
      expect.objectContaining({ shouldBroadcast: expect.any(Function) }),
    );
  });

  it('dispatches silent compact without persisting a user bubble', async () => {
    const h = createHarness();
    const sid = 'compact-silent';
    const createOpts = makeItem('q-compact', 'ignored').createOpts;

    await h.coordinator.compact(sid, createOpts, { userName: 'Carol' });
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledWith(
      sid,
      { type: 'user', content: '/compact' },
      createOpts,
      expect.objectContaining({
        userName: 'Carol',
        throwOnStartFailure: true,
      }),
    );
    expect(h.sendToAgent.mock.calls[0]?.[3].persistUserMessage).toBeUndefined();
    expect(mocks.createMessage).not.toHaveBeenCalled();
    expect(latestProjection(h.projections).pendingQueue).toEqual([]);
  });

  it('blocks queued turns while silent compact is active until Done', async () => {
    const h = createHarness();
    const sid = 'compact-blocks-queue';
    const compactAccepted = deferred<AgentInputSendResult>();
    const createOpts = makeItem('q-compact', 'ignored').createOpts;

    h.sendToAgent.mockImplementationOnce(async () => compactAccepted.promise);

    const compactPromise = h.coordinator.compact(sid, createOpts);
    await flush();

    h.coordinator.enqueue(sid, makeItem('q-next', 'next'));
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(latestProjection(h.projections).pendingQueue.map((q) => q.clientId)).toEqual(['q-next']);

    compactAccepted.resolve(sendSuccess());
    await compactPromise;
    await flush();
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'next' });
  });

  it('queues silent compact requested during an active turn and dispatches it after that turn', async () => {
    const h = createHarness();
    const sid = 'compact-queued-during-active-turn';
    h.setRunning(true);

    await h.coordinator.compact(sid, makeItem('q-compact', 'ignored').createOpts, { userName: 'Carol' });
    await flush();

    expect(h.sendToAgent).not.toHaveBeenCalled();
    expect(mocks.createMessage).not.toHaveBeenCalled();
    expect(latestProjection(h.projections).error).toBeNull();

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent).toHaveBeenCalledWith(
      sid,
      { type: 'user', content: '/compact' },
      expect.anything(),
      expect.objectContaining({ userName: 'Carol', throwOnStartFailure: true }),
    );
    expect(h.sendToAgent.mock.calls[0]?.[3].persistUserMessage).toBeUndefined();
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });

  it('requeues silent compact when dispatch races with an already running turn', async () => {
    const h = createHarness();
    const sid = 'compact-session-running-race';
    const createOpts = makeItem('q-compact', 'ignored').createOpts;

    h.sendToAgent.mockImplementationOnce(async () => {
      h.setRunning(true);
      throw sessionRunningError();
    });

    await h.coordinator.compact(sid, createOpts, { userName: 'Carol' });
    await flush();

    let projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue).toEqual([]);
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent).toHaveBeenLastCalledWith(
      sid,
      { type: 'user', content: '/compact' },
      createOpts,
      expect.objectContaining({ userName: 'Carol', throwOnStartFailure: true }),
    );
    expect(h.sendToAgent.mock.calls[1]?.[3].persistUserMessage).toBeUndefined();
    expect(mocks.createMessage).not.toHaveBeenCalled();
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();
  });

  it('requeues silent compact when host dispatch returns SESSION_RUNNING', async () => {
    const h = createHarness();
    const sid = 'compact-session-running-host-result';
    const createOpts = makeItem('q-compact', 'ignored').createOpts;

    h.sendToAgent.mockImplementationOnce(async () => {
      h.setRunning(true);
      return hostSendFailure('SESSION_RUNNING', '[SESSION_RUNNING] Session is already running a turn');
    });

    await h.coordinator.compact(sid, createOpts, { userName: 'Carol' });
    await flush();

    let projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue).toEqual([]);
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent).toHaveBeenLastCalledWith(
      sid,
      { type: 'user', content: '/compact' },
      createOpts,
      expect.objectContaining({ userName: 'Carol', throwOnStartFailure: true }),
    );
    expect(h.sendToAgent.mock.calls[1]?.[3].persistUserMessage).toBeUndefined();
    expect(mocks.createMessage).not.toHaveBeenCalled();
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();
  });

  it('retries silent compact when SESSION_RUNNING clears without a done event', async () => {
    const h = createHarness();
    const sid = 'compact-session-running-retry-without-done';
    const createOpts = makeItem('q-compact', 'ignored').createOpts;

    h.sendToAgent.mockImplementationOnce(async () => {
      h.setRunning(true);
      throw sessionRunningError();
    });

    await h.coordinator.compact(sid, createOpts, { userName: 'Carol' });
    await flush();

    let projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue).toEqual([]);
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();

    h.setRunning(false);
    await wait(300);
    await flush();

    projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent).toHaveBeenLastCalledWith(
      sid,
      { type: 'user', content: '/compact' },
      createOpts,
      expect.objectContaining({ userName: 'Carol', throwOnStartFailure: true }),
    );
    expect(h.sendToAgent.mock.calls[1]?.[3].persistUserMessage).toBeUndefined();
    expect(mocks.createMessage).not.toHaveBeenCalled();
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();
  });

  it('drains queued silent compact when an external live reservation clears without a terminal event', async () => {
    const h = createHarness();
    const sid = 'external-reservation-drains-compact';
    const createOpts = makeItem('q-compact', 'ignored').createOpts;

    h.setRunning(true);
    await h.coordinator.compact(sid, createOpts, { userName: 'Carol' });
    await flush();

    let projection = latestProjection(h.projections);
    expect(h.sendToAgent).not.toHaveBeenCalled();
    expect(projection.pendingQueue).toEqual([]);
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();

    h.setRunning(false);
    await wait(300);
    await flush();

    projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent).toHaveBeenLastCalledWith(
      sid,
      { type: 'user', content: '/compact' },
      createOpts,
      expect.objectContaining({ userName: 'Carol', throwOnStartFailure: true }),
    );
    expect(h.sendToAgent.mock.calls[0]?.[3].persistUserMessage).toBeUndefined();
    expect(mocks.createMessage).not.toHaveBeenCalled();
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();
  });

  it('does not drain queued silent compact after session close cancels external terminal-error wakeups', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      const sid = 'external-turn-error-close-cancels-compact-drain';
      const createOpts = makeItem('q-compact', 'ignored').createOpts;

      h.setRunning(true);
      await h.coordinator.compact(sid, createOpts, { userName: 'Carol' });
      await flush();

      let projection = latestProjection(h.projections);
      expect(h.sendToAgent).not.toHaveBeenCalled();
      expect(projection.pendingQueue).toEqual([]);

      h.coordinator.onTurnEvent(sid, 'error', 'compact failed');
      h.coordinator.onSessionClosed(sid);
      h.setRunning(false);
      await flush();
      await vi.advanceTimersByTimeAsync(300);
      await flush();

      projection = latestProjection(h.projections);
      expect(h.sendToAgent).not.toHaveBeenCalled();
      expect(mocks.createMessage).not.toHaveBeenCalled();
      expect(projection.pendingQueue).toEqual([]);
      expect(projection.queueAbortPending).toBe(false);
      expect(projection.error).toBe('compact failed');
      expect(projection.recovery).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not drain queued silent compact after session close cancels external-turn retry', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      const sid = 'external-reservation-close-cancels-compact-retry';
      const createOpts = makeItem('q-compact', 'ignored').createOpts;

      h.setRunning(true);
      await h.coordinator.compact(sid, createOpts, { userName: 'Carol' });
      await flush();

      let projection = latestProjection(h.projections);
      expect(h.sendToAgent).not.toHaveBeenCalled();
      expect(projection.pendingQueue).toEqual([]);

      h.coordinator.onSessionClosed(sid);
      h.setRunning(false);
      await vi.advanceTimersByTimeAsync(300);
      await flush();

      projection = latestProjection(h.projections);
      expect(h.sendToAgent).not.toHaveBeenCalled();
      expect(mocks.createMessage).not.toHaveBeenCalled();
      expect(projection.pendingQueue).toEqual([]);
      expect(projection.queueAbortPending).toBe(false);
      expect(projection.error).toBeNull();
      expect(projection.recovery).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a queued silent compact after turn done when an external live reservation clears without a terminal event', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      const sid = 'turn-done-external-reservation-drains-compact';
      const first = makeItem('q-1', 'first');
      const createOpts = makeItem('q-compact', 'ignored').createOpts;

      h.coordinator.enqueue(sid, first);
      await flush();
      await h.coordinator.compact(sid, createOpts, { userName: 'Carol' });
      await flush();

      let projection = latestProjection(h.projections);
      expect(h.sendToAgent).toHaveBeenCalledTimes(1);
      expect(projection.pendingQueue).toEqual([]);

      h.setRunning(false);
      h.coordinator.onTurnEvent(sid, 'done');
      h.setRunning(true);
      await flush();
      expect(h.sendToAgent).toHaveBeenCalledTimes(1);

      h.setRunning(false);
      await vi.advanceTimersByTimeAsync(300);
      await flush();

      projection = latestProjection(h.projections);
      expect(h.sendToAgent).toHaveBeenCalledTimes(2);
      expect(h.sendToAgent).toHaveBeenLastCalledWith(
        sid,
        { type: 'user', content: '/compact' },
        createOpts,
        expect.objectContaining({ userName: 'Carol', throwOnStartFailure: true }),
      );
      expect(h.sendToAgent.mock.calls[1]?.[3].persistUserMessage).toBeUndefined();
      expect(mocks.createMessage).toHaveBeenCalledTimes(1);
      expect(projection.pendingQueue).toEqual([]);
      expect(projection.error).toBeNull();
      expect(projection.recovery).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs a queued silent compact after ordinary messages that were already queued before it', async () => {
    const h = createHarness();
    const sid = 'compact-after-existing-tail';
    h.setRunning(true);

    h.coordinator.enqueue(sid, makeItem('q-next', 'next'));
    await h.coordinator.compact(sid, makeItem('q-compact', 'ignored').createOpts);
    await flush();

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({ type: 'user', content: 'next' });

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: '/compact' });
    expect(h.sendToAgent.mock.calls[1]?.[3].persistUserMessage).toBeUndefined();
  });

  it('keeps queued compact behind a restored pre-dispatch message after session close', async () => {
    const h = createHarness();
    const sid = 'compact-after-restored-pre-dispatch-message';
    const lookupStarted = deferred<void>();
    const lookup = deferred<string | undefined>();

    h.getSdkSessionId.mockImplementationOnce(async () => {
      lookupStarted.resolve();
      return lookup.promise;
    });

    h.coordinator.enqueue(sid, makeItem('q-first', 'first'));
    await lookupStarted.promise;
    await h.coordinator.compact(sid, makeItem('q-compact', 'ignored').createOpts);
    h.coordinator.onSessionClosed(sid);

    lookup.resolve('sdk-session');
    await flush();

    const projection = latestProjection(h.projections);
    expect(h.sendToAgent).not.toHaveBeenCalled();
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-first']);
    expect(projection.recovery).toEqual({ kind: 'queue-head', clientId: 'q-first' });

    h.coordinator.retryLastError(sid);
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({ type: 'user', content: 'first' });

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: '/compact' });
    expect(h.sendToAgent.mock.calls[1]?.[3].persistUserMessage).toBeUndefined();
  });

  it('does not let removing a later queued message move compact before earlier queued messages', async () => {
    const h = createHarness();
    const sid = 'compact-remove-later-row';
    h.setRunning(true);

    h.coordinator.enqueue(sid, makeItem('q-before', 'before'));
    await h.coordinator.compact(sid, makeItem('q-compact', 'ignored').createOpts);
    h.coordinator.enqueue(sid, makeItem('q-after', 'after'));
    h.coordinator.remove(sid, 'q-after');
    await flush();

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({ type: 'user', content: 'before' });

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: '/compact' });
  });

  it('keeps queued compact behind an explicit active-turn retry', async () => {
    const h = createHarness();
    const sid = 'compact-after-active-turn-retry';
    const first = makeItem('q-first', 'first');

    h.coordinator.enqueue(sid, first);
    await flush();

    await h.coordinator.compact(sid, makeItem('q-compact', 'ignored').createOpts);
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(1);

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'error', 'turn failed');
    await flush();

    h.coordinator.retryLastError(sid);
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'first' });

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(3);
    expect(h.sendToAgent.mock.calls[2]?.[1]).toEqual({ type: 'user', content: '/compact' });
  });

  it('active-turn retry sends the hidden continue prompt when the failed turn made progress', async () => {
    const h = createHarness();
    const sid = 'retry-continue-with-progress';
    h.setHasAssistantProgressAfter(async () => true);

    // 原消息带 planMode=true:续跑 item 必须强制回普通执行,不得把隐藏指令
    // 路由进计划模式(review P2)。
    const original = makeItem('q-first', 'original long task');
    original.createOpts = { ...original.createOpts, planMode: true };
    h.coordinator.enqueue(sid, original);
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'error', 'turn failed');
    await flush();
    expect(latestProjection(h.projections).recovery?.kind).toBe('active-turn');

    await h.coordinator.retryLastError(sid);
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    // 续跑指令(共享英文常量,带 [UI_ACTION_TRIGGER] 隐藏前缀)替代原文重发 ——
    // 原始任务文本不再出现在第二次派发里。
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({
      type: 'user',
      content: CONTINUE_AFTER_ERROR_PROMPT,
    });
    expect(CONTINUE_AFTER_ERROR_PROMPT.startsWith('[UI_ACTION_TRIGGER]')).toBe(true);
    const persist = h.sendToAgent.mock.calls[1]?.[3]?.persistUserMessage;
    expect(persist?.content).toBe(CONTINUE_AFTER_ERROR_PROMPT);
    expect(h.sendToAgent.mock.calls[1]?.[2]?.planMode).toBe(false);
    expect(h.onDispatchedUserTurn.mock.calls[1]?.[1]?.originalSyntheticTrigger).toBe(
      'continue',
    );
  });

  it('active-turn retry falls back to resending the original text when the turn produced nothing', async () => {
    const h = createHarness();
    const sid = 'retry-continue-no-progress';
    h.setHasAssistantProgressAfter(async () => false);

    h.coordinator.enqueue(sid, makeItem('q-first', 'original task'));
    await flush();

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'error', 'turn failed');
    await flush();

    await h.coordinator.retryLastError(sid);
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'original task' });
  });

  it('queue-head retry never substitutes the continue prompt and redrains the original head', async () => {
    const h = createHarness();
    const sid = 'retry-continue-queue-head';
    h.setHasAssistantProgressAfter(async () => true);
    h.sendToAgent.mockResolvedValueOnce(hostSendFailure('SEND_FAILED', 'boom'));

    h.coordinator.enqueue(sid, makeItem('q-head', 'never dispatched'));
    await flush();
    expect(latestProjection(h.projections).recovery).toEqual({ kind: 'queue-head', clientId: 'q-head' });

    await h.coordinator.retryLastError(sid);
    await flush();

    // 队首消息从未送达 agent,续跑语义不成立 —— 必须原样重发。
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'never dispatched' });
  });

  it('enqueue after a terminal error abandons the active-turn retry and dispatches the new message', async () => {
    const h = createHarness();
    const sid = 'enqueue-abandons-active-turn-retry';

    h.coordinator.enqueue(sid, makeItem('q-first', 'original task'));
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'error', 'turn failed');
    await flush();
    expect(latestProjection(h.projections).recovery?.kind).toBe('active-turn');

    // 错误态下发新消息 = 用行动放弃重试:recovery/错误横幅清掉,新消息直接派发,
    // 不再默默排队等重试按钮(2026-07-13 假停止排队问题的产品语义修正)。
    h.coordinator.enqueue(sid, makeItem('q-next', 'brand new message'));
    await flush();

    const projection = latestProjection(h.projections);
    expect(projection.recovery).toBeNull();
    expect(projection.error).toBeNull();
    expect(projection.pendingQueue).toHaveLength(0);
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'brand new message' });

    // 新输入之后再点「重试」:recovery 已被放弃,retryLastError 必须 no-op,不得双发。
    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();
    await h.coordinator.retryLastError(sid);
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
  });

  it('enqueue keeps a queue-head recovery blocked (no silent resend of the failed head)', async () => {
    const h = createHarness();
    const sid = 'enqueue-preserves-queue-head-recovery';
    h.sendToAgent.mockResolvedValueOnce(hostSendFailure('SEND_FAILED', 'boom'));

    h.coordinator.enqueue(sid, makeItem('q-head', 'never dispatched'));
    await flush();
    expect(latestProjection(h.projections).recovery).toEqual({ kind: 'queue-head', clientId: 'q-head' });

    // queue-head recovery 语义不变:失败消息还躺在队首,新消息只排队,
    // 不触发对失败队首的静默重发。
    h.coordinator.enqueue(sid, makeItem('q-second', 'later message'));
    await flush();

    const projection = latestProjection(h.projections);
    expect(projection.recovery).toEqual({ kind: 'queue-head', clientId: 'q-head' });
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-head', 'q-second']);
  });

  it('does not clear an existing recovery when compact is requested', async () => {
    const h = createHarness();
    const sid = 'compact-preserves-recovery';
    const failed = makeItem('q-failed', 'failed');
    h.sendToAgent.mockRejectedValueOnce(new Error('send failed'));

    h.coordinator.enqueue(sid, failed);
    await flush();

    const before = latestProjection(h.projections);
    expect(before.recovery).toEqual({ kind: 'queue-head', clientId: 'q-failed' });

    h.sendToAgent.mockClear();
    await h.coordinator.compact(sid, makeItem('q-compact', 'ignored').createOpts);
    await flush();

    const after = latestProjection(h.projections);
    expect(h.sendToAgent).not.toHaveBeenCalled();
    expect(after.recovery).toEqual({ kind: 'queue-head', clientId: 'q-failed' });
    expect(after.errorRetryText).toBe('failed');
  });

  it('wakes queued turns after compact dispatch failure releases the active turn', async () => {
    const h = createHarness();
    const sid = 'compact-failure-wakes-queue';
    const compactFailed = deferred<AgentInputSendResult>();
    h.sendToAgent.mockImplementationOnce(async () => compactFailed.promise);

    const compactPromise = h.coordinator.compact(sid, makeItem('q-compact', 'ignored').createOpts);
    await flush();

    h.coordinator.enqueue(sid, makeItem('q-next', 'next'));
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);

    compactFailed.resolve(sessionDispatchFailure('COMPACT/dispatch'));
    await compactPromise;
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'next' });
  });

  it('releases compact active turn when close races before dispatch outcome', async () => {
    const h = createHarness();
    const sid = 'compact-close-before-dispatch-outcome';
    const compactAccepted = deferred<AgentInputSendResult>();
    h.sendToAgent.mockImplementationOnce(async () => compactAccepted.promise);

    const compactPromise = h.coordinator.compact(sid, makeItem('q-compact', 'ignored').createOpts);
    await flush();

    h.coordinator.enqueue(sid, makeItem('q-next', 'next'));
    h.coordinator.onSessionClosed(sid);
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);

    compactAccepted.resolve(sendSuccess());
    await compactPromise;
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'next' });
  });

  it('rolls back every pre-accept send failure to the queue head and retries by typed recovery', async () => {
    const h = createHarness();
    const sid = 'send-rollback';
    const first = makeItem('q-1', 'first');

    h.sendToAgent.mockRejectedValueOnce(new Error('ipc down'));

    h.coordinator.enqueue(sid, first);
    await flush();

    let projection = latestProjection(h.projections);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);
    expect(projection.error).toBe('ipc down');
    expect(projection.recovery).toEqual({ kind: 'queue-head', clientId: 'q-1' });
    expect(projection.errorRetryText).toBe('first');
    expect(mocks.createMessage).not.toHaveBeenCalled();

    h.coordinator.retryLastError(sid);
    await flush();

    projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(projection.pendingQueue).toHaveLength(0);
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
  });

  it('retries a queue-head recovery when an external live reservation clears without a terminal event', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      const sid = 'queue-head-retry-external-reservation';
      const first = makeItem('q-1', 'first');

      h.sendToAgent.mockRejectedValueOnce(new Error('ipc down'));

      h.coordinator.enqueue(sid, first);
      await flush();

      let projection = latestProjection(h.projections);
      expect(h.sendToAgent).toHaveBeenCalledTimes(1);
      expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);
      expect(projection.recovery).toEqual({ kind: 'queue-head', clientId: 'q-1' });

      h.setRunning(true);
      h.coordinator.retryLastError(sid);
      await flush();
      expect(h.sendToAgent).toHaveBeenCalledTimes(1);

      h.setRunning(false);
      await vi.advanceTimersByTimeAsync(300);
      await flush();

      projection = latestProjection(h.projections);
      expect(h.sendToAgent).toHaveBeenCalledTimes(2);
      expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'first' });
      expect(mocks.createMessage).toHaveBeenCalledTimes(1);
      expect(projection.pendingQueue).toEqual([]);
      expect(projection.error).toBeNull();
      expect(projection.recovery).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries an active-turn recovery when an external live reservation clears without a terminal event', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      const sid = 'active-turn-retry-external-reservation';
      const first = makeItem('q-1', 'first');

      h.coordinator.enqueue(sid, first);
      await flush();

      h.setRunning(false);
      h.coordinator.onTurnEvent(sid, 'error', 'turn failed');
      await flush();

      let projection = latestProjection(h.projections);
      expect(h.sendToAgent).toHaveBeenCalledTimes(1);
      expect(projection.recovery).toEqual({ kind: 'active-turn', item: first });

      h.setRunning(true);
      h.coordinator.retryLastError(sid);
      await flush();
      expect(h.sendToAgent).toHaveBeenCalledTimes(1);

      h.setRunning(false);
      await vi.advanceTimersByTimeAsync(300);
      await flush();

      projection = latestProjection(h.projections);
      expect(h.sendToAgent).toHaveBeenCalledTimes(2);
      expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'first' });
      expect(mocks.createMessage).toHaveBeenCalledTimes(2);
      expect(projection.pendingQueue).toEqual([]);
      expect(projection.error).toBeNull();
      expect(projection.recovery).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a host preflight failure recoverable with host-send code and no dispatch', async () => {
    const h = createHarness();
    const sid = 'host-preflight-failure';
    const first = makeItem('q-1', 'first');

    h.sendToAgent.mockResolvedValueOnce(hostSendFailure('WORKDIR_MISSING', 'working directory is missing'));

    h.coordinator.enqueue(sid, first);
    await flush();

    const projection = latestProjection(h.projections);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);
    expect(projection.recovery).toEqual({ kind: 'queue-head', clientId: 'q-1' });
    expect(projection.error).toContain('WORKDIR_MISSING');
    expect(projection.error).toContain('working directory is missing');
    expect(mocks.createMessage).not.toHaveBeenCalled();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(latestWarnPayload()).toEqual(expect.objectContaining({
      kind: 'host-send',
      code: 'WORKDIR_MISSING',
      clientId: 'q-1',
    }));
  });

  it('keeps a maker-core dispatch failure recoverable with session-dispatch reason and no dispatch', async () => {
    const h = createHarness();
    const sid = 'session-dispatch-failure';
    const first = makeItem('q-1', 'first');

    h.sendToAgent.mockResolvedValueOnce(sessionDispatchFailure('SEND/session-dispatch-failure/send'));

    h.coordinator.enqueue(sid, first);
    await flush();

    const projection = latestProjection(h.projections);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);
    expect(projection.recovery).toEqual({ kind: 'queue-head', clientId: 'q-1' });
    expect(projection.error).toContain('cancelled-before-dispatch');
    expect(projection.error).toContain('SEND/session-dispatch-failure/send');
    expect(mocks.createMessage).not.toHaveBeenCalled();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(latestWarnPayload()).toEqual(expect.objectContaining({
      kind: 'session-dispatch',
      source: 'maker-ipc',
      reason: 'cancelled-before-dispatch',
      context: 'SEND/session-dispatch-failure/send',
      clientId: 'q-1',
    }));
  });

  it('does not collapse host and maker-core dispatch failures into the same recovery text or log reason', async () => {
    const host = createHarness();
    const dispatch = createHarness();

    host.sendToAgent.mockResolvedValueOnce(hostSendFailure('WORKDIR_MISSING', 'working directory is missing'));
    host.coordinator.enqueue('host-failure-reason', makeItem('host-q', 'host'));
    await flush();
    const hostProjection = latestProjection(host.projections);
    const hostWarn = latestWarnPayload();

    dispatch.sendToAgent.mockResolvedValueOnce(sessionDispatchFailure('SEND/dispatch-failure-reason/send'));
    dispatch.coordinator.enqueue('dispatch-failure-reason', makeItem('dispatch-q', 'dispatch'));
    await flush();
    const dispatchProjection = latestProjection(dispatch.projections);
    const dispatchWarn = latestWarnPayload();

    expect(hostProjection.error).not.toBe(dispatchProjection.error);
    expect(hostWarn).toEqual(expect.objectContaining({ kind: 'host-send', code: 'WORKDIR_MISSING' }));
    expect(dispatchWarn).toEqual(expect.objectContaining({
      kind: 'session-dispatch',
      reason: 'cancelled-before-dispatch',
    }));
  });

  it('does not auto-retry a failed queue head from later enqueue or Cancel', async () => {
    const h = createHarness();
    const sid = 'send-rollback-blocks-auto-drain';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');

    h.sendToAgent.mockRejectedValueOnce(new Error('ipc down'));

    h.coordinator.enqueue(sid, first);
    await flush();

    h.coordinator.clearError(sid);
    h.coordinator.enqueue(sid, second);
    await flush();

    const projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(projection.error).toBeNull();
    expect(projection.recovery).toEqual({ kind: 'queue-head', clientId: 'q-1' });
    expect(projection.pendingQueue.map((q) => q.text)).toEqual(['first', 'second']);
  });

  it('ignores late done wakeups after a pre-accept rollback', async () => {
    const h = createHarness();
    const sid = 'send-rollback-late-done';
    const first = makeItem('q-1', 'first');

    h.sendToAgent.mockRejectedValueOnce(new Error('ipc down'));

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    const projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(projection.error).toBe('ipc down');
    expect(projection.recovery).toEqual({ kind: 'queue-head', clientId: 'q-1' });
    expect(projection.pendingQueue.map((q) => q.text)).toEqual(['first']);
  });

  it('does not lose the queue head when a stray done lands in the pre-dispatch drain window', async () => {
    const h = createHarness();
    const sid = 'send-stray-done-pre-dispatch';
    const first = makeItem('q-1', 'interjected');
    const sdkGate = deferred<string | undefined>();
    h.getSdkSessionId.mockReturnValueOnce(sdkGate.promise);

    // 空闲 enqueue → drain 同步切走队首、置 preparing activeTurn, 停在
    // getSdkSessionId await(2026-07-03 插话丢消息的窗口)。
    h.coordinator.enqueue(sid, first);
    await flush();
    expect(h.sendToAgent).not.toHaveBeenCalled();

    // 被打断旧 turn 的尾随 done 落进这个窗口: 不能清掉 preparing activeTurn,
    // 否则 drain 恢复后 isActiveTurnCurrent 失败静默 return, 消息蒸发。
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    sdkGate.resolve('sdk-session');
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({ type: 'user', content: 'interjected' });
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    const projection = latestProjection(h.projections);
    expect(projection.pendingQueue).toHaveLength(0);
    expect(projection.error).toBeNull();
  });

  it('ignores a stray done while the queue-head send is in flight before persistence', async () => {
    const h = createHarness();
    const sid = 'send-stray-done-in-flight';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const sendGate = deferred<void>();
    h.sendToAgent.mockImplementationOnce(async (sessionId, _message, _createOpts, sendOpts) => {
      await sendGate.promise;
      await persistQueuedUserMessage(sessionId, sendOpts);
      h.setRunning(true);
      return sendSuccess();
    });

    h.coordinator.enqueue(sid, first);
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);

    // 迟到 done 落在 send RPC 未决、持久化尚未开始的窗口: 忽略, 状态机由
    // in-flight send 的真实 outcome 驱动。
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    sendGate.resolve();
    await flush();
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);

    // activeTurn 必须存活到 dispatched: 后续排队消息要等真正的 done 边界。
    h.coordinator.enqueue(sid, second);
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'second' });
  });

  it('drains FIFO only after the accepted turn reaches a done boundary', async () => {
    const h = createHarness();
    const sid = 'send-fifo';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const accepted = deferred<void>();
    h.sendToAgent.mockImplementationOnce(async (sessionId, _message, _createOpts, sendOpts) => {
      await accepted.promise;
      await persistQueuedUserMessage(sessionId, sendOpts);
      h.setRunning(true);
      return sendSuccess();
    });

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(latestProjection(h.projections).pendingQueue.map((q) => q.text)).toEqual(['second']);

    accepted.resolve();
    await flush();

    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'second' });
    expect(mocks.createMessage).toHaveBeenCalledTimes(2);
  });

  it('suppresses late accepted persistence broadcast after clearSession advances the input generation', async () => {
    const h = createHarness();
    const sid = 'clear-before-accept';
    const first = makeItem('q-1', 'first');
    const accepted = deferred<void>();
    let shouldBroadcastResult: boolean | undefined;
    h.sendToAgent.mockImplementationOnce(async (sessionId, _message, _createOpts, sendOpts) => {
      await accepted.promise;
      const persist = sendOpts.persistUserMessage;
      shouldBroadcastResult = persist?.shouldBroadcast?.();
      await persistQueuedUserMessage(sessionId, sendOpts);
      h.setRunning(true);
      return sendSuccess();
    });

    h.coordinator.enqueue(sid, first);
    await flush();

    h.coordinator.clearSession(sid);
    accepted.resolve();
    await flush();

    const projection = latestProjection(h.projections);
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    expect(shouldBroadcastResult).toBe(false);
    expect(projection.pendingQueue).toEqual([]);
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();
  });

  it('arms the clear broadcast boundary before emitting the cleared projection', () => {
    const order: string[] = [];
    const h = createHarness();
    const sid = 'clear-boundary-before-projection';
    const clearedAt = '2026-06-20T12:00:00.000Z';
    h.noteSessionClearBoundary.mockImplementationOnce(() => {
      order.push('boundary');
    });
    h.emitProjection.mockImplementationOnce((projection: AgentInputProjection) => {
      order.push('projection');
      h.projections.push(projection);
    });

    h.coordinator.clearSession(sid, clearedAt);

    expect(h.noteSessionClearBoundary).toHaveBeenCalledWith(sid, clearedAt);
    expect(order).toEqual(['boundary', 'projection']);
    expect(latestProjection(h.projections).pendingQueue).toEqual([]);
  });

  it('suppresses local-db broadcasts if clearSession wins during accepted persistence', async () => {
    const h = createHarness();
    const sid = 'clear-during-persist';
    const first = makeItem('q-1', 'first');
    let shouldBroadcastResult: boolean | undefined;
    mocks.createMessage.mockImplementationOnce(async (...args: unknown[]) => {
      const opts = args[2] as { shouldBroadcast?: () => boolean } | undefined;
      h.coordinator.clearSession(sid);
      shouldBroadcastResult = opts?.shouldBroadcast?.();
      return {};
    });

    h.coordinator.enqueue(sid, first);
    await flush();

    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    expect(shouldBroadcastResult).toBe(false);
    expect(latestProjection(h.projections).pendingQueue).toEqual([]);
  });

  it('keeps Retry visible for accepted-turn errors with tail rows and drains the tail after Cancel', async () => {
    const h = createHarness();
    const sid = 'accepted-error-with-tail';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    await flush();

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'error', 'turn failed');
    await flush();

    let projection = latestProjection(h.projections);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-2']);
    expect(projection.error).toBe('turn failed');
    expect(projection.recovery).toEqual({ kind: 'active-turn', item: first });
    expect(projection.errorRetryText).toBe('first');
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);

    h.coordinator.clearError(sid);
    await flush();

    projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'second' });
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();
  });

  it('keeps an accepted user row out of the queue when vendor start fails after persistence', async () => {
    const h = createHarness();
    const sid = 'accepted-then-start-fails';
    const first = makeItem('q-1', 'first');

    h.sendToAgent.mockImplementationOnce(async (sessionId, _message, _createOpts, sendOpts) => {
      await persistQueuedUserMessage(sessionId, sendOpts);
      throw new Error('turn/start failed');
    });

    h.coordinator.enqueue(sid, first);
    await flush();

    const projection = latestProjection(h.projections);
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue).toEqual([]);
    expect(projection.error).toBe('turn/start failed');
    expect(projection.recovery).toEqual({ kind: 'active-turn', item: first });
    expect(projection.errorRetryText).toBe('first');
    expect(h.onUndispatchedUserTurn).toHaveBeenCalledWith(sid, first);
  });

  it('recovers a persisted turn when terminal error arrives before send resolves', async () => {
    const h = createHarness();
    const sid = 'terminal-before-send-resolve';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const persisted = deferred<void>();
    const sendSettled = deferred<void>();

    h.sendToAgent.mockImplementationOnce(async (sessionId, _message, _createOpts, sendOpts) => {
      await persistQueuedUserMessage(sessionId, sendOpts);
      persisted.resolve();
      await sendSettled.promise;
      return sendSuccess();
    });

    h.coordinator.enqueue(sid, first);
    await persisted.promise;
    h.coordinator.enqueue(sid, second);
    h.coordinator.onTurnEvent(sid, 'error', 'turn failed before send resolved');
    await flush();

    let projection = latestProjection(h.projections);
    expect(projection.error).toBe('turn failed before send resolved');
    expect(projection.recovery).toEqual({ kind: 'active-turn', item: first });
    expect(projection.errorRetryText).toBe('first');
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-2']);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);

    sendSettled.resolve();
    await flush();

    projection = latestProjection(h.projections);
    expect(projection.recovery).toEqual({ kind: 'active-turn', item: first });
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-2']);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
  });

  it('delays done behind ordinary send persistence and drains the tail only after persistence completes', async () => {
    const h = createHarness();
    const sid = 'send-done-before-persist-success';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const persistStarted = deferred<void>();
    const persistSucceeded = deferred<void>();

    h.sendToAgent.mockImplementationOnce(async (sessionId, _message, _createOpts, sendOpts) => {
      const persist = sendOpts.persistUserMessage;
      (persist as { onPersisting?: () => void } | undefined)?.onPersisting?.();
      persistStarted.resolve();
      await persistSucceeded.promise;
      await persistQueuedUserMessage(sessionId, sendOpts);
      return sendSuccess();
    });

    h.coordinator.enqueue(sid, first);
    await persistStarted.promise;
    h.coordinator.enqueue(sid, second);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    let projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-2']);

    persistSucceeded.resolve();
    await flush();

    projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(projection.pendingQueue).toEqual([]);
  });

  it('keeps an ordinary send delayed terminal error when done follows before persistence settles', async () => {
    const h = createHarness();
    const sid = 'send-error-wins-over-done-before-persist-success';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const persistStarted = deferred<void>();
    const persistSucceeded = deferred<void>();

    h.sendToAgent.mockImplementationOnce(async (sessionId, _message, _createOpts, sendOpts) => {
      const persist = sendOpts.persistUserMessage;
      (persist as { onPersisting?: () => void } | undefined)?.onPersisting?.();
      persistStarted.resolve();
      await persistSucceeded.promise;
      await persistQueuedUserMessage(sessionId, sendOpts);
      return sendSuccess();
    });

    h.coordinator.enqueue(sid, first);
    await persistStarted.promise;
    h.coordinator.enqueue(sid, second);
    h.coordinator.onTurnEvent(sid, 'error', 'agent failed before ordinary persist');
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    let projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-2']);
    expect(projection.error).toBe('agent failed before ordinary persist');
    expect(projection.recovery).toBeNull();

    persistSucceeded.resolve();
    await flush();

    projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-2']);
    expect(projection.error).toBe('agent failed before ordinary persist');
    expect(projection.recovery).toEqual({ kind: 'active-turn', item: first });
    expect(projection.errorRetryText).toBe('first');
  });

  it('keeps a persisted ordinary send recoverable when maker-core dispatch is cancelled', async () => {
    const h = createHarness();
    const sid = 'send-persisted-dispatch-failure';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const persisted = deferred<void>();
    const sendSettled = deferred<void>();

    h.sendToAgent.mockImplementationOnce(async (sessionId, _message, _createOpts, sendOpts) => {
      await persistQueuedUserMessage(sessionId, sendOpts);
      persisted.resolve();
      await sendSettled.promise;
      return sessionDispatchFailure('SEND/send-persisted-dispatch-failure/send');
    });

    h.coordinator.enqueue(sid, first);
    await persisted.promise;
    h.coordinator.enqueue(sid, second);
    sendSettled.resolve();
    await flush();

    const projection = latestProjection(h.projections);
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-2']);
    expect(projection.error).toContain('cancelled-before-dispatch');
    expect(projection.recovery).toEqual({ kind: 'active-turn', item: first });
    expect(projection.errorRetryText).toBe('first');
    expect(h.onUndispatchedUserTurn).toHaveBeenCalledWith(sid, first);
  });

  it('keeps a persisted ordinary send recoverable when a host failure is reported late', async () => {
    const h = createHarness();
    const sid = 'send-persisted-host-failure';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const persisted = deferred<void>();
    const sendSettled = deferred<void>();

    h.sendToAgent.mockImplementationOnce(async (sessionId, _message, _createOpts, sendOpts) => {
      await persistQueuedUserMessage(sessionId, sendOpts);
      persisted.resolve();
      await sendSettled.promise;
      return hostSendFailure('WORKDIR_MISSING', 'working directory disappeared after persistence');
    });

    h.coordinator.enqueue(sid, first);
    await persisted.promise;
    h.coordinator.enqueue(sid, second);
    sendSettled.resolve();
    await flush();

    const projection = latestProjection(h.projections);
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-2']);
    expect(projection.error).toContain('WORKDIR_MISSING');
    expect(projection.recovery).toEqual({ kind: 'active-turn', item: first });
    expect(projection.errorRetryText).toBe('first');
    expect(h.onUndispatchedUserTurn).toHaveBeenCalledWith(sid, first);
  });

  it('keeps ordinary send DB writes linear while draining queued turns', async () => {
    const h = createHarness();
    const sid = 'send-db-call-count-linear';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const third = makeItem('q-3', 'third');

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    h.coordinator.enqueue(sid, third);
    await flush();

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(3);
    expect(mocks.createMessage).toHaveBeenCalledTimes(3);
  });

  it('keeps a persisted Codex turn recoverable when Stop cancels before vendor dispatch', async () => {
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'persisted-cancelled-before-dispatch';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const persisted = deferred<void>();
    const cancelled = deferred<void>();

    h.sendToAgent.mockImplementationOnce(async (sessionId, _message, _createOpts, sendOpts) => {
      await persistQueuedUserMessage(sessionId, sendOpts);
      persisted.resolve();
      await cancelled.promise;
      return sessionDispatchFailure('SEND/persisted-cancelled-before-dispatch/send');
    });

    h.coordinator.enqueue(sid, first);
    await persisted.promise;
    h.coordinator.enqueue(sid, second);
    h.coordinator.stop(sid, { keepQueue: true, pauseQueue: true });

    cancelled.resolve();
    await flush();

    let projection = latestProjection(h.projections);
    expect(projection.queueAbortPending).toBe(false);
    expect(projection.queuePaused).toBe(true);
    expect(projection.pendingQueue).toEqual([second]);
    expect(projection.error).toContain('cancelled-before-dispatch');
    expect(projection.recovery).toEqual({ kind: 'active-turn', item: first });
    expect(h.onUndispatchedUserTurn).toHaveBeenCalledWith(sid, first);

    h.coordinator.resume(sid);
    await flush();

    projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue).toEqual([second]);
  });

  it('does not enter recovery when status=closed arrives before send outcome but send succeeds', async () => {
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'status-closed-before-successful-send-outcome';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const persisted = deferred<void>();
    const sendSettled = deferred<void>();

    h.sendToAgent.mockImplementationOnce(async (sessionId, _message, _createOpts, sendOpts) => {
      await persistQueuedUserMessage(sessionId, sendOpts);
      persisted.resolve();
      await sendSettled.promise;
      return sendSuccess('maker-ipc');
    });

    h.coordinator.enqueue(sid, first);
    await persisted.promise;
    h.coordinator.enqueue(sid, second);
    h.coordinator.stop(sid, { keepQueue: true, pauseQueue: true });
    h.coordinator.resume(sid);
    h.setRunning(false);
    h.coordinator.onSessionClosed(sid);
    await flush();

    let projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(projection.queueAbortPending).toBe(false);
    expect(projection.pendingQueue).toEqual([second]);
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();

    sendSettled.resolve();
    await flush();

    projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'second' });
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();
  });

  it('keeps a persisted active turn recoverable when status=closed arrives before dispatched:false send outcome', async () => {
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'status-closed-before-send-outcome';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const persisted = deferred<void>();
    const sendSettled = deferred<void>();

    h.sendToAgent.mockImplementationOnce(async (sessionId, _message, _createOpts, sendOpts) => {
      await persistQueuedUserMessage(sessionId, sendOpts);
      persisted.resolve();
      await sendSettled.promise;
      return sessionDispatchFailure('SEND/status-closed-before-send-outcome/send');
    });

    h.coordinator.enqueue(sid, first);
    await persisted.promise;
    h.coordinator.enqueue(sid, second);
    h.coordinator.stop(sid, { keepQueue: true, pauseQueue: true });
    h.coordinator.resume(sid);
    h.setRunning(false);
    h.coordinator.onSessionClosed(sid);
    await flush();

    let projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(projection.queueAbortPending).toBe(false);
    expect(projection.pendingQueue).toEqual([second]);
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();

    sendSettled.resolve();
    await flush();

    projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue).toEqual([second]);
    expect(projection.error).toContain('cancelled-before-dispatch');
    expect(projection.recovery).toEqual({ kind: 'active-turn', item: first });
  });

  it('does not dispatch a queued turn after Stop wins during pre-send metadata lookup', async () => {
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'pre-send-metadata-stop';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const lookupStarted = deferred<void>();
    const lookup = deferred<string | undefined>();

    h.getSdkSessionId.mockImplementationOnce(async () => {
      lookupStarted.resolve();
      return lookup.promise;
    });

    h.coordinator.enqueue(sid, first);
    await lookupStarted.promise;
    h.coordinator.enqueue(sid, second);
    h.coordinator.stop(sid, { keepQueue: true, pauseQueue: true });

    lookup.resolve('sdk-session');
    await flush();

    let projection = latestProjection(h.projections);
    expect(h.sendToAgent).not.toHaveBeenCalled();
    expect(projection.queueAbortPending).toBe(false);
    expect(projection.queuePaused).toBe(true);
    expect(projection.pendingQueue).toEqual([first, second]);
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();

    h.coordinator.resume(sid);
    await flush();

    projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({ type: 'user', content: 'first' });
    expect(projection.pendingQueue).toEqual([second]);
  });

  it('does not dispatch after Stop wins while awaiting the pre-dispatch hook', async () => {
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'pre-dispatch-hook-stop';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const hookStarted = deferred<void>();
    const hookRelease = deferred<void>();
    const events: string[] = [];

    h.beforeDispatchUserTurn.mockImplementation(async () => {
      events.push('before-dispatch:start');
      hookStarted.resolve();
      await hookRelease.promise;
      events.push('before-dispatch:end');
    });
    h.sendToAgent.mockImplementationOnce(async (sessionId, _message, _createOpts, sendOpts) => {
      await persistQueuedUserMessage(sessionId, sendOpts);
      events.push('vendor-dispatch');
      return sendSuccess();
    });

    h.coordinator.enqueue(sid, first);
    await hookStarted.promise;
    h.coordinator.enqueue(sid, second);
    h.coordinator.stop(sid, { keepQueue: true, pauseQueue: true });

    hookRelease.resolve();
    await flush();

    let projection = latestProjection(h.projections);
    expect(events).toEqual(['before-dispatch:start', 'before-dispatch:end']);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(projection.queueAbortPending).toBe(false);
    expect(projection.queuePaused).toBe(true);
    expect(projection.pendingQueue).toEqual([second]);
    expect(projection.error).toBeNull();
    expect(projection.recovery).toEqual({ kind: 'active-turn', item: first });
    expect(h.onUndispatchedUserTurn).toHaveBeenCalledWith(sid, first);

    h.coordinator.resume(sid);
    await flush();

    projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue).toEqual([second]);
  });

  it('keeps accepted-turn recovery when terminal error is followed by done', async () => {
    const h = createHarness();
    const sid = 'terminal-error-then-done';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    await flush();

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'error', 'turn failed');
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    const projection = latestProjection(h.projections);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-2']);
    expect(projection.error).toBe('turn failed');
    expect(projection.recovery).toEqual({ kind: 'active-turn', item: first });
    expect(projection.errorRetryText).toBe('first');
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
  });

  it('uses a queued-message retry token for attachment-only accepted turns', async () => {
    const h = createHarness();
    const sid = 'file-only-active-retry';
    const fileOnly = makeItem('q-file', '', {
      persistedContent: JSON.stringify({ text: '', files: [{ name: 'spec.pdf', path: '/repo/spec.pdf' }] }),
      files: [{
        id: 'file-1',
        name: 'spec.pdf',
        path: '/repo/spec.pdf',
        ext: '.pdf',
        size: 123,
        category: 'pdf',
        mimeType: 'application/pdf',
      }],
      chatMessage: {
        clientId: 'q-file',
        role: 'user',
        content: '',
        files: [{ name: 'spec.pdf', path: '/repo/spec.pdf' }],
      },
    });

    h.coordinator.enqueue(sid, fileOnly);
    await flush();

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'error', 'file turn failed');
    await flush();

    const projection = latestProjection(h.projections);
    expect(projection.errorRetryText).toBe('__xdt_queue_retry__:q-file');

    h.coordinator.retryLastError(sid);
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({
      type: 'user',
      content: [{ type: 'file', path: '/repo/spec.pdf', mimeType: 'application/pdf' }],
    });
  });

  it('removing a failed pre-accept head wakes the next queued row', async () => {
    const h = createHarness();
    const sid = 'remove-failed-head';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const firstAttempt = deferred<AgentInputSendResult>();
    h.sendToAgent.mockImplementationOnce(() => firstAttempt.promise);

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    await flush();

    firstAttempt.reject(new Error('workdir missing'));
    await flush();

    expect(latestProjection(h.projections).pendingQueue.map((q) => q.text)).toEqual(['first', 'second']);
    h.coordinator.remove(sid, first.clientId);
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'second' });
    expect(latestProjection(h.projections).pendingQueue).toHaveLength(0);
  });

  it('dispatches from idle without ever surfacing an intermediate queued projection', async () => {
    const h = createHarness();
    const sid = 'idle-immediate';
    const first = makeItem('q-1', 'hello');

    // idle 入队即派发: drain 的同步前半段先 slice 掉队首再 emit, 因此 enqueue 返回时
    // 已开始派发, 任何已 emit 的 projection 都不含该条 —— 否则 renderer 会先渲染一帧
    // pendingQueue=[item] 的队列灰字再消失(空闲发送闪烁的根因)。
    h.coordinator.enqueue(sid, first);
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.projections.length).toBeGreaterThan(0);
    expect(h.projections.every((p) => p.pendingQueue.length === 0)).toBe(true);
    expect(h.coordinator.getProjection(sid).pendingQueue).toEqual([]);
  });

  it('still surfaces a queued projection while the agent is busy', async () => {
    const h = createHarness();
    const sid = 'busy-enqueue';
    h.setRunning(true);
    const first = makeItem('q-1', 'hello');

    // agent 忙: 这条必须排队等待, projection 里要可见(队列预览), 不能被 immediate 分支吞掉。
    h.coordinator.enqueue(sid, first);
    await flush();

    expect(h.sendToAgent).not.toHaveBeenCalled();
    expect(latestProjection(h.projections).pendingQueue.map((q) => q.clientId)).toEqual(['q-1']);
  });
});

describe('AgentInputCoordinator interaction-resolved wake', () => {
  it('drains a queued follow-up after a between-turns interaction resolves (codex plan_review cancel)', async () => {
    const h = createHarness();
    const sid = 'interaction-resolved-wake';

    // 复现 plan_review 取消卡队列的时序: turn 结束时交互仍 pending → done wake 被
    // busy 门吃掉;交互 resolve 后没有任何 turn 事件 —— 只能靠 onInteractionResolved。
    h.setRunning(true);
    h.coordinator.enqueue(sid, makeItem('q-1', 'queued while planning'));
    await flush();
    expect(h.sendToAgent).not.toHaveBeenCalled();

    h.setPendingInteraction(true);
    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();
    // done wake 到达时交互仍挂起 → 不派发。
    expect(h.sendToAgent).not.toHaveBeenCalled();

    // 用户取消审阅: 交互 resolve, 无新 turn。onInteractionResolved 必须唤醒 drain。
    h.setPendingInteraction(false);
    h.coordinator.onInteractionResolved(sid);
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(latestProjection(h.projections).pendingQueue).toEqual([]);
  });
});

describe('AgentInputCoordinator stop and drain boundaries', () => {
  it('reports vendor running and pending interactions as active rewind boundaries', () => {
    const h = createHarness();
    const sid = 'rewind-active-boundary';

    expect(h.coordinator.hasActiveTurnForRewind(sid)).toBe(false);
    h.setRunning(true);
    expect(h.coordinator.hasActiveTurnForRewind(sid)).toBe(true);
    h.setRunning(false);
    h.setPendingInteraction(true);
    expect(h.coordinator.hasActiveTurnForRewind(sid)).toBe(true);
  });

  it('waits for the complete rewind boundary instead of only the vendor running flag', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      const sid = 'rewind-pending-interaction';
      h.setPendingInteraction(true);

      const waiting = h.coordinator.waitForRewindBoundaryIdle(sid, 1_000);
      let settled = false;
      void waiting.then(() => {
        settled = true;
      });
      await flush();
      expect(settled).toBe(false);

      h.setPendingInteraction(false);
      await vi.advanceTimersByTimeAsync(100);

      await expect(waiting).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out when the authoritative rewind boundary never settles', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      const sid = 'rewind-stop-timeout';
      h.setRunning(true);

      const waiting = h.coordinator.waitForRewindBoundaryIdle(sid, 250);
      await vi.advanceTimersByTimeAsync(250);

      await expect(waiting).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains a timed-out rewind lock until the authoritative boundary settles', async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      const sid = 'rewind-retained-timeout-lock';
      h.setRunning(true);
      h.coordinator.setInteractionLock(sid, 'session-rewind', true, { preserveOnStop: true });

      const release = h.coordinator.releaseRewindLockWhenIdle(sid, 'session-rewind');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(latestProjection(h.projections).queueInteractionLocks).toContain('session-rewind');
      await expect(h.coordinator.steer(sid, makeItem('blocked-steer', 'blocked'))).resolves.toBe(
        false,
      );

      h.setRunning(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await release;

      expect(latestProjection(h.projections).queueInteractionLocks).not.toContain('session-rewind');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a retained rewind lock when the user stops again before the boundary settles', async () => {
    const h = createHarness();
    const sid = 'rewind-retained-lock-second-stop';
    h.setPendingInteraction(true);
    h.coordinator.setInteractionLock(sid, 'session-rewind', true, { preserveOnStop: true });

    h.coordinator.stop(sid);

    expect(latestProjection(h.projections).queueInteractionLocks).toContain('session-rewind');
    await expect(h.coordinator.steer(sid, makeItem('blocked-steer', 'blocked'))).resolves.toBe(
      false,
    );
    expect(h.steerToAgent).not.toHaveBeenCalled();

    h.coordinator.setInteractionLock(sid, 'session-rewind', false);
    expect(latestProjection(h.projections).queueInteractionLocks).not.toContain('session-rewind');
  });

  it('rejects steer while rewind owns the session input boundary', async () => {
    const h = createHarness();
    const sid = 'rewind-blocks-steer';
    h.setRunning(true);
    h.coordinator.setInteractionLock(sid, 'session-rewind', true);

    await expect(h.coordinator.steer(sid, makeItem('steer-1', 'new input'))).resolves.toBe(false);

    expect(h.steerToAgent).not.toHaveBeenCalled();
  });

  it('retains and pauses queued messages for rewind without dispatching or aborting', async () => {
    const h = createHarness();
    const sid = 'rewind-pause-queue';
    const first = makeItem('q-1', 'first');

    h.setRunning(true);
    h.coordinator.enqueue(sid, first);
    await flush();

    const projection = h.coordinator.pausePendingQueueForRewind(sid);

    expect(projection.queuePaused).toBe(true);
    expect(projection.pendingQueue.map((item) => item.clientId)).toEqual(['q-1']);
    expect(h.sendToAgent).not.toHaveBeenCalled();
    expect(h.abortSession).not.toHaveBeenCalled();
  });

  it('keeps the queue paused after Stop and drains after Continue plus Claude abort boundary', async () => {
    const h = createHarness();
    const sid = 'stop-claude';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const abort = deferred<void>();
    h.abortSession.mockImplementationOnce(() => abort.promise);

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    await flush();

    h.coordinator.stop(sid, { keepQueue: true, pauseQueue: true });
    expect(latestProjection(h.projections)).toMatchObject({
      queuePaused: true,
      queueAbortPending: true,
    });

    h.coordinator.resume(sid);
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(latestProjection(h.projections).queueAbortPending).toBe(true);

    h.setRunning(false);
    abort.resolve();
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'second' });
  });

  it('keeps Codex queue abort lock until a real turn boundary', async () => {
    const h = createHarness();
    const sid = 'stop-codex';
    const first = makeItem('q-1', 'first', {
      createOpts: { ...makeItem('tmp', 'tmp').createOpts, agentKind: 'codex' },
    });
    const second = makeItem('q-2', 'second', {
      createOpts: { ...makeItem('tmp2', 'tmp2').createOpts, agentKind: 'codex' },
    });
    const abort = deferred<void>();
    h.setAgentKind('codex');
    h.abortSession.mockImplementationOnce(() => abort.promise);

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    await flush();

    h.coordinator.stop(sid, { keepQueue: true, pauseQueue: true });
    h.coordinator.resume(sid);
    await flush();

    abort.resolve();
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(latestProjection(h.projections).queueAbortPending).toBe(true);

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(latestProjection(h.projections).queueAbortPending).toBe(false);
  });

  it('releases a Codex abort lock on status=closed and then drains the preserved queue', async () => {
    const h = createHarness();
    const sid = 'stop-codex-status-closed';
    const first = makeItem('q-1', 'first', {
      createOpts: { ...makeItem('tmp', 'tmp').createOpts, agentKind: 'codex' },
    });
    const second = makeItem('q-2', 'second', {
      createOpts: { ...makeItem('tmp2', 'tmp2').createOpts, agentKind: 'codex' },
    });
    h.setAgentKind('codex');

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    await flush();

    h.coordinator.stop(sid, { keepQueue: true, pauseQueue: true });
    h.coordinator.resume(sid);
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(latestProjection(h.projections).queueAbortPending).toBe(true);

    h.setRunning(false);
    h.coordinator.onSessionClosed(sid);
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'second' });
    expect(latestProjection(h.projections).queueAbortPending).toBe(false);
  });

  it('does not drain queued rows on status=closed unless an abort lock is being released', async () => {
    const h = createHarness();
    const sid = 'closed-without-abort-lock';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    await flush();

    h.setRunning(false);
    h.coordinator.onSessionClosed(sid);
    await flush();

    const projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-2']);
    expect(projection.queueAbortPending).toBe(false);
  });
});

describe('AgentInputCoordinator steer transaction', () => {
  it('injects a Claude steer into the running turn without aborting it', async () => {
    const h = createHarness(); // 默认 agentKind='claude-code'
    const sid = 'claude-steer-same-turn';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    await flush();

    const ok = await h.coordinator.steer(sid, second, { removeFromQueue: true, touchUserSend: true });
    await flush();

    // 同轮注入(2026-07-12 统一):Claude 与 Codex 走同一条 steerToAgent 路径,
    // 不 abort 当前 turn;消息注入 in-flight turn 并按 delivery='steer' 落库。
    expect(ok).toBe(true);
    expect(h.abortSession).not.toHaveBeenCalled();
    expect(h.steerToAgent).toHaveBeenCalledWith(
      sid,
      { type: 'user', content: 'second' },
      expect.objectContaining({ messageUuid: expect.any(String) }),
    );
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(latestProjection(h.projections).pendingQueue).toHaveLength(0);
    expect(latestProjection(h.projections).steeringQueueClientIds).toEqual([]);
    expect(mocks.createMessage).toHaveBeenNthCalledWith(
      2,
      sid,
      expect.objectContaining({
        clientId: second.clientId,
        content: 'second',
        agentMeta: expect.objectContaining({ delivery: 'steer' }),
      }),
      expect.objectContaining({ shouldBroadcast: expect.any(Function) }),
    );
    expect(mocks.touchUserSendInDb).toHaveBeenCalledWith(sid, undefined);
  });

  it('pauses the queue when the steer ack times out instead of auto-redispatching (outcome uncertain)', async () => {
    // review #939 P1:turn/steer 是 content-bearing RPC,ack 超时后请求可能已被
    // 迟到注入当前 turn。该行必须以暂停态保留,turn 结束后的自动 drain 不得把
    // 同一条消息再作为普通 turn 派发(否则模型消费两次);处置权交用户。
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'steer-ack-timeout-pause';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    h.steerToAgent.mockImplementationOnce(() =>
      Promise.reject(new Error('Codex turn/steer did not acknowledge within 10000ms')),
    );

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    await flush();

    const ok = await h.coordinator.steer(sid, second, { removeFromQueue: true });
    await flush();

    expect(ok).toBe(false);
    const afterFailure = latestProjection(h.projections);
    expect(afterFailure.queuePaused).toBe(true);
    expect(afterFailure.error).toContain('did not acknowledge');
    expect(afterFailure.steeringQueueClientIds).toEqual([]);
    expect(afterFailure.pendingQueue.map((q) => q.clientId)).toEqual(['q-2']);

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    const afterDone = latestProjection(h.projections);
    expect(afterDone.queuePaused).toBe(true);
    expect(afterDone.pendingQueue.map((q) => q.clientId)).toEqual(['q-2']);
  });

  it('screens same-turn steers through ghost hooks: block discards without injecting or persisting', async () => {
    // review #939 第四轮:steer 直达 steerToAgent 不经 drain,必须补同一道
    // will-user-message 筛查,否则被拦消息可经插话原样注入并落库。
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'steer-ghost-block';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    h.setScreenUserMessage(async (_sid, agentFacingText) =>
      agentFacingText === 'second'
        ? { action: 'block', ghostId: 'g-1', ghostName: 'guard', reason: 'nope' }
        : { action: 'allow' },
    );

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    await flush();

    const ok = await h.coordinator.steer(sid, second, { removeFromQueue: true });
    await flush();

    expect(ok).toBe(true);
    expect(h.steerToAgent).not.toHaveBeenCalled();
    expect(h.onUserMessageBlocked).toHaveBeenCalledWith(
      sid,
      expect.objectContaining({ clientId: 'q-2' }),
      expect.objectContaining({ ghostId: 'g-1' }),
    );
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    const projection = latestProjection(h.projections);
    expect(projection.pendingQueue).toHaveLength(0);
    expect(projection.steeringQueueClientIds).toEqual([]);
  });

  it('screens same-turn steers through ghost hooks: rewrite injects and persists the rewritten text', async () => {
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'steer-ghost-rewrite';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    h.setScreenUserMessage(async (_sid, agentFacingText) =>
      agentFacingText === 'second'
        ? { action: 'rewrite', ghostId: 'g-1', ghostName: 'guard', text: 'rewritten text' }
        : { action: 'allow' },
    );

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    await flush();

    const ok = await h.coordinator.steer(sid, second, { removeFromQueue: true });
    await flush();

    expect(ok).toBe(true);
    expect(h.steerToAgent).toHaveBeenCalledWith(
      sid,
      { type: 'user', content: 'rewritten text' },
      expect.objectContaining({ messageUuid: expect.any(String) }),
    );
    expect(h.onUserMessageRewritten).toHaveBeenCalledWith(
      sid,
      expect.objectContaining({ clientId: 'q-2' }),
      expect.objectContaining({ text: 'rewritten text', originalText: 'second' }),
    );
    expect(mocks.createMessage).toHaveBeenNthCalledWith(
      2,
      sid,
      expect.objectContaining({
        clientId: second.clientId,
        content: 'rewritten text',
        agentMeta: expect.objectContaining({ delivery: 'steer' }),
      }),
      expect.objectContaining({ shouldBroadcast: expect.any(Function) }),
    );
  });

  it('materializes a delivery-uncertain abort into the paused queue after Stop cleared the marker', async () => {
    // review #939 第四轮:Stop/close 赢在 ack 返回前时 marker 已清,此前直接
    // fall through——迟到注入的文本既没落库也没暂停,用户可重发造成双份消费。
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'steer-abort-uncertain-materialize';
    const first = makeItem('q-1', 'first');
    const composer = makeItem('composer-1', 'composer text');
    const gate = deferred<void>();
    h.steerToAgent.mockImplementationOnce(() => gate.promise);

    h.coordinator.enqueue(sid, first);
    await flush();

    const steerPromise = h.coordinator.steer(sid, composer, { touchUserSend: true });
    await flush();

    h.coordinator.stop(sid);
    gate.reject(new Error('Codex steer cancelled before acceptance; delivery uncertain (request already dispatched)'));
    await expect(steerPromise).resolves.toBe(false);
    await flush();

    const projection = latestProjection(h.projections);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['composer-1']);
    expect(projection.queuePaused).toBe(true);
  });

  it('does not resurrect a delivery-uncertain steer into a cleared session', async () => {
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'steer-abort-uncertain-cleared';
    const first = makeItem('q-1', 'first');
    const composer = makeItem('composer-1', 'composer text');
    const gate = deferred<void>();
    h.steerToAgent.mockImplementationOnce(() => gate.promise);

    h.coordinator.enqueue(sid, first);
    await flush();

    const steerPromise = h.coordinator.steer(sid, composer, { touchUserSend: true });
    await flush();

    // clearSession 是用户显式重置(generation bump):结果不确定也不塞回去。
    h.coordinator.clearSession(sid);
    gate.reject(new Error('Codex steer cancelled before acceptance; delivery uncertain (request already dispatched)'));
    await expect(steerPromise).resolves.toBe(false);
    await flush();

    const projection = latestProjection(h.projections);
    expect(projection.pendingQueue).toHaveLength(0);
    expect(projection.queuePaused).toBe(false);
  });

  it('materializes a timed-out composer steer into the paused queue (uncertain delivery)', async () => {
    // review #939 第三轮:composer 插话不在 pendingQueue 里,超时的"结果不确定"
    // 必须物化成暂停队列行,否则用户按草稿重发同一段文字时模型可能双份消费。
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'steer-composer-timeout-materialize';
    const first = makeItem('q-1', 'first');
    const composer = makeItem('composer-1', 'composer text');
    h.steerToAgent.mockImplementationOnce(() =>
      Promise.reject(new Error('Codex turn/steer did not acknowledge within 10000ms')),
    );

    h.coordinator.enqueue(sid, first);
    await flush();

    const ok = await h.coordinator.steer(sid, composer, { touchUserSend: true });
    await flush();

    expect(ok).toBe(false);
    const projection = latestProjection(h.projections);
    expect(projection.queuePaused).toBe(true);
    expect(projection.error).toContain('did not acknowledge');
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['composer-1']);

    // turn 结束后暂停仍然挡住自动重派。
    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(latestProjection(h.projections).pendingQueue.map((q) => q.clientId)).toEqual(['composer-1']);
  });

  it('replays the terminal error recovery when a late steer ack lands after the turn failed', async () => {
    // review #939 第三轮:turn 在 ack 等待期间以 terminal error 终结时,合成收口
    // 不能吞掉 onTurnEvent 已建立的失败状态——否则失败 turn 丢 Retry 入口,
    // 队尾还会像成功结束一样放行。
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'steer-late-ack-after-turn-error';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const third = makeItem('q-3', 'third');
    const steerGate = deferred<void>();
    h.steerToAgent.mockImplementationOnce(() => steerGate.promise);

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    h.coordinator.enqueue(sid, third);
    await flush();

    const steerPromise = h.coordinator.steer(sid, second, { removeFromQueue: true });
    await flush();
    // ack 返回前 turn 以 terminal error 终结。
    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'error', 'turn exploded');
    await flush();
    steerGate.resolve();
    await expect(steerPromise).resolves.toBe(true);
    await flush();

    const projection = latestProjection(h.projections);
    // steer 消息已投递落库,不回队列;失败状态被回放:Retry 入口在,队尾被挡住。
    expect(projection.error).toBe('turn exploded');
    expect(projection.recovery).toMatchObject({ kind: 'active-turn' });
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-3']);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(mocks.createMessage).toHaveBeenNthCalledWith(
      2,
      sid,
      expect.objectContaining({
        clientId: second.clientId,
        agentMeta: expect.objectContaining({ delivery: 'steer' }),
      }),
      expect.objectContaining({ shouldBroadcast: expect.any(Function) }),
    );
  });

  it('synthesizes closure when steer is accepted after the turn already settled', async () => {
    // review #939 第二轮 P1 的 coordinator 半边:maker-core 对"server 已接受注入
    // 但本地 turn 已终结"按已投递 resolve;此时 steer activeTurn 等不到属于自己
    // 的终态事件,accepted 后必须自查 host busy 视图合成收口,否则队列冻结。
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'steer-accepted-turn-settled';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const steerGate = deferred<void>();
    h.steerToAgent.mockImplementationOnce(() => steerGate.promise);

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    await flush();

    const steerPromise = h.coordinator.steer(sid, second, { removeFromQueue: true });
    await flush();
    // ack 返回前 turn 终结(乱序窗口):host busy 视图已清。
    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();
    steerGate.resolve();
    await expect(steerPromise).resolves.toBe(true);
    await flush();

    // 已投递:按 delivery=steer 落库,消息不回队列、不重发。
    expect(mocks.createMessage).toHaveBeenNthCalledWith(
      2,
      sid,
      expect.objectContaining({
        clientId: second.clientId,
        agentMeta: expect.objectContaining({ delivery: 'steer' }),
      }),
      expect.objectContaining({ shouldBroadcast: expect.any(Function) }),
    );
    expect(latestProjection(h.projections).pendingQueue).toHaveLength(0);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);

    // 合成收口后队列不冻结:新消息可立即派发。
    const third = makeItem('q-3', 'third');
    h.coordinator.enqueue(sid, third);
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'third' });
  });

  it('persists same-turn steer only after maker-core accepts it and removes the queued row after success', async () => {
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'steer-accepted';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    await flush();

    const ok = await h.coordinator.steer(sid, second, { removeFromQueue: true });
    await flush();

    expect(ok).toBe(true);
    expect(h.steerToAgent).toHaveBeenCalledWith(
      sid,
      { type: 'user', content: 'second' },
      expect.objectContaining({ messageUuid: expect.any(String) }),
    );
    expect(latestProjection(h.projections).pendingQueue).toHaveLength(0);
    expect(mocks.createMessage).toHaveBeenNthCalledWith(
      2,
      sid,
      expect.objectContaining({
        clientId: second.clientId,
        content: 'second',
        agentMeta: expect.objectContaining({ delivery: 'steer' }),
      }),
      expect.objectContaining({ shouldBroadcast: expect.any(Function) }),
    );
  });

  it('unblocks queued compact after steer removes a row it was waiting for', async () => {
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'steer-remove-unblocks-compact';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    h.setRunning(true);

    h.coordinator.enqueue(sid, first);
    h.coordinator.enqueue(sid, second);
    await h.coordinator.compact(sid, makeItem('q-compact', 'ignored').createOpts);
    await flush();

    const ok = await h.coordinator.steer(sid, first, { removeFromQueue: true });
    await flush();

    expect(ok).toBe(true);
    expect(latestProjection(h.projections).pendingQueue.map((q) => q.clientId)).toEqual(['q-2']);

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({ type: 'user', content: 'second' });

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: '/compact' });
  });

  it('keeps non-recoverable steer persist error visible after done', async () => {
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'steer-persist-fails';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    mocks.createMessage
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('db down'));

    h.coordinator.enqueue(sid, first);
    await flush();

    const ok = await h.coordinator.steer(sid, second, { removeFromQueue: true });
    await flush();

    expect(ok).toBe(false);
    let projection = latestProjection(h.projections);
    expect(projection.error).toBe('Failed to persist user message: db down');
    expect(projection.recovery).toBeNull();
    expect(projection.errorRetryText).toBeNull();

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    projection = latestProjection(h.projections);
    expect(projection.error).toBe('Failed to persist user message: db down');
    expect(projection.recovery).toBeNull();
    expect(projection.errorRetryText).toBeNull();
  });

  it('does not expose active-turn retry when terminal error follows failed steer persistence', async () => {
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'steer-persist-fails-then-terminal-error';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    mocks.createMessage
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('db down'));

    h.coordinator.enqueue(sid, first);
    await flush();

    const ok = await h.coordinator.steer(sid, second, { removeFromQueue: true });
    await flush();
    expect(ok).toBe(false);

    h.coordinator.onTurnEvent(sid, 'error', 'terminal after persist failure');
    await flush();

    const projection = latestProjection(h.projections);
    expect(projection.error).toBe('Failed to persist user message: db down');
    expect(projection.recovery).toBeNull();
    expect(projection.errorRetryText).toBeNull();
  });

  it('keeps active-turn retry when terminal error arrives before successful steer persistence settles', async () => {
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'steer-terminal-before-persist-success';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const persistStarted = deferred<void>();
    const persistSucceeded = deferred<void>();
    mocks.createMessage
      .mockResolvedValueOnce({})
      .mockImplementationOnce(async () => {
        persistStarted.resolve();
        await persistSucceeded.promise;
        return {};
      });

    h.coordinator.enqueue(sid, first);
    await flush();

    const steerPromise = h.coordinator.steer(sid, second, { removeFromQueue: true });
    await persistStarted.promise;

    h.coordinator.onTurnEvent(sid, 'error', 'agent failed before persist');
    await flush();

    let projection = latestProjection(h.projections);
    expect(projection.error).toBe('agent failed before persist');
    expect(projection.recovery).toBeNull();
    expect(projection.errorRetryText).toBeNull();

    persistSucceeded.resolve();
    await expect(steerPromise).resolves.toBe(true);
    await flush();

    projection = latestProjection(h.projections);
    expect(projection.error).toBe('agent failed before persist');
    expect(projection.recovery).toEqual({ kind: 'active-turn', item: second });
    expect(projection.errorRetryText).toBe('second');
  });

  it('delays done behind steer persistence and finalizes only after persistence completes', async () => {
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'steer-done-before-persist-success';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const third = makeItem('q-3', 'third');
    const persistStarted = deferred<void>();
    const persistSucceeded = deferred<void>();
    mocks.createMessage
      .mockResolvedValueOnce({})
      .mockImplementationOnce(async () => {
        persistStarted.resolve();
        await persistSucceeded.promise;
        return {};
      })
      .mockResolvedValueOnce({});

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    h.coordinator.enqueue(sid, third);
    await flush();

    const steerPromise = h.coordinator.steer(sid, second, { removeFromQueue: true });
    await persistStarted.promise;

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    let projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-3']);

    persistSucceeded.resolve();
    await expect(steerPromise).resolves.toBe(true);
    await flush();

    projection = latestProjection(h.projections);
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(projection.pendingQueue).toEqual([]);
  });

  it('keeps a delayed terminal error when done follows before steer persistence settles', async () => {
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'steer-error-wins-over-done-before-persist-success';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const persistStarted = deferred<void>();
    const persistSucceeded = deferred<void>();
    mocks.createMessage
      .mockResolvedValueOnce({})
      .mockImplementationOnce(async () => {
        persistStarted.resolve();
        await persistSucceeded.promise;
        return {};
      });

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    await flush();

    const steerPromise = h.coordinator.steer(sid, second, { removeFromQueue: true });
    await persistStarted.promise;

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'error', 'agent failed before persist');
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    let projection = latestProjection(h.projections);
    expect(projection.error).toBe('agent failed before persist');
    expect(projection.recovery).toBeNull();

    persistSucceeded.resolve();
    await expect(steerPromise).resolves.toBe(true);
    await flush();

    projection = latestProjection(h.projections);
    expect(projection.error).toBe('agent failed before persist');
    expect(projection.recovery).toEqual({ kind: 'active-turn', item: second });
    expect(projection.errorRetryText).toBe('second');
  });

  it('suppresses stale steer persist failure after clearSession wins during persistence', async () => {
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'steer-persist-clear-session';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const persistStarted = deferred<void>();
    const persistFailed = deferred<void>();
    mocks.createMessage
      .mockResolvedValueOnce({})
      .mockImplementationOnce(async () => {
        persistStarted.resolve();
        await persistFailed.promise;
        throw new Error('db down');
      });

    h.coordinator.enqueue(sid, first);
    await flush();

    const steerPromise = h.coordinator.steer(sid, second, { removeFromQueue: true });
    await persistStarted.promise;
    h.coordinator.clearSession(sid);
    persistFailed.resolve();
    await expect(steerPromise).resolves.toBe(false);
    await flush();

    const projection = latestProjection(h.projections);
    expect(projection.error).toBeNull();
    expect(projection.recovery).toBeNull();
    expect(projection.pendingQueue).toEqual([]);
    expect(projection.steeringQueueClientIds).toEqual([]);
  });

  it('falls back to a normal turn when no active turn exists', async () => {
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'steer-fallback';
    const item = makeItem('q-1', 'fallback');

    const ok = await h.coordinator.steer(sid, item, { touchUserSend: true });
    await flush();

    expect(ok).toBe(true);
    expect(h.steerToAgent).not.toHaveBeenCalled();
    expect(h.sendToAgent).toHaveBeenCalledWith(
      sid,
      { type: 'user', content: 'fallback' },
      item.createOpts,
      expect.objectContaining({ throwOnStartFailure: true }),
    );
    expect(mocks.touchUserSendInDb).toHaveBeenCalledWith(sid, undefined);
  });

  it('recovers from a zombie turn: NO_ACTIVE_TURN reconciles stale busy state and dispatches the fallback', async () => {
    // 场景: q-1 已派发但 turn 异常死亡 (done 事件丢失) —— coordinator 的
    // activeTurn 和 host busy tracker 双双 stale。修复前: 插话 → fallback →
    // drain 被假忙永久挡住, 点击表现为"毫无反应"。
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'steer-zombie';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');

    h.coordinator.enqueue(sid, first);
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);

    // turn 死亡: 没有 done / terminal error, tracker 仍 running=true。
    h.coordinator.enqueue(sid, second);
    await flush();
    expect(latestProjection(h.projections).pendingQueue.map((q) => q.clientId)).toEqual(['q-2']);

    h.steerToAgent.mockRejectedValueOnce(new Error('[NO_ACTIVE_TURN] Session steer-zombie has no active turn'));
    // host 校准: 复核后清掉 stale busy tracker (镜像 register.ts 的接线行为)。
    h.reconcileTurnIdle.mockImplementationOnce(() => {
      h.setRunning(false);
    });

    const ok = await h.coordinator.steer(sid, second, { removeFromQueue: true });
    await flush();

    expect(ok).toBe(true);
    expect(h.reconcileTurnIdle).toHaveBeenCalledWith(sid);
    // 合成 done 边界收掉尸体 activeTurn 后, fallback 的 q-2 以普通 turn 派发。
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent).toHaveBeenLastCalledWith(
      sid,
      { type: 'user', content: 'second' },
      second.createOpts,
      expect.objectContaining({ throwOnStartFailure: true }),
    );
    const projection = latestProjection(h.projections);
    expect(projection.pendingQueue).toEqual([]);
    expect(projection.steeringQueueClientIds).toEqual([]);
    expect(projection.error).toBeNull();
  });

  it('keeps a restored trusted snapshot when queued steer falls back to a normal turn', async () => {
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'steer-fallback-trusted-snapshot';
    const first = makeItem('q-1', 'first');
    const refs = [{ sessionId: 'source-session', deviceId: 'source-device' }];
    const trustedContext = {
      sessionId: 'source-session',
      source: 'device-link' as const,
      deviceId: 'source-device',
      messages: [{ role: 'user' as const, content: 'authoritative remote history' }],
      range: 'recent' as const,
      messageCount: 1,
      truncated: false,
    };
    const markerOnly = makeItem('q-2', 'queued quote', {
      sessionRefs: refs,
      sessionReferencesRequireTrustedSnapshot: true,
    });
    const incoming = makeItem('q-2', 'queued quote', {
      sessionRefs: refs,
      trustedSessionReferenceContexts: [trustedContext],
      sessionReferencesRequireTrustedSnapshot: true,
    });

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, markerOnly);
    h.steerToAgent.mockRejectedValueOnce(new Error('[NO_ACTIVE_TURN] Session has no active turn'));
    h.reconcileTurnIdle.mockImplementationOnce(() => h.setRunning(false));

    await expect(h.coordinator.steer(sid, incoming, { removeFromQueue: true })).resolves.toBe(true);
    await flush();

    expect(h.resolveSessionReferences).not.toHaveBeenCalled();
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.sendToAgent.mock.calls[1]?.[1])).toContain('authoritative remote history');
  });

  it('serializes steer attempts while a steer request is already in flight', async () => {
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'steer-serialize';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const third = makeItem('q-3', 'third');
    const steer = deferred<void>();
    h.steerToAgent.mockImplementationOnce(() => steer.promise);

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    h.coordinator.enqueue(sid, third);
    await flush();

    const firstSteer = h.coordinator.steer(sid, second, { removeFromQueue: true });
    await flush();
    const blocked = await h.coordinator.steer(sid, third, { removeFromQueue: true });

    expect(blocked).toBe(false);
    expect(h.steerToAgent).toHaveBeenCalledTimes(1);
    expect(latestProjection(h.projections).steeringQueueClientIds).toEqual(['q-2']);

    steer.resolve();
    expect(await firstSteer).toBe(true);
  });

  it('keeps the steer marker across an old-turn done while the steer request is in flight', async () => {
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'steer-marker-survives-done';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const steer = deferred<void>();
    h.steerToAgent.mockImplementationOnce(() => steer.promise);

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    await flush();

    const steerPromise = h.coordinator.steer(sid, second, { removeFromQueue: true });
    await flush();

    expect(latestProjection(h.projections).steeringQueueClientIds).toEqual(['q-2']);

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    expect(latestProjection(h.projections).steeringQueueClientIds).toEqual(['q-2']);
    expect(latestProjection(h.projections).pendingQueue.map((q) => q.clientId)).toEqual(['q-2']);

    steer.resolve();
    expect(await steerPromise).toBe(true);
    await flush();

    expect(latestProjection(h.projections).steeringQueueClientIds).toEqual([]);
    expect(latestProjection(h.projections).pendingQueue).toEqual([]);
    expect(mocks.createMessage).toHaveBeenNthCalledWith(
      2,
      sid,
      expect.objectContaining({
        clientId: second.clientId,
        agentMeta: expect.objectContaining({ delivery: 'steer' }),
      }),
      expect.objectContaining({ shouldBroadcast: expect.any(Function) }),
    );
  });

  it('cancels an in-flight Codex steer transaction when Stop clears the marker', async () => {
    const h = createHarness();
    const sid = 'steer-stop-cancel';
    const first = makeItem('q-1', 'first', {
      createOpts: { ...makeItem('tmp', 'tmp').createOpts, agentKind: 'codex' },
    });
    const second = makeItem('q-2', 'second', {
      createOpts: { ...makeItem('tmp2', 'tmp2').createOpts, agentKind: 'codex' },
    });
    h.setAgentKind('codex');
    h.steerToAgent.mockImplementationOnce((_sessionId, _message, sendOpts) =>
      new Promise<void>((_resolve, reject) => {
        if (sendOpts.signal?.aborted) {
          reject(new Error('cancelled'));
          return;
        }
        sendOpts.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      }),
    );

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    await flush();

    const steerPromise = h.coordinator.steer(sid, second, { removeFromQueue: true });
    await flush();

    const sendOpts = h.steerToAgent.mock.calls[0]?.[2];
    expect(sendOpts?.signal?.aborted).toBe(false);

    h.coordinator.stop(sid, { keepQueue: true, pauseQueue: true });
    await flush();

    expect(sendOpts?.signal?.aborted).toBe(true);
    await expect(steerPromise).resolves.toBe(false);
    expect(latestProjection(h.projections)).toMatchObject({
      queuePaused: true,
      queueAbortPending: true,
      steeringQueueClientIds: [],
      error: null,
    });
    expect(latestProjection(h.projections).pendingQueue.map((q) => q.clientId)).toEqual(['q-2']);
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
  });
});

describe('AgentInputCoordinator queue mutations', () => {
  it('lets rows before an edited row drain, then waits when the edited row reaches the head', async () => {
    const h = createHarness();
    const sid = 'edit-lock';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const third = makeItem('q-3', 'third');

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    h.coordinator.enqueue(sid, third);
    h.coordinator.setEditLock(sid, third.clientId, true);
    await flush();

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: 'second' });
    expect(latestProjection(h.projections).pendingQueue.map((q) => q.text)).toEqual(['third']);

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(latestProjection(h.projections).pendingQueue.map((q) => q.text)).toEqual(['third']);

    h.coordinator.setEditLock(sid, third.clientId, false);
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledTimes(3);
    expect(h.sendToAgent.mock.calls[2]?.[1]).toEqual({ type: 'user', content: 'third' });
  });

  it('moves queued rows by FIFO insertion index without touching the active turn', async () => {
    const h = createHarness();
    const sid = 'move-queue';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'second');
    const third = makeItem('q-3', 'third');
    const fourth = makeItem('q-4', 'fourth');

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    h.coordinator.enqueue(sid, third);
    h.coordinator.enqueue(sid, fourth);
    await flush();

    h.coordinator.move(sid, fourth.clientId, 0);

    expect(latestProjection(h.projections).pendingQueue.map((q) => q.text)).toEqual([
      'fourth',
      'second',
      'third',
    ]);
  });

  it('updates pending row text and clears stale quote metadata before acceptance', async () => {
    const h = createHarness();
    const sid = 'edit-text';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'old', {
      persistedContent: JSON.stringify({
        text: 'old',
        images: [{ url: 'xdt-image://1' }],
        files: [],
        quotesEncoded: true,
      }),
      chatMessage: {
        clientId: 'q-2',
        role: 'user',
        content: 'old',
        isStreaming: false,
        createdAt: '2026-06-07T00:00:00.000Z',
        quotesEncoded: true,
      },
    });

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    await flush();

    h.coordinator.updateText(sid, second.clientId, 'new text');

    const updated = latestProjection(h.projections).pendingQueue[0];
    expect(updated?.text).toBe('new text');
    expect(updated?.chatMessage.content).toBe('new text');
    expect(updated?.chatMessage.quotesEncoded).toBeUndefined();
    expect(JSON.parse(updated?.persistedContent ?? '{}')).toEqual({
      text: 'new text',
      images: [{ url: 'xdt-image://1' }],
      files: [],
      slashCommandRanges: [],
    });
  });

  it('does not re-parse remote edits that omit trusted session refs', async () => {
    const h = createHarness();
    const sid = 'edit-remote-without-snapshot';
    const item = makeItem('q-1', 'old text');
    h.coordinator.enqueue(sid, item);
    await flush();

    h.coordinator.updateText(
      sid,
      item.clientId,
      'see cindy://session/remote?message=client-1',
      undefined,
      undefined,
      true,
    );

    const updated = latestProjection(h.projections).pendingQueue[0];
    expect(updated?.sessionRefs).toBeUndefined();
    expect(updated?.sessionReferencesRequireTrustedSnapshot).toBeUndefined();
  });

  it('replaces pending row content (text + files) in place while pinning identity fields', async () => {
    const h = createHarness();
    const sid = 'edit-content';
    const first = makeItem('q-1', 'first');
    const second = makeItem('q-2', 'old', {
      files: [{
        id: 'file-old', name: 'old.png', path: '/tmp/old.png', ext: '.png',
        size: 10, category: 'image', mimeType: 'image/png',
      }],
    });

    h.coordinator.enqueue(sid, first);
    await flush();
    h.coordinator.enqueue(sid, second);
    await flush();

    // mentions 保留语义:手机端 next 不带 mentions(undefined)→ 保留原条目的,
    // 不许被整条替换静默剥掉(review P2)。
    const withMentions = makeItem('q-3', 'mention holder', {
      mentions: [{ type: 'file', name: 'README.md', path: 'README.md' }],
    });
    h.coordinator.enqueue(sid, withMentions);
    await flush();
    h.coordinator.updateContent(sid, withMentions.clientId, makeItem(withMentions.clientId, 'edited on phone'));
    const mentionKept = latestProjection(h.projections).pendingQueue
      .find((entry) => entry.clientId === withMentions.clientId);
    expect(mentionKept?.mentions).toEqual([{ type: 'file', name: 'README.md', path: 'README.md' }]);
    // 显式数组才是权威替换:空数组 = 清空。
    h.coordinator.updateContent(sid, withMentions.clientId, makeItem(withMentions.clientId, 'cleared', { mentions: [] }));
    const mentionCleared = latestProjection(h.projections).pendingQueue
      .find((entry) => entry.clientId === withMentions.clientId);
    expect(mentionCleared?.mentions).toBeUndefined();

    const replacement = makeItem(second.clientId, 'edited', {
      persistedContent: JSON.stringify({ text: 'edited', images: [], files: [] }),
      files: [{
        id: 'file-new', name: 'new.png', path: '/tmp/new.png', ext: '.png',
        size: 20, category: 'image', mimeType: 'image/png',
      }],
      chatMessage: {
        clientId: second.clientId,
        role: 'user',
        content: 'edited',
        isStreaming: false,
        // 编辑端重建的时间戳必须被原条目锚定,不许改写回流气泡的位置。
        createdAt: '2026-07-06T12:00:00.000Z',
      },
    });
    h.coordinator.updateContent(sid, second.clientId, replacement);

    const updated = latestProjection(h.projections).pendingQueue[0];
    expect(updated?.text).toBe('edited');
    expect(updated?.files?.map((f) => f.id)).toEqual(['file-new']);
    expect(updated?.chatMessage.content).toBe('edited');
    expect(updated?.chatMessage.clientId).toBe(second.clientId);
    expect(updated?.chatMessage.createdAt).toBe('2026-06-07T00:00:00.000Z');

    // 清空附件是真删除:不能靠 spread 残留旧 files。
    const cleared = makeItem(second.clientId, 'text only', {
      persistedContent: JSON.stringify({ text: 'text only', images: [], files: [] }),
    });
    h.coordinator.updateContent(sid, second.clientId, cleared);
    const afterClear = latestProjection(h.projections).pendingQueue[0];
    expect(afterClear?.files).toBeUndefined();

    // 空内容(无文本且无附件)拒绝,不产生变更。
    const empty = makeItem(second.clientId, '   ');
    h.coordinator.updateContent(sid, second.clientId, empty);
    expect(latestProjection(h.projections).pendingQueue[0]?.text).toBe('text only');
  });
});

describe('AgentInputCoordinator crash-recovery queue snapshots (issue #761)', () => {
  it('persists the queue after restore and shrinks the snapshot once the head crosses the DB boundary', async () => {
    const h = createHarness();
    const sid = 'snapshot-persist';
    await h.coordinator.ensureQueueRestored(sid);

    // agent 忙 → 两条都停留在 pendingQueue,快照应含两条。
    h.setRunning(true);
    h.coordinator.enqueue(sid, makeItem('q-1', 'first'));
    h.coordinator.enqueue(sid, makeItem('q-2', 'second'));
    await flush();
    expect(latestSnapshotClientIds(h.persistQueueSnapshot)).toEqual(['q-1', 'q-2']);

    // turn 结束 → drain 派发 q-1;落库(persisted)后快照立即收窄为 ['q-2'],
    // 不等下一次 turn done —— 长 turn 内崩溃不许把已送达的 q-1 二次恢复。
    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();
    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    expect(latestSnapshotClientIds(h.persistQueueSnapshot)).toEqual(['q-2']);
  });

  it('includes a dispatching-but-unpersisted head in the snapshot (single queued message window)', async () => {
    const h = createHarness();
    const sid = 'snapshot-active-window';
    await h.coordinator.ensureQueueRestored(sid);

    // 卡在 sendToAgent 未决:item 已离队进 activeTurn,但没跨过 DB 边界。
    const gate = deferred<AgentInputSendResult>();
    h.sendToAgent.mockImplementationOnce(async () => gate.promise);
    h.coordinator.enqueue(sid, makeItem('q-1', 'only'));
    await flush();
    expect(latestProjection(h.projections).pendingQueue).toEqual([]);
    expect(latestSnapshotClientIds(h.persistQueueSnapshot)).toEqual(['q-1']);

    gate.resolve(sendSuccess());
    await flush();
  });

  it('does not write snapshots before restore completes, and never resurrects a cleared session', async () => {
    const h = createHarness();
    const sid = 'snapshot-gate';

    // 未恢复前的任何 emit 都不落盘:空内存态不许覆盖删除崩溃前的快照。
    h.setRunning(true);
    h.coordinator.enqueue(sid, makeItem('q-new', 'typed before restore'));
    await flush();
    expect(h.persistQueueSnapshot).not.toHaveBeenCalled();

    // 恢复完成:崩溃前的 r-old 去重后 prepend 到队首,快照重新开闸。
    h.setLoadQueueSnapshot(async () => [makeItem('r-old', 'from crash'), makeItem('q-new', 'dup')]);
    await h.coordinator.ensureQueueRestored(sid);
    await flush();
    const projection = latestProjection(h.projections);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['r-old', 'q-new']);
    // 会话不静默(agent 在跑):不强行暂停。
    expect(projection.queuePaused).toBe(false);
    expect(latestSnapshotClientIds(h.persistQueueSnapshot)).toEqual(['r-old', 'q-new']);

    // clearSession 后收口点必须写空快照(删行),旧队列不许诈尸。
    h.coordinator.clearSession(sid);
    await flush();
    expect(latestSnapshotClientIds(h.persistQueueSnapshot)).toEqual([]);
  });

  it('restores a quiet session as a paused queue and only drains after explicit resume', async () => {
    const h = createHarness();
    const sid = 'snapshot-restore-paused';
    h.setLoadQueueSnapshot(async () => [makeItem('r-1', 'first'), makeItem('r-2', 'second')]);

    await h.coordinator.ensureQueueRestored(sid);
    await flush();

    const projection = latestProjection(h.projections);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['r-1', 'r-2']);
    expect(projection.queuePaused).toBe(true);
    // 重启后不自动替用户发送。
    expect(h.sendToAgent).not.toHaveBeenCalled();

    h.coordinator.resume(sid);
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({ type: 'user', content: 'first' });
  });

  it('releases a crash-restored paused queue on explicit user input (resumeRestorePausedQueue)', async () => {
    const h = createHarness();
    const sid = 'snapshot-restore-explicit-input-release';
    h.setLoadQueueSnapshot(async () => [makeItem('r-1', 'restored')]);

    await h.coordinator.ensureQueueRestored(sid);
    await flush();
    expect(latestProjection(h.projections).queuePaused).toBe(true);

    // composer 发送 / 中断横幅「继续任务」都经 INPUT_ENQUEUE 携带该 flag:
    // 显式用户输入即放行恢复暂停,否则续跑指令只是往暂停队列再塞一条(死锁)。
    h.coordinator.enqueue(sid, makeItem('q-user', 'continue please'), {
      resumeRestorePausedQueue: true,
    });
    await flush();

    const projection = latestProjection(h.projections);
    expect(projection.queuePaused).toBe(false);
    // FIFO 保持:先派发恢复项,新输入跟在后面排队。
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({ type: 'user', content: 'restored' });
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-user']);
  });

  it.each([
    ['app-exit continuation', CONTINUE_AFTER_APP_EXIT_PROMPT],
    ['error continuation', CONTINUE_AFTER_ERROR_PROMPT],
  ])('dispatches %s before an existing restored queue', async (_label, prompt) => {
    const h = createHarness();
    const sid = `snapshot-restore-priority-${_label}`;
    h.setLoadQueueSnapshot(async () => [
      makeItem('r-1', 'queued first'),
      makeItem('r-2', 'queued second'),
    ]);

    await h.coordinator.ensureQueueRestored(sid);
    await flush();
    expect(latestProjection(h.projections).queuePaused).toBe(true);

    h.coordinator.enqueue(sid, makeItem('q-continue', prompt), {
      resumeRestorePausedQueue: true,
    });
    await flush();

    const projection = latestProjection(h.projections);
    expect(projection.queuePaused).toBe(false);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({ type: 'user', content: prompt });
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['r-1', 'r-2']);
  });

  it('projects a continuation as in-flight after it leaves the queue until the turn settles', async () => {
    const h = createHarness();
    const sid = 'continue-in-flight-projection';

    h.coordinator.enqueue(
      sid,
      makeItem('q-continue', CONTINUE_AFTER_APP_EXIT_PROMPT),
      { resumeRestorePausedQueue: true },
    );
    await flush();

    let projection = latestProjection(h.projections);
    expect(projection.pendingQueue).toEqual([]);
    expect(projection.continuationInFlightClientId).toBe('q-continue');

    h.setRunning(false);
    h.coordinator.onTurnEvent(sid, 'done');
    await flush();

    projection = latestProjection(h.projections);
    expect(projection.continuationInFlightClientId).toBeNull();
  });

  it('does not retain an in-flight continuation marker when the user cancels it in the queue', async () => {
    const h = createHarness();
    const sid = 'continue-cancelled-while-queued';
    h.setRunning(true);

    h.coordinator.enqueue(
      sid,
      makeItem('q-continue', CONTINUE_AFTER_APP_EXIT_PROMPT),
      { resumeRestorePausedQueue: true },
    );
    await flush();

    let projection = latestProjection(h.projections);
    expect(projection.pendingQueue.map((item) => item.clientId)).toEqual(['q-continue']);
    expect(projection.continuationInFlightClientId).toBeNull();

    h.coordinator.remove(sid, 'q-continue');
    await flush();

    projection = latestProjection(h.projections);
    expect(projection.pendingQueue).toEqual([]);
    expect(projection.continuationInFlightClientId).toBeNull();
  });

  it('preserves the original Continue intent when a Ghost rewrites the dispatch text', async () => {
    const h = createHarness();
    const sid = 'continue-ghost-rewrite';
    h.setScreenUserMessage(async () => ({
      action: 'rewrite',
      ghostId: 'ghost-1',
      ghostName: 'Guard',
      text: 'Continue with the reviewed constraints.',
    }));

    h.coordinator.enqueue(
      sid,
      makeItem('q-continue', CONTINUE_AFTER_ERROR_PROMPT),
      { resumeRestorePausedQueue: true },
    );
    await flush();

    expect(h.sendToAgent).toHaveBeenCalledWith(
      sid,
      { type: 'user', content: 'Continue with the reviewed constraints.' },
      expect.any(Object),
      expect.any(Object),
    );
    expect(h.onDispatchedUserTurn).toHaveBeenCalledWith(
      sid,
      expect.objectContaining({
        clientId: 'q-continue',
        text: 'Continue with the reviewed constraints.',
        originalSyntheticTrigger: 'continue',
      }),
      expect.any(Number),
    );
  });

  it('recomputes original trigger intent instead of trusting a forged enqueue field', async () => {
    const h = createHarness();
    const sid = 'normal-message-forged-continue-intent';

    h.coordinator.enqueue(
      sid,
      makeItem('q-normal', 'ordinary message', {
        originalSyntheticTrigger: 'continue',
      }),
    );
    await flush();

    const dispatchedItem = h.onDispatchedUserTurn.mock.calls[0]?.[1];
    expect(dispatchedItem?.originalSyntheticTrigger).toBeUndefined();
    expect(latestProjection(h.projections).continuationInFlightClientId).toBeNull();
  });

  it('passes a pre-vendor timestamp to the irreversible dispatch hook', async () => {
    const h = createHarness();
    const sid = 'continue-dispatch-ack-timestamp';
    vi.spyOn(Date, 'now').mockReturnValue(50_000);

    const item = makeItem('q-continue', CONTINUE_AFTER_APP_EXIT_PROMPT);
    h.coordinator.enqueue(sid, item, { resumeRestorePausedQueue: true });
    await flush();

    expect(h.onDispatchedUserTurn).toHaveBeenCalledWith(
      sid,
      expect.objectContaining({
        clientId: item.clientId,
        originalSyntheticTrigger: 'continue',
      }),
      49_999,
    );
    expect(h.onDispatchedUserTurn.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.sendToAgent.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps a crash-restored paused queue when the enqueue lacks the explicit-input flag (orca path)', async () => {
    const h = createHarness();
    const sid = 'snapshot-restore-orca-keeps-paused';
    h.setLoadQueueSnapshot(async () => [makeItem('r-1', 'restored')]);

    await h.coordinator.ensureQueueRestored(sid);
    await flush();

    // Orca 等 main 侧自动投递不带 flag:恢复暂停语义保持,不自动替用户发送。
    h.coordinator.enqueue(sid, makeItem('q-orca', 'orca message'));
    await flush();

    const projection = latestProjection(h.projections);
    expect(projection.queuePaused).toBe(true);
    expect(h.sendToAgent).not.toHaveBeenCalled();
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['r-1', 'q-orca']);
  });

  it('does not release a user-stopped paused queue on explicit input (stop semantics preserved)', async () => {
    const h = createHarness();
    const sid = 'stop-paused-not-released-by-input';
    h.setRunning(true);
    h.coordinator.enqueue(sid, makeItem('q-1', 'queued before stop'));
    await flush();
    h.coordinator.stop(sid, { keepQueue: true, pauseQueue: true });
    h.setRunning(false);
    await flush();
    expect(latestProjection(h.projections).queuePaused).toBe(true);

    // 用户显式 Stop 出来的暂停不许新输入静默放行(区别于崩溃恢复暂停)。
    h.coordinator.enqueue(sid, makeItem('q-2', 'new user input'), {
      resumeRestorePausedQueue: true,
    });
    await flush();

    const projection = latestProjection(h.projections);
    expect(projection.queuePaused).toBe(true);
    expect(h.sendToAgent).not.toHaveBeenCalled();
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-1', 'q-2']);
  });

  it('keeps the persistence gate closed when loading fails, then retries on the next entry point', async () => {
    const h = createHarness();
    const sid = 'snapshot-load-retry';
    let attempts = 0;
    h.setLoadQueueSnapshot(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('db not ready');
      return [makeItem('r-1', 'recovered')];
    });

    await h.coordinator.ensureQueueRestored(sid).catch(() => undefined);
    // 读失败:不标记已恢复,收口点保持关闭。
    h.setRunning(true);
    h.coordinator.enqueue(sid, makeItem('q-1', 'first'));
    await flush();
    expect(h.persistQueueSnapshot).not.toHaveBeenCalled();

    // 下一个入口重试成功:恢复项 prepend 并开闸。
    await h.coordinator.ensureQueueRestored(sid);
    await flush();
    expect(attempts).toBe(2);
    expect(latestProjection(h.projections).pendingQueue.map((q) => q.clientId)).toEqual(['r-1', 'q-1']);
    expect(latestSnapshotClientIds(h.persistQueueSnapshot)).toEqual(['r-1', 'q-1']);
  });

  it('skips the redundant snapshot write when memory state already matches the loaded snapshot', async () => {
    const h = createHarness();
    const sid = 'snapshot-noop';
    h.setLoadQueueSnapshot(async () => []);
    await h.coordinator.ensureQueueRestored(sid);
    await flush();
    // 空快照 + 空队列:变更检测缓存已预热,不发多余的覆盖写/删除。
    expect(h.persistQueueSnapshot).not.toHaveBeenCalled();
  });

  it('deduplicates snapshot items against already-persisted DB messages (getPersistedClientIds)', async () => {
    const h = createHarness();
    const sid = 'snapshot-db-dedup';
    h.setLoadQueueSnapshot(async () => [
      makeItem('already-in-db', 'persisted msg'),
      makeItem('not-in-db', 'fresh msg'),
    ]);
    h.setGetPersistedClientIds(async (_sessionId, clientIds) => {
      return new Set(clientIds.filter((id) => id === 'already-in-db'));
    });

    await h.coordinator.ensureQueueRestored(sid);
    await flush();

    const projection = latestProjection(h.projections);
    // 已落库的被过滤,只有 not-in-db 进入恢复队列。
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['not-in-db']);
    expect(projection.queuePaused).toBe(true);
  });
});

describe('AgentInputCoordinator enqueue clientId 幂等去重(弱网重发防线,PR #881)', () => {
  beforeEach(() => {
    mocks.createMessage.mockClear();
  });

  it('agent 忙(排队中):同 clientId 重复投递不二次入队,返回当前 projection', async () => {
    const h = createHarness();
    h.setRunning(true);
    h.coordinator.enqueue('s1', makeItem('c1', 'hello'));
    await flush();
    const projection = h.coordinator.enqueue('s1', makeItem('c1', 'hello'));
    expect(projection.pendingQueue.filter((q) => q.clientId === 'c1')).toHaveLength(1);
  });

  it('空闲 agent(enqueue-immediate,消息已进 activeTurn 不在 pendingQueue):重复投递不触发第二次派发', async () => {
    const h = createHarness();
    const gate = deferred<void>();
    h.sendToAgent.mockImplementationOnce(async (sessionId, _message, _createOpts, sendOpts) => {
      await persistQueuedUserMessage(sessionId, sendOpts);
      await gate.promise; // 卡住派发,模拟 turn 进行中(activeTurn 已置、队列已空)
      return sendSuccess();
    });
    h.coordinator.enqueue('s1', makeItem('c1', 'hello'));
    await flush();
    // 此刻消息已离队(enqueue-immediate 同步 slice 进 activeTurn)
    expect(h.coordinator.getProjection('s1').pendingQueue).toHaveLength(0);

    // 弱网重发同一条:必须被幂等吞掉,而不是当新消息二次入队
    const projection = h.coordinator.enqueue('s1', makeItem('c1', 'hello'));
    expect(projection.pendingQueue).toHaveLength(0);
    gate.resolve();
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
  });

  it('turn 已极快结束(不在队列 / activeTurn):近期已受理窗口仍能识破补发', async () => {
    const h = createHarness();
    h.coordinator.enqueue('s1', makeItem('c1', 'hello'));
    await flush(); // 派发完成(mock sendToAgent 立即成功)
    const before = h.sendToAgent.mock.calls.length;
    h.coordinator.enqueue('s1', makeItem('c1', 'hello'));
    await flush();
    expect(h.sendToAgent.mock.calls.length).toBe(before); // 没有第二次派发
  });

  it('用户显式 remove 后重新入队同 clientId:合法流,不被幂等窗口误吞', async () => {
    const h = createHarness();
    h.setRunning(true);
    h.coordinator.enqueue('s1', makeItem('c1', 'hello'));
    await flush();
    h.coordinator.remove('s1', 'c1');
    await flush();
    const projection = h.coordinator.enqueue('s1', makeItem('c1', 'hello'));
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['c1']);
  });

  it('不同 clientId 的新消息不受去重影响', async () => {
    const h = createHarness();
    h.setRunning(true);
    h.coordinator.enqueue('s1', makeItem('c1', 'hello'));
    const projection = h.coordinator.enqueue('s1', makeItem('c2', 'world'));
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['c1', 'c2']);
  });
});

describe('AgentInputCoordinator 意识拦截钩(订阅槽①,will-user-message)', () => {
  it('projects quote markers and structured references for Ghost, turn and steer', async () => {
    const href = 'cindy://session/session-a?message=message-a';
    const raw = `> <!-- cindy-composer-quote -->\n> selected\n\ninspect ${href}`;
    const item = makeItem('semantic-turn', raw, {
      persistedContent: JSON.stringify({ text: raw, quotesEncoded: true }),
      agentReferences: [{
        kind: 'message',
        start: raw.indexOf(href),
        end: raw.indexOf(href) + href.length,
        href,
        sessionId: 'session-a',
        messageClientId: 'message-a',
        text: 'Target message body',
      }],
      chatMessage: {
        clientId: 'semantic-turn',
        role: 'user',
        content: raw,
        quotesEncoded: true,
      },
    });

    const turn = createHarness();
    const turnScreen = vi.fn<NonNullable<AgentInputCoordinatorDeps['screenUserMessage']>>(
      async () => ({ action: 'allow' }) as const,
    );
    turn.setScreenUserMessage(turnScreen);
    turn.coordinator.enqueue('semantic-turn-session', item);
    await flush();

    const turnScreenText = turnScreen.mock.calls[0]?.[1];
    expect(turnScreenText).not.toContain('cindy-composer-quote');
    expect(turnScreenText).not.toContain(href);
    expect(turnScreenText).toContain('Target message body');
    const turnText = (turn.sendToAgent.mock.calls[0]?.[1] as { content: string }).content;
    expect(turnText).toBe(turnScreenText);

    const steer = createHarness();
    steer.setRunning(true);
    const steerScreen = vi.fn<NonNullable<AgentInputCoordinatorDeps['screenUserMessage']>>(
      async () => ({ action: 'allow' }) as const,
    );
    steer.setScreenUserMessage(steerScreen);
    const steerItem = {
      ...item,
      clientId: 'semantic-steer',
      chatMessage: { ...item.chatMessage, clientId: 'semantic-steer' },
    };
    expect(await steer.coordinator.steer('semantic-steer-session', steerItem)).toBe(true);
    await flush();

    const steerScreenText = steerScreen.mock.calls[0]?.[1];
    expect(steerScreenText).not.toContain('cindy-composer-quote');
    expect(steerScreenText).not.toContain(href);
    expect(steerScreenText).toContain('Target message body');
    const steerText = (steer.steerToAgent.mock.calls[0]?.[1] as { content: string }).content;
    expect(steerText).toBe(steerScreenText);
  });

  it('block:丢弃排队项(不落库不派发),回调 onUserMessageBlocked,后续消息继续放行', async () => {
    const h = createHarness();
    h.setScreenUserMessage(async (_sid, agentFacingText) =>
      agentFacingText.includes('剧透')
        ? { action: 'block', ghostId: 'g1', ghostName: '哨兵', reason: '含剧透' }
        : { action: 'allow' },
    );
    h.coordinator.enqueue('s1', makeItem('c1', '剧透话'));
    h.coordinator.enqueue('s1', makeItem('c2', '正常话'));
    await flush();
    expect(h.onUserMessageBlocked).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ clientId: 'c1' }),
      { action: 'block', ghostId: 'g1', ghostName: '哨兵', reason: '含剧透' },
    );
    // 被拦项从未进 sendToAgent(不落库不起 turn);第二条正常派发
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent.mock.calls[0][1]).toMatchObject({ content: '正常话' });
    expect(
      mocks.createMessage.mock.calls.every(
        (c) => (c[1] as { clientId?: string }).clientId !== 'c1',
      ),
    ).toBe(true);
  });

  it('bypassGhostHooks:强行放行的重发不再询问钩子', async () => {
    const h = createHarness();
    const screen = vi.fn(async () => ({ action: 'block', ghostId: 'g1', ghostName: '哨兵', reason: 'x' }) as const);
    h.setScreenUserMessage(screen);
    h.coordinator.enqueue('s1', makeItem('c1', '剧透话', { bypassGhostHooks: true }));
    await flush();
    expect(screen).not.toHaveBeenCalled();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.onUserMessageBlocked).not.toHaveBeenCalled();
  });

  it('allow:正常派发,行为与无钩子完全一致', async () => {
    const h = createHarness();
    h.setScreenUserMessage(async () => ({ action: 'allow' }) as const);
    h.coordinator.enqueue('s1', makeItem('c1', 'hello'));
    await flush();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.onUserMessageBlocked).not.toHaveBeenCalled();
  });

  it('rewrite:改写版落库 + 送 agent,回调 onUserMessageRewritten 带原文', async () => {
    const h = createHarness();
    h.setScreenUserMessage(async () => ({
      action: 'rewrite',
      ghostId: 'g1',
      ghostName: '哨兵',
      text: '优化后的问题',
    }) as const);
    h.coordinator.enqueue('s1', makeItem('c1', '润色 原始问题'));
    await flush();
    // 送 agent 的消息是改写版(buildMakerUserMessage 读 head.text)
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
    expect(h.sendToAgent.mock.calls[0][1]).toMatchObject({ content: '优化后的问题' });
    // 落库内容也是改写版(persistUserMessage.content = head.persistedContent)
    expect(
      mocks.createMessage.mock.calls.some(
        (c) => (c[1] as { clientId?: string; content?: string }).clientId === 'c1'
          && (c[1] as { content?: string }).content === '优化后的问题',
      ),
    ).toBe(true);
    // 回调带原文供留痕
    expect(h.onUserMessageRewritten).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ clientId: 'c1' }),
      { ghostId: 'g1', ghostName: '哨兵', text: '优化后的问题', originalText: '润色 原始问题' },
    );
    expect(h.onUserMessageBlocked).not.toHaveBeenCalled();
  });

  it('rewrite:persistedContent 是 JSON 信封(带附件/引用)时只换 text 字段,引用不丢', async () => {
    const h = createHarness();
    h.setScreenUserMessage(async () => ({
      action: 'rewrite',
      ghostId: 'g1',
      ghostName: '哨兵',
      text: '优化后的问题',
    }) as const);
    // stringifyUserContent 形态的信封:text 之外还有图片引用与引用块。
    const envelope = JSON.stringify({
      text: '润色 原始问题',
      images: [{ fileId: 'img-1', name: 'ref.png' }],
      quotesEncoded: 'q-payload',
    });
    h.coordinator.enqueue('s1', makeItem('c1', '润色 原始问题', { persistedContent: envelope }));
    await flush();
    const persisted = mocks.createMessage.mock.calls.find(
      (c) => (c[1] as { clientId?: string }).clientId === 'c1',
    )?.[1] as { content: string };
    const parsed = JSON.parse(persisted.content) as Record<string, unknown>;
    // text 换成改写版,附件引用与引用块原样保留——整体覆写会把它们毁掉(回归锁)。
    expect(parsed.text).toBe('优化后的问题');
    expect(parsed.images).toEqual([{ fileId: 'img-1', name: 'ref.png' }]);
    expect(parsed.quotesEncoded).toBe('q-payload');
  });

  it('rewrite:marker 被移除时同步清除真实 quotesEncoded 标志', async () => {
    const h = createHarness();
    h.setScreenUserMessage(async () => ({
      action: 'rewrite',
      ghostId: 'g1',
      ghostName: '哨兵',
      text: '> ordinary markdown after rewrite',
    }) as const);
    const original = '> <!-- cindy-composer-quote -->\n> product quote\n\n润色 原始问题';
    const envelope = JSON.stringify({ text: original, quotesEncoded: true });
    h.coordinator.enqueue('s1', makeItem('c1', original, {
      persistedContent: envelope,
      chatMessage: {
        clientId: 'c1',
        role: 'user',
        content: original,
        quotesEncoded: true,
      },
    }));

    await flush();

    const persisted = mocks.createMessage.mock.calls.find(
      (c) => (c[1] as { clientId?: string }).clientId === 'c1',
    )?.[1] as { content: string };
    expect(JSON.parse(persisted.content)).toEqual({
      text: '> ordinary markdown after rewrite',
      slashCommandRanges: [],
    });
    const rewrittenItem = h.onUserMessageRewritten.mock.calls[0]?.[1];
    expect(rewrittenItem?.chatMessage.quotesEncoded).toBeUndefined();
  });

  it('rewrite:clears stale Composer reference offsets from wire and Agent input', async () => {
    const h = createHarness();
    const href = 'cindy://session/session-a?message=message-a';
    const original = `inspect ${href}`;
    h.setScreenUserMessage(async () => ({
      action: 'rewrite',
      ghostId: 'g1',
      ghostName: '哨兵',
      text: `rewritten ${href}`,
    }) as const);
    const reference = {
      kind: 'message' as const,
      start: original.indexOf(href),
      end: original.length,
      href,
      sessionId: 'session-a',
      messageClientId: 'message-a',
      text: 'Target message body',
    };
    h.coordinator.enqueue('s1', makeItem('c1', original, {
      persistedContent: JSON.stringify({
        text: original,
        agentReferences: [reference],
      }),
      agentReferences: [reference],
    }));

    await flush();

    expect(h.sendToAgent.mock.calls[0]?.[1]).toEqual({
      type: 'user',
      content: `rewritten ${href}`,
    });
    const persisted = mocks.createMessage.mock.calls.find(
      (call) => (call[1] as { clientId?: string }).clientId === 'c1',
    )?.[1] as { content: string };
    expect(JSON.parse(persisted.content)).toEqual({
      text: `rewritten ${href}`,
      slashCommandRanges: [],
    });
    expect(h.onUserMessageRewritten.mock.calls[0]?.[1].agentReferences).toBeUndefined();
  });
});

describe('AgentInputCoordinator scheduler 排队心跳(撞忙排队桥)', () => {
  const schedulerOrigin = (scheduleId: string) =>
    ({ kind: 'scheduler', scheduleId, scheduleName: `任务 ${scheduleId}` }) as const;

  it('hasQueuedItemWhere 同时覆盖 pending 行与派发中的 activeTurn 项', async () => {
    const h = createHarness();
    const sid = 'sched-queue';
    // 第一条立即 drain 成 activeTurn(turn 未结束前一直占位),第二条留在 pending。
    h.coordinator.enqueue(sid, makeItem('c1', 'hb A', { origin: schedulerOrigin('sch-A') }));
    await flush();
    h.coordinator.enqueue(sid, makeItem('c2', 'hb B', { origin: schedulerOrigin('sch-B') }));
    await flush();

    const bySchedule = (scheduleId: string) =>
      h.coordinator.hasQueuedItemWhere(
        sid,
        (item) => item.origin?.kind === 'scheduler' && item.origin.scheduleId === scheduleId,
      );
    expect(bySchedule('sch-A')).toBe(true); // activeTurn 项
    expect(bySchedule('sch-B')).toBe(true); // pending 行
    expect(bySchedule('sch-C')).toBe(false);
  });

  it('drain 派发把 scheduler origin 透传进 sendOpts(orca/无 origin 项不透传)', async () => {
    const h = createHarness();
    h.coordinator.enqueue('s-sched', makeItem('c1', 'hb', { origin: schedulerOrigin('sch-1') }));
    await flush();
    const schedSendOpts = h.sendToAgent.mock.calls.at(-1)?.[3] as { origin?: unknown };
    expect(schedSendOpts.origin).toEqual(schedulerOrigin('sch-1'));

    // 无 origin 的普通输入不透传(独立 harness:上面的派发已把全局 running 翻 true)。
    const h2 = createHarness();
    h2.coordinator.enqueue('s-plain', makeItem('c2', 'plain user input'));
    await flush();
    const plainSendOpts = h2.sendToAgent.mock.calls.at(-1)?.[3] as { origin?: unknown };
    expect(plainSendOpts.origin).toBeUndefined();
  });
});

describe('AgentInputCoordinator scheduler 排队心跳(review 反馈回归)', () => {
  const schedOrigin = { kind: 'scheduler', scheduleId: 'sch-1', scheduleName: '任务 1' } as const;

  it('scheduler 入队不 bump userSendAt(普通输入照常 bump)', async () => {
    // userSendAt 是 B1 活跃礼让判据,自动化入队 bump 会让同会话后续心跳被误当
    // 用户活跃而静默顺延(review P2);侧栏排序 bump 由 runner 在派发时刻补。
    const h = createHarness();
    h.coordinator.enqueue('s-a', makeItem('c1', 'hb', { origin: schedOrigin }));
    await flush();
    expect(mocks.touchUserSendInDb).not.toHaveBeenCalled();

    h.coordinator.enqueue('s-b', makeItem('c2', 'user text'));
    await flush();
    expect(mocks.touchUserSendInDb).toHaveBeenCalledWith('s-b', undefined);
  });

  it('active-turn recovery 项:去重视为在途,存活探测视为不存活', async () => {
    // 派发在持久化后被取消 → 项转 active-turn recovery:后续 Retry 走克隆已受理
    // turn 路径,不再经过 onAcceptedQueuedMessage —— 排队方的回调等不到了。
    // 去重(includeRecovery:true)仍要看见它防双份;存活探测(默认)必须判死,
    // 让 runner 的 run 以失败收口而非永久挂 running(review P1)。
    const h = createHarness();
    const sid = 'sched-recovery';
    h.sendToAgent.mockImplementationOnce(async (sessionId, _message, _createOpts, sendOpts) => {
      await persistQueuedUserMessage(sessionId, sendOpts);
      return sessionDispatchFailure('SEND/sched-recovery/send');
    });
    h.coordinator.enqueue(sid, makeItem('c1', 'hb', { origin: schedOrigin }));
    await flush();

    expect(latestProjection(h.projections).recovery?.kind).toBe('active-turn');
    const bySchedule = (includeRecovery: boolean) =>
      h.coordinator.hasQueuedItemWhere(
        sid,
        (item) => item.origin?.kind === 'scheduler' && item.origin.scheduleId === 'sch-1',
        { includeRecovery },
      );
    expect(bySchedule(true)).toBe(true);
    expect(bySchedule(false)).toBe(false);
    expect(
      h.coordinator.hasQueuedItemWhere(sid, (item) => item.clientId === 'c1'),
    ).toBe(false);
  });

  it('崩溃快照恢复时丢弃 scheduler 项(不进暂停队列,普通项照常恢复)', async () => {
    // 静默会话的恢复队列是 queuePausedByRestore 暂停态,自动化项等不来"用户显式
    // 输入"的放行,会永远滞留并让同任务去重把后续 fire 全判 duplicate —— 无人值守
    // 自动化停摆(review P1)。scheduler 项直接丢弃,下一轮 cron fire 重新入队。
    const h = createHarness();
    const sid = 'sched-restore-drop';
    h.setLoadQueueSnapshot(async () => [
      makeItem('c-sched', 'hb', { origin: schedOrigin }),
      makeItem('c-user', 'user draft'),
    ]);
    await h.coordinator.ensureQueueRestored(sid);
    const projection = latestProjection(h.projections);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['c-user']);
    expect(projection.queuePaused).toBe(true);
    // 去重视角也看不到被丢弃的 scheduler 项 —— 后续 fire 不会被僵尸挡住。
    expect(
      h.coordinator.hasQueuedItemWhere(
        sid,
        (item) => item.origin?.kind === 'scheduler',
        { includeRecovery: true },
      ),
    ).toBe(false);
  });

  it('isQueuePaused:用户 Stop 暂停队列时为 true(scheduler 桥据此顺延不入队)', async () => {
    // 暂停队列永不 drain,塞进去的心跳 accepted 永远不来 —— 桥在入队前查此态
    // 返回 retry 顺延(review P1/P2)。
    const h = createHarness();
    const sid = 'sched-paused';
    h.coordinator.enqueue(sid, makeItem('c1', 'draft'));
    await flush();
    h.coordinator.enqueue(sid, makeItem('c2', 'draft-2'));
    expect(h.coordinator.isQueuePaused(sid)).toBe(false);
    h.coordinator.stop(sid, { keepQueue: true, pauseQueue: true });
    await flush();
    expect(h.coordinator.isQueuePaused(sid)).toBe(true);
  });

  it('isQueueRestored:读快照失败保持未恢复态,成功后翻 true', async () => {
    // ensureQueueRestored 失败内部吞错,调用方只能靠 isQueueRestored 区分成败;
    // scheduler 桥在未恢复时不入队(返回 retry 顺延),防恢复后双份派发(review P1)。
    const h = createHarness();
    const sid = 'sched-restore';
    let fail = true;
    h.setLoadQueueSnapshot(async () => {
      if (fail) throw new Error('disk read failed');
      return [];
    });
    expect(h.coordinator.isQueueRestored(sid)).toBe(false);
    await h.coordinator.ensureQueueRestored(sid).catch(() => undefined);
    expect(h.coordinator.isQueueRestored(sid)).toBe(false);

    fail = false;
    await h.coordinator.ensureQueueRestored(sid).catch(() => undefined);
    expect(h.coordinator.isQueueRestored(sid)).toBe(true);
  });
});

describe('AgentInputCoordinator replaceQueuedMessage(Orca lead 排队消息修改)', () => {
  it('原位整条替换 pending 条目:位置不变、投影与崩溃快照同步新内容', async () => {
    const h = createHarness();
    const sid = 'replace-pending';
    // 解锁崩溃快照持久化:未恢复的会话 maybePersistQueueSnapshot 直接跳过。
    await h.coordinator.ensureQueueRestored(sid);
    h.coordinator.enqueue(sid, makeItem('q-1', 'first'));
    await flush();
    h.coordinator.enqueue(sid, makeItem('q-2', 'second'));
    h.coordinator.enqueue(sid, makeItem('q-3', 'third'));
    await flush();

    const replaced = h.coordinator.replaceQueuedMessage(sid, 'q-2', makeItem('q-2', 'second-edited'));

    expect(replaced).toBe(true);
    const projection = latestProjection(h.projections);
    expect(projection.pendingQueue.map((q) => q.clientId)).toEqual(['q-2', 'q-3']);
    expect(projection.pendingQueue[0]?.text).toBe('second-edited');
    expect(
      h.persistQueueSnapshot.mock.calls.at(-1)?.[1].find((item) => item.clientId === 'q-2')?.text,
    ).toBe('second-edited');
  });

  it('拒绝身份漂移与不存在的条目', async () => {
    const h = createHarness();
    const sid = 'replace-guards';
    h.coordinator.enqueue(sid, makeItem('q-1', 'first'));
    await flush();
    h.coordinator.enqueue(sid, makeItem('q-2', 'second'));
    await flush();

    // next 的 clientId 必须锚定原条目,防止替换顺带改身份。
    expect(h.coordinator.replaceQueuedMessage(sid, 'q-2', makeItem('q-x', 'hijack'))).toBe(false);
    // 已派发(不在 pendingQueue)的条目不可替换。
    expect(h.coordinator.replaceQueuedMessage(sid, 'q-1', makeItem('q-1', 'late'))).toBe(false);
    expect(latestProjection(h.projections).pendingQueue[0]?.text).toBe('second');
  });

  it('steering 中的条目不可替换', async () => {
    const h = createHarness();
    h.setAgentKind('codex');
    const sid = 'replace-steering';
    const steer = deferred<void>();
    h.steerToAgent.mockImplementationOnce(() => steer.promise);

    h.coordinator.enqueue(sid, makeItem('q-1', 'first'));
    await flush();
    const second = makeItem('q-2', 'second');
    h.coordinator.enqueue(sid, second);
    await flush();

    const steerPromise = h.coordinator.steer(sid, second, { removeFromQueue: true });
    await flush();
    expect(latestProjection(h.projections).steeringQueueClientIds).toEqual(['q-2']);

    expect(h.coordinator.replaceQueuedMessage(sid, 'q-2', makeItem('q-2', 'edited'))).toBe(false);

    steer.resolve();
    await steerPromise;
  });
});
