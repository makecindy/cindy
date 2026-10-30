/**
 * #5880：运行中远端组员离线，终态错误 drain 宽限(250ms)到点关闭旧会话，与 failover 取得重试句柄赛跑。
 * 用真实的 AgentInputCoordinator、真实的会话关闭接线(createSessionBindingLifecycle → runSessionCloseCleanup →
 * onSessionClosed，按 register 的 captureCloseContext 计算 preserveAutoResumeIntent)与真实的供应商组 service；
 * 只把组内电脑、交接与任务记录换成内存实现。
 */
import type { SessionStatus } from '@cindy/maker-core';
import type { ProviderView } from '@cindy/model-providers';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { CONTINUE_AFTER_ERROR_PROMPT } from '../../../shared/interruptedTurn';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue';
import type { ProviderGroupConfig, ProviderGroupMember } from '../../../shared/providerGroup';
import { AgentInputCoordinator, type AgentInputCoordinatorDeps } from '../../maker-ipc/agent-input-coordinator';
import { shouldPreserveWaitingContinuationOnlyAutoResume } from '../../maker-ipc/interruptedTurnAutoResume';
import { createSessionBindingLifecycle, runSessionCloseCleanup } from '../../maker-ipc/sessionBindingLifecycle';
import type { IpcHandler } from '../../maker-ipc/ipcHandlerRegistry';
import { registerStopSessionBackgroundTasksHandler } from '../../maker-ipc/stopSessionBackgroundTasksHandler';
import type { ProviderGroupBinding } from '../bindings';
import type { ProviderGroupDirectory, ResolvedMemberState, ResolvedProviderGroupMember } from '../directory';
import { createProviderGroupRouter } from '../router';
import {
  createProviderGroupService,
  type ProviderGroupServiceDeps,
  type ProviderGroupSessionRow,
} from '../service';

vi.mock('../../localDb/ipc/messages.js', () => ({ createMessage: vi.fn(async () => ({})) }));
vi.mock('../../localDb/ipc/sessions.js', () => ({ touchUserSendInDb: vi.fn(async () => {}) }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const SID = 'task-5880';
const MODEL = 'claude-opus-5-5';
const LOCAL: ProviderGroupMember = {
  key: 'local', kind: 'local', agentDeviceId: null, providerId: 'anthropic', limit: 4, weight: 1, paused: false,
};
const MAC_B: ProviderGroupMember = {
  key: 'device:mac-b:anthropic-b', kind: 'device', agentDeviceId: 'mac-b', providerId: 'anthropic-b', limit: 4, weight: 1, paused: false,
};
/** 现场的决定：phase=run action=switch cause=unavailable connection=lost code=REMOTE_AGENT_UNAVAILABLE。 */
const B_LOST = {
  reason: 'remote_agent_lost',
  message: '[REMOTE_AGENT_UNAVAILABLE] The computer running this agent is unreachable.',
};

function view(id: string): ProviderView {
  return {
    id,
    name: id,
    agents: ['claude-code'],
    connected: true,
    models: { 'claude-code': [{ id: MODEL, name: MODEL, efforts: [], defaultEffort: null }] },
    routing: { 'claude-code': {} },
  } as unknown as ProviderView;
}

function item(clientId: string, text: string): AgentInputQueuedMessage {
  const createOpts = {
    agentKind: 'claude-code',
    workingDir: '/repo',
    model: MODEL,
    effort: 'medium',
    permissionMode: 'default',
    userPrompt: '',
    makerMemoryEnabled: true,
    displayReasoning: 'summarized',
  } as AgentInputQueuedMessage['createOpts'];
  return {
    clientId,
    text,
    persistedContent: text,
    model: MODEL,
    effort: 'medium',
    permissionMode: 'default',
    workingDir: '/repo',
    chatMessage: { clientId, role: 'user', content: text, isStreaming: false, createdAt: '2026-10-12T08:26:00.000Z' },
    createOpts,
  } as AgentInputQueuedMessage;
}

/**
 * register.ts 里「全部停止」注册处的 noteSessionReset：逐行(去掉缩进与注释)与这份期望原文完全一致，
 * 下面的「全部停止」用例按同一份原文接线(resetAutomaticRecoveryForExplicitStop 用 spy 代替)。
 */
const REGISTER_SOURCE = readFileSync(new URL('../../maker-ipc/register.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const STOP_ALL_NOTE_SESSION_RESET = [
  'noteSessionReset: (sessionId) => {',
  'resetAutomaticRecoveryForExplicitStop(sessionId);',
  'providerGroupService?.noteUserAction(sessionId);',
  '},',
];
function stopAllRegistration(): string {
  const start = REGISTER_SOURCE.indexOf('registerStopSessionBackgroundTasksHandler(createElectronIpcHandlerRegistry(), {');
  const end = REGISTER_SOURCE.indexOf('\n  });', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return REGISTER_SOURCE.slice(start, end);
}
function stopAllNoteSessionResetLines(): string[] {
  const registration = stopAllRegistration();
  const start = registration.indexOf('    noteSessionReset:');
  const end = registration.indexOf('\n    notifyGoalStop:', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return registration
    .slice(start, end)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//'));
}

async function flush() {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

interface FakeSession {
  id: string;
  closeReason: 'unexpected' | 'agent-switch' | 'requested';
  listeners: Set<(status: SessionStatus) => void>;
  onStatusChange(listener: (status: SessionStatus) => void): () => void;
  setInteractionListener(listener: unknown): void;
}

function setup(options: { bComesBack?: boolean } = {}) {
  let running = false;
  const config: ProviderGroupConfig = { strategy: 'order', autoSwitch: true, members: [MAC_B, LOCAL] };
  const offline = new Set<string>([MAC_B.key]);
  const bindings = new Map<string, ProviderGroupBinding>([[SID, { providerId: 'anthropic', memberKey: MAC_B.key, at: 1 }]]);
  const row: ProviderGroupSessionRow = {
    agentKind: 'claude-code', model: MODEL, providerId: MAC_B.providerId, agentDeviceId: MAC_B.agentDeviceId,
    remoteHostId: null, sdkSessionId: 'native-on-b',
  };

  // ── 真实的输入协调器 ──
  const sendToAgent = vi.fn<AgentInputCoordinatorDeps['sendToAgent']>(async (_sid, _message, _createOpts, sendOpts) => {
    const persist = sendOpts.persistUserMessage;
    (persist as { onPersisting?: () => void } | undefined)?.onPersisting?.();
    await persist?.onPersisted?.();
    running = true;
    return { kind: 'session-dispatch', source: 'test', dispatched: true };
  });
  let service!: ReturnType<typeof createProviderGroupService>;
  const coordinator = new AgentInputCoordinator({
    sendToAgent,
    steerToAgent: vi.fn(async () => {}),
    abortSession: vi.fn(async () => {}),
    isTurnRunning: () => running,
    hasPendingInteraction: () => false,
    getAgentKind: () => 'claude-code',
    getSdkSessionId: async () => 'native-on-b',
    hasAssistantProgressAfter: async () => true,
    emitProjection: () => {},
    // 现场：这次错误没有被中断自愈接管(否则不会走到供应商组)。
    isResumableTurnErrorCandidate: () => false,
    onResumableTurnError: () => null,
    providerGroupSwitchCandidate: (sessionId, signals) =>
      service.mayHandleTurnError(sessionId, signals) ? 'unavailable' : null,
    onUsageLimitedTurnError: (sessionId, signals, _item, token) => {
      turnError = service.onTurnError(sessionId, signals, token, hooks);
    },
  });
  let turnError: Promise<void> | null = null;
  const hooks = {
    beforeFallback: vi.fn(),
    resumed: vi.fn(),
    reconnecting: vi.fn(),
    switching: vi.fn(),
    continuing: vi.fn(),
  };

  // ── 真实的会话关闭接线(与 register.ts 的 captureCloseContext / cleanupClosedSession 相同的判定与顺序) ──
  const resetAutoResume = vi.fn();
  const closeContexts: Array<{ closeReason: string; preserveAutoResumeIntent: boolean }> = [];
  const lifecycle = createSessionBindingLifecycle<FakeSession, { closeReason: string; preserveAutoResumeIntent: boolean }>({
    log: { warn: vi.fn() },
    restoreInteractionListener: () => {},
    beforeReplace: () => {},
    onBind: () => {},
    broadcastStatus: () => {},
    captureCloseContext: (session) => {
      const coordinatorAttemptToken = coordinator.getAutoResumeAttemptToken(session.id);
      const preserveAutoResumeIntent = shouldPreserveWaitingContinuationOnlyAutoResume({
        closeReason: session.closeReason,
        // 这次错误没有中断自愈的尝试：register 的 pendingContinuationOnlyAutoResumeRebuilds / guard / book 都没有它。
        leasedAttemptToken: undefined,
        guardIsCurrentAttempt: false,
        bookIsCurrentAttempt: false,
        coordinatorAttemptToken,
        hasLiveSchedule: false,
        hasQueuedAutoResume: coordinator.hasQueuedAutoResume(session.id),
        isContinuationOnly: coordinator.isContinuationOnlyAutoResume(session.id),
      });
      const context = { closeReason: session.closeReason, preserveAutoResumeIntent };
      closeContexts.push(context);
      return context;
    },
    cleanupClosedSession: (session, context) => {
      runSessionCloseCleanup(context.preserveAutoResumeIntent, {
        cleanupInteractions: () => {},
        preserveAutoResume: () => {},
        resetAutoResume,
        shouldPreserveInputBoundary: () => false,
        closeInputCoordinator: (closeOptions) => coordinator.onSessionClosed(session.id, closeOptions),
        cleanupRuntimeState: () => {},
      });
    },
    beforeCloseTeardown: () => {},
    finalizeClosedSession: () => {},
  });
  function openSession(): FakeSession {
    const session: FakeSession = {
      id: SID,
      closeReason: 'unexpected',
      listeners: new Set(),
      onStatusChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      setInteractionListener: () => {},
    };
    const registration = lifecycle.beginBinding(session);
    if (registration) lifecycle.attachStatusListener(registration);
    return session;
  }
  /** Session.close()：drain 宽限到点自己关(closeReason 没登记 = unexpected)，或交接时按 agent-switch 关。 */
  function closeSession(session: FakeSession, reason: FakeSession['closeReason']) {
    session.closeReason = reason;
    for (const listener of [...session.listeners]) listener('closed');
  }
  let live = openSession();

  // ── 真实的供应商组 service，组内电脑与交接用内存实现 ──
  const probe = vi.fn(async (agentDeviceId: string): Promise<ResolvedMemberState> =>
    agentDeviceId === MAC_B.agentDeviceId && offline.has(MAC_B.key) ? 'offline' : 'ok');
  const directory: ProviderGroupDirectory = {
    async resolveMembers(_providerId, current) {
      return current.members.map((m): ResolvedProviderGroupMember => offline.has(m.key)
        ? { member: m, label: m.key, state: 'offline' }
        : { member: m, label: `${m.key}-name`, state: 'ok', view: view(m.providerId) });
    },
    async listCandidates() { return []; },
    async readDeviceCatalog() { return []; },
    probe,
    memberLabel: (m) => m.label ?? m.key,
    invalidate: vi.fn(),
  };
  const router = createProviderGroupRouter({
    directory,
    readGroup: (id) => (id === 'anthropic' ? config : null),
    listBindings: () => Object.fromEntries(bindings),
    isTurnRunning: () => false,
    now: () => 1_000_000,
    random: () => 0,
  });
  let readRowGate: { opened: Promise<void>; open: () => void } | null = null;
  let probeGate: { opened: Promise<void>; open: () => void } | null = null;
  let writeBindingGate: { opened: Promise<void>; open: () => void } | null = null;
  let held: (() => void) | null = null;
  const leaseResults: Array<object | null> = [];
  const deps = {
    router,
    directory,
    readGroup: (id: string) => (id === 'anthropic' ? config : null),
    readBinding: (id: string) => bindings.get(id) ?? null,
    writeBinding: vi.fn(async (id: string, binding: { providerId: string; memberKey: string } | null) => {
      const pending = writeBindingGate;
      writeBindingGate = null;
      if (pending) await pending.opened;
      if (binding) bindings.set(id, { ...binding, at: 2 });
      else bindings.delete(id);
    }),
    isReleased: () => false,
    markReleased: vi.fn(async () => {}),
    // 「让 B 的终态错误进入处理后暂停一次 readSessionRow」。
    readSessionRow: vi.fn(async () => {
      const pending = readRowGate;
      readRowGate = null;
      if (pending) await pending.opened;
      return { ...row };
    }),
    resolveImplicitProvider: vi.fn(async () => 'anthropic'),
    persistRoute: vi.fn(async () => {}),
    hasAssistantHistory: vi.fn(async () => true),
    isFailoverEligible: vi.fn(async () => true),
    // 与 register.ts 相同的接线。
    leaseRecovery: (sessionId: string, token: number) => {
      const lease = coordinator.leaseUsageLimitRecovery(sessionId, token);
      leaseResults.push(lease);
      return lease;
    },
    isLeaseCurrent: (sessionId: string, lease: object) => coordinator.isUsageLimitRecoveryLeaseCurrent(sessionId, lease),
    rearmContinue: (sessionId: string, lease: object, resumeAt: number | null) =>
      coordinator.rearmUsageLimitWait(sessionId, lease, resumeAt),
    cancelContinue: (sessionId: string, token: number) => {
      coordinator.cancelUsageLimitWait(sessionId, token);
    },
    // 交接：关闭旧会话(agent-switch)、改写任务记录、在新电脑上打开新会话。
    switchAgentLocation: vi.fn(async (_id: string, route: { agentDeviceId: string | null; providerId: string | null }, switchOptions?: { isCurrent?: () => boolean }) => {
      if (switchOptions?.isCurrent && !switchOptions.isCurrent()) throw new Error('superseded');
      closeSession(live, 'agent-switch');
      row.agentDeviceId = route.agentDeviceId;
      row.providerId = route.providerId;
      row.sdkSessionId = null;
      live = openSession();
    }),
    isTurnRunning: vi.fn(() => false),
    hasLiveSession: vi.fn(() => true),
    continueSession: vi.fn(async (sessionId: string, token: number, info: Parameters<ProviderGroupServiceDeps['continueSession']>[2]) =>
      coordinator.continueAfterUsageLimitReset(sessionId, token, info)),
    fallback: vi.fn(),
    readResetAt: vi.fn(() => null),
    now: () => 1_000_000,
    sleep: vi.fn(async () => {
      // 等原电脑恢复的第一次退避之后，B 回来了(短暂断线)。
      if (options.bComesBack) offline.delete(MAC_B.key);
    }),
    log: { info: vi.fn(), warn: vi.fn() },
  } satisfies ProviderGroupServiceDeps;
  const originalProbe = probe.getMockImplementation()!;
  probe.mockImplementation(async (...args) => {
    const pending = probeGate;
    probeGate = null;
    if (pending) await pending.opened;
    return originalProbe(...args);
  });
  service = createProviderGroupService(deps);

  /** 在 B 上开始一轮，B 离线：终态错误进入协调器(随后交给供应商组)。 */
  async function failOnB(failure: { message: string; signals: Record<string, unknown> } = {
    message: B_LOST.message,
    signals: { reason: B_LOST.reason },
  }) {
    coordinator.enqueue(SID, item('q-1', 'long running task'));
    await flush();
    expect(sendToAgent).toHaveBeenCalledTimes(1);
    running = false;
    coordinator.onTurnEvent(SID, 'error', failure.message, failure.signals);
  }

  const markTried = vi.spyOn(router, 'markTried');
  // 「全部停止」的真实 IPC handler；noteSessionReset 按 register 里的原文接线(STOP_ALL_NOTE_SESSION_RESET，
  // 由下面的接线用例逐行核对)，resetAutomaticRecoveryForExplicitStop(撤中断自愈 / silent-stop / 退避簿记，
  // 不碰输入协调器与供应商组)用 spy 代替；closeSession 接 maker.closeSession(requested)。
  const noteSessionReset = vi.fn((_sessionId: string) => {});
  const resetAutomaticRecoveryForExplicitStop = noteSessionReset;
  const providerGroupService: { noteUserAction(sessionId: string): void } | null = service;
  let stopAllHandler: IpcHandler | null = null;
  registerStopSessionBackgroundTasksHandler({ handle: (_channel, handler) => { stopAllHandler = handler; } }, {
    closeSession: async () => closeSession(live, 'requested'),
    clearBackgroundActivity: () => {},
    noteSessionReset: (sessionId) => {
      resetAutomaticRecoveryForExplicitStop(sessionId);
      providerGroupService?.noteUserAction(sessionId);
    },
    notifyGoalStop: () => {},
  });
  return {
    coordinator,
    service,
    router,
    markTried,
    noteSessionReset,
    /** 用户点「全部停止」。 */
    stopAll: () => stopAllHandler!({}, SID),
    deps,
    hooks,
    row,
    bindings,
    sendToAgent,
    leaseResults,
    closeContexts,
    resetAutoResume,
    pauseNextReadSessionRow: () => {
      readRowGate = gate();
      held = readRowGate.open;
    },
    /** 暂停下一次写绑定(换电脑已选好目标、正要交接)。 */
    pauseNextWriteBinding: () => {
      writeBindingGate = gate();
      held = writeBindingGate.open;
    },
    pauseNextProbe: () => {
      probeGate = gate();
      held = probeGate.open;
    },
    /** 只放行暂停的那一步(不等终态错误的处理)。 */
    release() {
      held?.();
      held = null;
    },
    /** 放行暂停的那一步，等这次错误处理走完。 */
    async releaseAndSettle() {
      held?.();
      held = null;
      await flush();
      await turnError;
      await flush();
    },
    failOnB,
    /** 终态错误 drain 宽限到点：Session.close() 自己关掉(没有登记关闭原因)。 */
    drainTimeoutClose: () => closeSession(live, 'unexpected'),
  };
}

function expectSwitchedToLocalAndContinued(h: ReturnType<typeof setup>) {
  expect(h.deps.switchAgentLocation).toHaveBeenCalledTimes(1);
  expect(h.deps.switchAgentLocation.mock.calls[0]?.[1]).toMatchObject({ agentDeviceId: null, providerId: 'anthropic' });
  expect(h.bindings.get(SID)?.memberKey).toBe(LOCAL.key);
  expect(h.row.agentDeviceId).toBeNull();
  expect(h.deps.continueSession).toHaveBeenCalledTimes(1);
  expect(h.sendToAgent).toHaveBeenCalledTimes(2);
  expect(h.sendToAgent.mock.calls[1]?.[1]).toEqual({ type: 'user', content: CONTINUE_AFTER_ERROR_PROMPT });
  expect(h.hooks.resumed).toHaveBeenCalledTimes(1);
  expect(h.deps.fallback).not.toHaveBeenCalled();
}

describe('provider group failover vs. the terminal-error drain close (#5880)', () => {
  it('the drain-timeout close does not preserve the auto-resume intent for this error', async () => {
    const h = setup();
    h.pauseNextReadSessionRow();
    await h.failOnB();
    await flush();
    h.drainTimeoutClose();
    expect(h.closeContexts).toEqual([{ closeReason: 'unexpected', preserveAutoResumeIntent: false }]);
    expect(h.resetAutoResume).toHaveBeenCalledTimes(1);
  });

  it('closes before the lease is taken: still switches to this computer and continues the turn', async () => {
    const h = setup();
    h.pauseNextReadSessionRow();
    await h.failOnB();
    await flush();
    // failover 停在 readSessionRow：此时 drain 宽限到点、会话关闭清理先跑。
    expect(h.deps.readSessionRow).toHaveBeenCalledTimes(1);
    h.drainTimeoutClose();
    // 关闭清理只撤了限额等待候选：这次错误仍是当前状态(仍按换电脑先不呈现)，用户没有接手。
    expect(h.coordinator.getProviderGroupSwitchHoldId(SID)).not.toBeNull();
    await h.releaseAndSettle();
    expect(h.leaseResults[0]).not.toBeNull();
    expectSwitchedToLocalAndContinued(h);
  });

  it('control: lease taken before the close (close lands while waiting for B) also switches and continues', async () => {
    const h = setup();
    h.pauseNextProbe();
    await h.failOnB();
    await flush();
    expect(h.leaseResults).toEqual([expect.any(Object)]);
    h.drainTimeoutClose();
    await h.releaseAndSettle();
    expectSwitchedToLocalAndContinued(h);
  });

  it('a short disconnect still continues on B when the close lands before the lease', async () => {
    const h = setup({ bComesBack: true });
    h.pauseNextReadSessionRow();
    await h.failOnB();
    await flush();
    h.drainTimeoutClose();
    await h.releaseAndSettle();
    expect(h.deps.switchAgentLocation).not.toHaveBeenCalled();
    expect(h.bindings.get(SID)?.memberKey).toBe(MAC_B.key);
    expect(h.deps.continueSession).toHaveBeenCalledTimes(1);
    expect(h.deps.continueSession.mock.calls[0]?.[2]).toMatchObject({ agentReconnect: { computer: MAC_B.key } });
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
  });

  it('does not continue after the user stops during the window, even though the session was closed first', async () => {
    const h = setup();
    h.pauseNextReadSessionRow();
    await h.failOnB();
    await flush();
    h.drainTimeoutClose();
    // 用户按停止(协调器的 Stop 收掉错误与重试入口)。
    h.coordinator.stop(SID);
    await h.releaseAndSettle();
    expect(h.deps.switchAgentLocation).not.toHaveBeenCalled();
    expect(h.deps.continueSession).not.toHaveBeenCalled();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
  });

  it('does not continue the old error once the user sends a new message during the window', async () => {
    const h = setup();
    h.pauseNextReadSessionRow();
    await h.failOnB();
    await flush();
    h.drainTimeoutClose();
    h.coordinator.enqueue(SID, item('q-2', 'something else'));
    h.service.noteUserAction(SID);
    await flush();
    await h.releaseAndSettle();
    expect(h.deps.switchAgentLocation).not.toHaveBeenCalled();
    expect(h.deps.continueSession).not.toHaveBeenCalled();
    // 只有用户自己那条新消息被发出，没有替旧错误续跑。
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).not.toEqual({ type: 'user', content: CONTINUE_AFTER_ERROR_PROMPT });
  });

  // 用户亲自接手发生在取得句柄之后、换电脑开始之前(读组设置、资格检查、读任务记录的 await 期间)：
  // 后续每一步都停下，不冷却、不记为试过、不换电脑(provider-groups.md §6.1)。
  const B_LIMITED = { message: "You've hit your session limit", signals: { sdkError: 'rate_limit' } };
  function expectNothingDoneFor(h: ReturnType<typeof setup>) {
    expect(h.router.coolingUntil('anthropic', MAC_B.key)).toBeNull();
    expect(h.markTried).not.toHaveBeenCalled();
    expect(h.deps.directory.invalidate).not.toHaveBeenCalled();
    expect(h.deps.switchAgentLocation).not.toHaveBeenCalled();
    expect(h.deps.continueSession).not.toHaveBeenCalled();
    expect(h.deps.fallback).not.toHaveBeenCalled();
  }

  it('control: a usage limit on B cools B, marks it tried and switches to this computer', async () => {
    const h = setup();
    await h.failOnB(B_LIMITED);
    await h.releaseAndSettle();
    expect(h.router.coolingUntil('anthropic', MAC_B.key, MODEL)).not.toBeNull();
    expect(h.markTried).toHaveBeenCalledWith(SID, MAC_B.key);
    expectSwitchedToLocalAndContinued(h);
  });

  it('a new message sent while the checks are pending stops before cooling or marking B tried', async () => {
    const h = setup();
    h.pauseNextReadSessionRow();
    await h.failOnB(B_LIMITED);
    await flush();
    // 与 register 发送入口相同：先作废换电脑这一趟，再进队。
    h.service.noteUserAction(SID);
    h.coordinator.enqueue(SID, item('q-2', 'something else'));
    await flush();
    await h.releaseAndSettle();
    expectNothingDoneFor(h);
    expect(h.sendToAgent).toHaveBeenCalledTimes(2);
    expect(h.sendToAgent.mock.calls[1]?.[1]).not.toEqual({ type: 'user', content: CONTINUE_AFTER_ERROR_PROMPT });
  });

  it('changing the model while the checks are pending stops the switch even though the error is still shown', async () => {
    const h = setup();
    h.pauseNextReadSessionRow();
    await h.failOnB(B_LIMITED);
    await flush();
    // 与 register 换模型入口相同：作废换电脑这一趟、撤销额度等待；错误与重试入口仍在(句柄本身还有效)。
    h.service.noteUserAction(SID);
    h.coordinator.cancelUsageLimitWait(SID);
    await h.releaseAndSettle();
    expectNothingDoneFor(h);
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
  });

  // 「全部停止」(stopSessionBackgroundTasksHandler) 只关闭会话、撤自动续跑簿记，不走协调器的 Stop：
  // 换电脑这一趟也必须停下，不换、不续跑、不交回(provider-groups.md §6.1「用户停止」)。
  function expectStoppedByStopAll(h: ReturnType<typeof setup>) {
    expect(h.noteSessionReset).toHaveBeenCalledWith(SID);
    expect(h.closeContexts.at(-1)).toEqual({ closeReason: 'requested', preserveAutoResumeIntent: false });
    expect(h.deps.switchAgentLocation).not.toHaveBeenCalled();
    expect(h.deps.continueSession).not.toHaveBeenCalled();
    expect(h.deps.fallback).not.toHaveBeenCalled();
    expect(h.sendToAgent).toHaveBeenCalledTimes(1);
  }

  it('stop all while the checks are pending stops the switch', async () => {
    const h = setup();
    h.pauseNextReadSessionRow();
    await h.failOnB();
    await flush();
    await h.stopAll();
    await h.releaseAndSettle();
    expectStoppedByStopAll(h);
  });

  it('stop all while waiting for B to come back stops the switch', async () => {
    const h = setup();
    h.pauseNextProbe();
    await h.failOnB();
    await flush();
    expect(h.leaseResults).toEqual([expect.any(Object)]);
    await h.stopAll();
    await h.releaseAndSettle();
    expectStoppedByStopAll(h);
  });

  it('register wires stop all to the provider group without changing the shared explicit-stop reset', () => {
    expect(stopAllNoteSessionResetLines()).toEqual(STOP_ALL_NOTE_SESSION_RESET);
    // 只接在「全部停止」：其他停止入口共用的 resetAutomaticRecoveryForExplicitStop 本身不碰供应商组。
    const start = REGISTER_SOURCE.indexOf('function resetAutomaticRecoveryForExplicitStop(');
    const end = REGISTER_SOURCE.indexOf('\n}\n', start);
    expect(start).toBeGreaterThan(0);
    expect(REGISTER_SOURCE.slice(start, end)).not.toContain('providerGroupService');
  });

  // 发送前换电脑(beforeSend)：已选好目标、正在写绑定 / 交接时用户停止，交接在改动之前停下，任务留在原电脑
  // (provider-groups.md §6.1 发送前：「用户停止这次发送时立刻停下：不再等、不再换」)。
  async function relocateBeforeSend(h: ReturnType<typeof setup>, signal?: AbortSignal) {
    const moving = h.service.beforeSend(SID, signal ? { signal } : undefined);
    await flush();
    return moving;
  }

  it('control: before sending, a task on an offline B moves to this computer', async () => {
    const h = setup();
    await relocateBeforeSend(h);
    expect(h.deps.switchAgentLocation).toHaveBeenCalledTimes(1);
    expect(h.row.agentDeviceId).toBeNull();
    expect(h.bindings.get(SID)?.memberKey).toBe(LOCAL.key);
  });

  it('stop all while the task is being moved before sending keeps it on B', async () => {
    const h = setup();
    h.pauseNextWriteBinding();
    const moving = relocateBeforeSend(h);
    await flush();
    expect(h.deps.writeBinding).toHaveBeenCalledTimes(1);
    await h.stopAll();
    h.release();
    await moving;
    await flush();
    expect(h.row.agentDeviceId).toBe(MAC_B.agentDeviceId);
    expect(h.bindings.get(SID)?.memberKey).toBe(MAC_B.key);
    expect(h.markTried.mock.calls.map(([, key]) => key)).toEqual([MAC_B.key]);
  });

  it('stopping the send while the task is being moved before sending keeps it on B', async () => {
    const h = setup();
    const controller = new AbortController();
    h.pauseNextWriteBinding();
    const moving = relocateBeforeSend(h, controller.signal);
    await flush();
    expect(h.deps.writeBinding).toHaveBeenCalledTimes(1);
    controller.abort();
    h.release();
    await moving;
    await flush();
    expect(h.row.agentDeviceId).toBe(MAC_B.agentDeviceId);
    expect(h.bindings.get(SID)?.memberKey).toBe(MAC_B.key);
  });
});
