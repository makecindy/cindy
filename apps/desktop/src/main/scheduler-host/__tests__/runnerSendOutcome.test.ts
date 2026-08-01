import { describe, expect, it, vi, beforeEach } from 'vitest';

import type {
  AgentEvent,
  Maker,
  Session,
  SessionSendResult,
} from '@cindy/maker-core';
import type {
  FireContext,
  Logger,
  Notifier,
  Schedule,
  ScheduleRun,
} from '@cindy/maker-scheduler';

const mocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
  getSessionRowSnapshot: vi.fn(),
  ensureDialogueWorkspaceDir: vi.fn(),
  wireSessionToIpc: vi.fn(),
  isSessionInTurn: vi.fn(() => false),
  resolveWorkingDir: vi.fn(),
  backfillSessionMeta: vi.fn(),
  schedulerRecoveryHandlers: new Map<
    string,
    Map<
      string,
      {
        handler: (event: AgentEvent) => boolean;
        onReset: (reason: 'session-reset' | 'session-closed' | 'user-intervention') => void;
      }
    >
  >(),
  registerSchedulerRecovery: vi.fn(),
  claimSchedulerRecovery: vi.fn(),
  registerSchedulerResumeOutcome: vi.fn(),
  releaseSchedulerResumeOutcome: vi.fn(),
  discardSchedulerSuppressedError: vi.fn(),
  finalizeSchedulerSuppressedError: vi.fn(),
}));

vi.mock('../../localDb/ipc/messages.js', () => ({
  createMessage: mocks.createMessage,
}));

vi.mock('../../localDb/ipc/sessions.js', () => ({
  getSessionRowSnapshot: mocks.getSessionRowSnapshot,
  touchUserSendInDb: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../localDb/dialogueWorkspace', () => ({
  ensureDialogueWorkspaceDir: mocks.ensureDialogueWorkspaceDir,
}));

vi.mock('../../maker-ipc/register.js', () => ({
  wireSessionToIpc: mocks.wireSessionToIpc,
  isSessionInTurn: mocks.isSessionInTurn,
  noteSilentStopUserSend: vi.fn(),
  onSilentStopSettled: vi.fn(() => () => {}),
}));

vi.mock('../schedulerInterruptedTurnRecoveryBridge.js', () => ({
  registerSchedulerInterruptedTurnRecovery: mocks.registerSchedulerRecovery,
  claimSchedulerInterruptedTurnRecovery: mocks.claimSchedulerRecovery,
  registerSchedulerInterruptedTurnResumeOutcome: mocks.registerSchedulerResumeOutcome,
  releaseSchedulerInterruptedTurnResumeOutcome: mocks.releaseSchedulerResumeOutcome,
  discardSchedulerInterruptedTurnSuppressedError: mocks.discardSchedulerSuppressedError,
  finalizeSchedulerInterruptedTurnSuppressedError: mocks.finalizeSchedulerSuppressedError,
}));

vi.mock('../workdir-resolver', () => ({
  resolveWorkingDir: mocks.resolveWorkingDir,
}));

vi.mock('../runners/_shared', () => ({
  backfillSessionMeta: mocks.backfillSessionMeta,
}));

import { MakerScheduleRunner } from '../runner';
import { isHeadlessGhostSetupTurn } from '../../mcp-integrations/ghostSetupInteractionSurface';
import { CONTINUE_AFTER_ERROR_PROMPT } from '../../../shared/interruptedTurn';

type SessionSendOptions = Parameters<Session['send']>[1];
type SendImpl = (
  message: Parameters<Session['send']>[0],
  opts?: SessionSendOptions,
) => Promise<SessionSendResult>;

interface FakeSessionHarness {
  session: Session;
  send: ReturnType<typeof vi.fn<SendImpl>>;
  off: ReturnType<typeof vi.fn>;
  emit(event: AgentEvent): void;
  listenerCount(): number;
}

function createSessionHarness(sendImpl: SendImpl): FakeSessionHarness {
  const listeners: Array<(event: AgentEvent) => void> = [];
  const off = vi.fn();
  const send = vi.fn<SendImpl>(sendImpl);
  const session = {
    id: 'scheduler-session',
    agentKind: 'codex',
    send,
    onEvent(listener: (event: AgentEvent) => void) {
      listeners.push(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
        off();
      };
    },
    abort: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as Session;

  return {
    session,
    send,
    off,
    emit(event: AgentEvent) {
      // Production wireSessionToIpc subscribes before the runner waiter and gives Schedule
      // recovery first refusal over a terminal error. Mirror that ordering here even though
      // register.ts is intentionally mocked as a narrow dependency in this unit suite.
      if (event.type === 'error') {
        mocks.claimSchedulerRecovery('scheduler-session', event);
      }
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount() {
      return listeners.length;
    },
  };
}

function createLogger(): Logger & {
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
}

function baseSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    name: 'review-pr unattended run',
    prompt: 'PROMPT_SECRET full user message TOKEN_VALUE file body',
    jobType: 'prompt',
    source: 'user',
    kind: 'cron',
    cronExpr: '0 9 * * *',
    timezone: 'Asia/Hong_Kong',
    recurring: true,
    manual: false,
    agentKind: 'codex',
    workspaceKind: 'project',
    workingDir: 'F:\\XDMaker',
    useWorktree: false,
    notify: { desktop: true, feishu: false },
    status: 'active',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function createFireContext(runId = 'run-1'): FireContext & {
  controller: AbortController;
  removeAbortListener: ReturnType<typeof vi.spyOn>;
} {
  const abortController = new AbortController();
  const removeAbortListener = vi.spyOn(abortController.signal, 'removeEventListener');
  return {
    runId,
    firedAt: 1_700_000_000_100,
    signal: abortController.signal,
    controller: abortController,
    onSessionBound: vi.fn(async () => undefined),
    removeAbortListener,
  };
}

function createRunnerHarness(
  session: Session,
  depsOverrides: Partial<ConstructorParameters<typeof MakerScheduleRunner>[0]> = {},
) {
  const logger = createLogger();
  const notifier: Notifier & { notify: ReturnType<typeof vi.fn> } = {
    notify: vi.fn(async () => undefined),
  };
  const maker = {
    createSession: vi.fn(async () => session),
    getSessionMeta: vi.fn(async () => null),
    isSessionAlive: vi.fn(() => false),
    closeSession: vi.fn(async () => undefined),
  } as unknown as Maker;
  const runner = new MakerScheduleRunner({
    maker,
    getDb: () => ({}) as never,
    notifier,
    logger,
    ...depsOverrides,
  });
  return { runner, logger, notifier, maker };
}

async function settleWithin<T>(
  promise: Promise<T>,
  ms = 50,
): Promise<
  | { status: 'resolved'; value: T }
  | { status: 'rejected'; error: unknown }
  | { status: 'timeout' }
> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ status: 'timeout' }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ status: 'timeout' }), ms);
  });
  const result = await Promise.race([
    promise.then(
      (value) => ({ status: 'resolved' as const, value }),
      (error) => ({ status: 'rejected' as const, error }),
    ),
    timeout,
  ]);
  if (timeoutId) clearTimeout(timeoutId);
  return result;
}

function latestNotifiedRun(notifier: Notifier & { notify: ReturnType<typeof vi.fn> }): ScheduleRun {
  return notifier.notify.mock.calls.at(-1)?.[1] as ScheduleRun;
}

function expectSafeSendFailureLog(
  logger: ReturnType<typeof createLogger>,
  expected: {
    source: string;
    reason: string;
    action?: string;
  },
): void {
  expect(logger.warn).toHaveBeenCalledWith(
    '[runner] session send failed before dispatch',
    expect.objectContaining({
      kind: 'session-dispatch',
      source: expected.source,
      owner: 'scheduler-host',
      entrypoint: 'scheduler-host.runner.fire',
      sessionId: 'scheduler-session',
      action: expected.action ?? 'send-user-prompt',
      reason: expected.reason,
      context: expect.stringContaining('scheduler-host.runner.fire'),
    }),
  );
  const loggedPayload = JSON.stringify(logger.warn.mock.calls);
  expect(loggedPayload).not.toContain('PROMPT_SECRET');
  expect(loggedPayload).not.toContain('full user message');
  expect(loggedPayload).not.toContain('TOKEN_VALUE');
  expect(loggedPayload).not.toContain('file body');
}

describe('MakerScheduleRunner send outcome policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.schedulerRecoveryHandlers.clear();
    mocks.registerSchedulerRecovery.mockImplementation(
      (
        sessionId: string,
        runId: string,
        handler: (event: AgentEvent) => boolean,
        onReset: (reason: 'session-reset' | 'session-closed' | 'user-intervention') => void,
      ) => {
        let registrations = mocks.schedulerRecoveryHandlers.get(sessionId);
        if (!registrations) {
          registrations = new Map();
          mocks.schedulerRecoveryHandlers.set(sessionId, registrations);
        }
        const registration = { handler, onReset };
        registrations.set(runId, registration);
        return () => {
          const current = mocks.schedulerRecoveryHandlers.get(sessionId);
          if (current?.get(runId) !== registration) return;
          current.delete(runId);
          if (current.size === 0) mocks.schedulerRecoveryHandlers.delete(sessionId);
        };
      },
    );
    mocks.claimSchedulerRecovery.mockImplementation((sessionId: string, event: AgentEvent) => {
      const registrations = mocks.schedulerRecoveryHandlers.get(sessionId);
      if (!registrations) return false;
      const eventRunId = event.turnOrigin?.runId;
      if (eventRunId) return registrations.get(eventRunId)?.handler(event) ?? false;
      if (registrations.size !== 1) return false;
      return registrations.values().next().value?.handler(event) ?? false;
    });
    mocks.createMessage.mockResolvedValue(undefined);
    mocks.backfillSessionMeta.mockResolvedValue(undefined);
    mocks.resolveWorkingDir.mockResolvedValue({ ok: true, path: 'F:\\XDMaker' });
    mocks.isSessionInTurn.mockReturnValue(false);
    mocks.getSessionRowSnapshot.mockResolvedValue({
      status: 'active',
    });
  });

  it('marks accepted:false scheduler runs failed without waiting for terminal events; review-pr inherits this runner policy', async () => {
    const h = createSessionHarness(async () => ({
      accepted: false,
      reason: 'cancelled-before-dispatch',
    }));
    const { runner, logger, notifier } = createRunnerHarness(h.session);
    const ctx = createFireContext();
    const firePromise = runner.fire(baseSchedule(), ctx);

    const settled = await settleWithin(firePromise);

    expect(settled.status).toBe('rejected');
    const run = latestNotifiedRun(notifier);
    expect(run.status).toBe('failed');
    expect(run.status).not.toBe('skipped');
    expect(run.errorMsg).toContain('cancelled-before-dispatch');
    expectSafeSendFailureLog(logger, {
      source: 'scheduler-runner',
      reason: 'cancelled-before-dispatch',
    });
    expect(h.off).toHaveBeenCalledTimes(1);
    expect(ctx.removeAbortListener).toHaveBeenCalledTimes(2);
    expect(h.session.close).not.toHaveBeenCalled();
  });

  it('treats a cancelled send result as an abort when the fire is cancelled', async () => {
    const ctx = createFireContext();
    const h = createSessionHarness(async () => {
      ctx.controller.abort();
      return { accepted: false, reason: 'cancelled-before-dispatch' };
    });
    const { runner, notifier } = createRunnerHarness(h.session);

    await expect(runner.fire(baseSchedule(), ctx)).rejects.toThrow(/schedule fire aborted/);
    expect(notifier.notify).not.toHaveBeenCalled();
    expect(h.off).toHaveBeenCalledTimes(1);
    expect(ctx.removeAbortListener).toHaveBeenCalledTimes(2);
  });

  it('closes an accepted ephemeral turn before propagating an abort', async () => {
    const ctx = createFireContext();
    const h = createSessionHarness(async (_message, opts) => {
      await opts?.onAccepted?.();
      ctx.controller.abort();
      throw new Error('send interrupted by abort');
    });
    const { runner, maker, notifier } = createRunnerHarness(h.session);

    await expect(runner.fire(baseSchedule(), ctx)).rejects.toThrow(/send interrupted by abort/);
    expect(maker.closeSession).toHaveBeenCalledTimes(1);
    expect(maker.closeSession).toHaveBeenCalledWith('scheduler-session');
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('applies a deferred switch before heartbeat meta lookup and creates the target engine session', async () => {
    const order: string[] = [];
    const h = createSessionHarness(async () => {
      order.push('send');
      return {
        accepted: false,
        reason: 'cancelled-before-dispatch',
      };
    });
    const releaseAgentSwitchLock = vi.fn(() => {
      order.push('release');
    });
    const acquirePendingAgentSwitch = vi.fn(async () => {
      order.push('apply');
      return releaseAgentSwitchLock;
    });
    const { runner, maker } = createRunnerHarness(h.session, { acquirePendingAgentSwitch });
    vi.mocked(maker.getSessionMeta).mockImplementation(async () => {
      order.push('meta');
      return {
        id: 'scheduler-session',
        agentKind: 'codex',
        workDir: 'F:\\XDMaker',
        model: 'gpt-5.5-codex',
        effort: 'high',
        permissionMode: 'bypassPermissions',
        fastMode: true,
      } as never;
    });
    mocks.getSessionRowSnapshot.mockResolvedValue({
      status: 'active',
      userSendAt: null,
      providerId: null,
    });
    const ctx = createFireContext();

    await expect(
      runner.fire(
        baseSchedule({
          targetSessionId: 'scheduler-session',
          agentKind: 'claude-code',
          model: undefined,
        }),
        ctx,
      ),
    ).rejects.toThrow(/cancelled-before-dispatch/);

    expect(order.slice(0, 2)).toEqual(['apply', 'meta']);
    expect(acquirePendingAgentSwitch).toHaveBeenCalledWith('scheduler-session', ctx.signal);
    expect(maker.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'scheduler-session',
        agentKind: 'codex',
        model: 'gpt-5.5-codex',
      }),
    );
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['apply', 'meta', 'send', 'release']);
  });

  it('releases the heartbeat route lock before deferring to recent user activity', async () => {
    const order: string[] = [];
    const h = createSessionHarness(async () => ({ accepted: true }));
    const releaseAgentSwitchLock = vi.fn(() => {
      order.push('release');
    });
    const acquirePendingAgentSwitch = vi.fn(async () => releaseAgentSwitchLock);
    const { runner, maker } = createRunnerHarness(h.session, { acquirePendingAgentSwitch });
    vi.mocked(maker.getSessionMeta).mockResolvedValue({
      id: 'scheduler-session',
      agentKind: 'codex',
      workDir: 'F:\\XDMaker',
      model: 'gpt-5.5-codex',
      effort: 'high',
      permissionMode: 'bypassPermissions',
      fastMode: false,
    } as never);
    mocks.getSessionRowSnapshot.mockResolvedValue({
      status: 'active',
      userSendAt: Date.now(),
      providerId: null,
    });
    mocks.isSessionInTurn.mockReturnValue(true);

    const result = await runner.fire(
      baseSchedule({ targetSessionId: 'scheduler-session' }),
      createFireContext(),
    );

    expect(result).toMatchObject({
      sessionId: 'scheduler-session',
      deferred: true,
    });
    expect(order).toEqual(['release']);
    expect(releaseAgentSwitchLock).toHaveBeenCalledTimes(1);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('releases the heartbeat route lock before reporting an archived target', async () => {
    const order: string[] = [];
    const h = createSessionHarness(async () => ({ accepted: true }));
    const releaseAgentSwitchLock = vi.fn(() => {
      order.push('release');
    });
    const acquirePendingAgentSwitch = vi.fn(async () => releaseAgentSwitchLock);
    const { runner, notifier } = createRunnerHarness(h.session, { acquirePendingAgentSwitch });
    notifier.notify.mockImplementation(async () => {
      order.push('notify');
    });
    mocks.getSessionRowSnapshot.mockResolvedValue({
      status: 'archived',
      userSendAt: null,
      providerId: null,
    });

    await expect(
      runner.fire(
        baseSchedule({ targetSessionId: 'scheduler-session' }),
        createFireContext(),
      ),
    ).rejects.toThrow(/target session not available/);

    expect(order).toEqual(['release', 'notify']);
    expect(releaseAgentSwitchLock).toHaveBeenCalledTimes(1);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('captures the scheduler git baseline after the user row exists and aborts it when send is rejected', async () => {
    const order: string[] = [];
    let releaseBaseline: (() => void) | undefined;
    mocks.createMessage.mockImplementation(async () => {
      order.push('persist');
    });
    const beforeDispatchUserTurn = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseBaseline = () => {
            order.push('baseline');
            resolve();
          };
        }),
    );
    const onUndispatchedUserTurn = vi.fn(() => {
      order.push('abort');
    });
    const h = createSessionHarness(async (_message, opts) => {
      order.push('send');
      await opts?.onAccepted?.();
      order.push('after-accepted');
      return {
        accepted: false,
        reason: 'cancelled-before-dispatch',
      };
    });
    const { runner } = createRunnerHarness(h.session, {
      beforeDispatchUserTurn,
      onUndispatchedUserTurn,
    });
    const ctx = createFireContext();

    const firePromise = runner.fire(baseSchedule(), ctx);

    await vi.waitFor(() => expect(h.send).toHaveBeenCalled());
    await vi.waitFor(() => expect(beforeDispatchUserTurn).toHaveBeenCalledWith('scheduler-session'));
    expect(order).toEqual(['send', 'persist']);

    releaseBaseline?.();
    const settled = await settleWithin(firePromise);

    expect(settled.status).toBe('rejected');
    expect(order).toEqual(['send', 'persist', 'baseline', 'after-accepted', 'abort']);
    expect(onUndispatchedUserTurn).toHaveBeenCalledWith('scheduler-session');
  });

  it('marks thrown send errors failed without waiting for terminal events and logs sanitized metadata', async () => {
    const sendError = new Error('PROMPT_SECRET full user message TOKEN_VALUE file body');
    const h = createSessionHarness(async (_message, opts) => {
      await opts?.onAccepted?.();
      throw sendError;
    });
    const { runner, logger, notifier } = createRunnerHarness(h.session);
    const ctx = createFireContext();

    const settled = await settleWithin(runner.fire(baseSchedule(), ctx));

    expect(settled.status).toBe('rejected');
    const run = latestNotifiedRun(notifier);
    expect(run.status).toBe('failed');
    expect(run.errorMsg).not.toContain('PROMPT_SECRET');
    expectSafeSendFailureLog(logger, {
      source: 'session.send',
      reason: 'Error',
    });
    expect(h.off).toHaveBeenCalledTimes(1);
    expect(ctx.removeAbortListener).toHaveBeenCalledTimes(2);
  });

  it('marks onAccepted rejection failed without waiting for terminal events and records the source', async () => {
    mocks.createMessage.mockRejectedValue(
      new Error('PROMPT_SECRET full user message TOKEN_VALUE file body'),
    );
    const h = createSessionHarness(async (_message, opts) => {
      await opts?.onAccepted?.();
      return { accepted: true };
    });
    const { runner, logger, notifier } = createRunnerHarness(h.session);
    const ctx = createFireContext();

    const settled = await settleWithin(runner.fire(baseSchedule(), ctx));

    expect(settled.status).toBe('rejected');
    const run = latestNotifiedRun(notifier);
    expect(run.status).toBe('failed');
    expect(run.errorMsg).toContain('onAccepted');
    expect(run.errorMsg).not.toContain('PROMPT_SECRET');
    expectSafeSendFailureLog(logger, {
      source: 'onAccepted',
      reason: 'onAccepted-rejected',
    });
    expect(h.off).toHaveBeenCalledTimes(1);
    expect(ctx.removeAbortListener).toHaveBeenCalledTimes(2);
  });

  it('marks SESSION_RUNNING failed without waiting for terminal events and records the reason', async () => {
    const err = new Error('SESSION_RUNNING: existing turn') as Error & { code?: string };
    err.code = 'SESSION_RUNNING';
    const h = createSessionHarness(async () => {
      throw err;
    });
    const { runner, logger, notifier } = createRunnerHarness(h.session);
    const ctx = createFireContext();

    const settled = await settleWithin(runner.fire(baseSchedule(), ctx));

    expect(settled.status).toBe('rejected');
    const run = latestNotifiedRun(notifier);
    expect(run.status).toBe('failed');
    expect(run.errorMsg).toContain('SESSION_RUNNING');
    expectSafeSendFailureLog(logger, {
      source: 'session-state',
      reason: 'SESSION_RUNNING',
    });
    expect(h.off).toHaveBeenCalledTimes(1);
    expect(ctx.removeAbortListener).toHaveBeenCalledTimes(2);
  });

  it('waits for the terminal event when send is accepted', async () => {
    const h = createSessionHarness(async (_message, opts) => {
      await opts?.onAccepted?.();
      return { accepted: true };
    });
    const { runner, notifier } = createRunnerHarness(h.session);
    const ctx = createFireContext();
    const firePromise = runner.fire(baseSchedule(), ctx);

    expect(await settleWithin(firePromise, 25)).toEqual({ status: 'timeout' });
    expect(notifier.notify).not.toHaveBeenCalled();
    expect(h.listenerCount()).toBe(1);

    h.emit({ type: 'text', data: { text: 'done text', isFinal: true } });
    h.emit({ type: 'done', data: {} });

    await expect(firePromise).resolves.toEqual({
      sessionId: 'scheduler-session',
      resultText: 'done text',
    });
    const run = latestNotifiedRun(notifier);
    expect(run.status).toBe('success');
    expect(run.resultText).toBe('done text');
    expect(ctx.removeAbortListener).toHaveBeenCalledTimes(2);
  });

  it('continues a partially completed capacity-interrupted turn in the same schedule run', async () => {
    vi.useFakeTimers();
    const rawInterruptedError =
      'Selected model is at capacity. Please try a different model. Authorization: Bearer capacity-secret-123';
    const h = createSessionHarness(async (_message, opts) => {
      await opts?.onAccepted?.();
      return { accepted: true };
    });
    const beforeDispatchUserTurn = vi.fn(async () => undefined);
    const { runner, notifier } = createRunnerHarness(h.session, { beforeDispatchUserTurn });
    const schedule = baseSchedule();
    const ctx = createFireContext();
    const firePromise = runner.fire(schedule, ctx);

    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    h.emit({ type: 'status', data: { isRunning: true } });
    h.emit({ type: 'text', data: { text: 'partial output', isFinal: false } });
    h.emit({
      type: 'error',
      data: {
        message: rawInterruptedError,
        reason: 'upstream-overload',
        isTerminal: true,
      },
    });
    // Some SDK paths pair the terminal error with the old turn's done. It must not close
    // the Schedule run while the continuation is in backoff.
    h.emit({ type: 'done', data: {} });

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(notifier.notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));

    expect(h.send.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ content: expect.stringContaining(schedule.prompt) }),
    );
    expect(h.send.mock.calls[1]?.[0]).toEqual({
      type: 'user',
      content: CONTINUE_AFTER_ERROR_PROMPT,
    });
    expect(h.send.mock.calls[1]?.[0]).not.toEqual(h.send.mock.calls[0]?.[0]);
    expect(h.send.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        origin: {
          kind: 'scheduler',
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          runId: ctx.runId,
        },
      }),
    );
    expect(mocks.createMessage).toHaveBeenNthCalledWith(
      2,
      'scheduler-session',
      expect.objectContaining({
        role: 'user',
        content: CONTINUE_AFTER_ERROR_PROMPT,
        agentMeta: expect.objectContaining({
          delivery: 'turn',
          autoResume: true,
          autoResumeInfo: expect.objectContaining({
            error: 'Selected model is at capacity. Please try a different model. Authorization: [REDACTED]',
            attempt: 1,
            maxAttempts: 5,
            sessionTotal: 1,
          }),
        }),
      }),
    );
    expect(JSON.stringify(mocks.createMessage.mock.calls[1])).not.toContain('capacity-secret-123');
    expect(beforeDispatchUserTurn).toHaveBeenCalledTimes(2);
    await vi.waitFor(() =>
      expect(mocks.discardSchedulerSuppressedError).toHaveBeenCalledWith('scheduler-session'),
    );

    // Some providers do not emit a running status for the continuation. A confirmed dispatch
    // owns the lifecycle transition, so its terminal event must still settle this Schedule run.
    h.emit({ type: 'text', data: { text: 'completed after recovery', isFinal: true } });
    h.emit({ type: 'done', data: {} });

    await expect(firePromise).resolves.toEqual({
      sessionId: 'scheduler-session',
      resultText: 'completed after recovery',
    });
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(latestNotifiedRun(notifier)).toEqual(
      expect.objectContaining({ status: 'success', resultText: 'completed after recovery' }),
    );
  });

  it('keeps retrying an established recovery chain when the resumed turn has no new output', async () => {
    vi.useFakeTimers();
    const h = createSessionHarness(async (_message, opts) => {
      await opts?.onAccepted?.();
      return { accepted: true };
    });
    const { runner } = createRunnerHarness(h.session);
    const firePromise = runner.fire(baseSchedule(), createFireContext());

    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    h.emit({ type: 'status', data: { isRunning: true } });
    h.emit({ type: 'text', data: { text: 'partial output', isFinal: false } });
    h.emit({
      type: 'error',
      data: {
        message: 'Selected model is at capacity. Please try a different model.',
        isTerminal: true,
      },
    });

    await vi.advanceTimersByTimeAsync(4_000);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));

    // The first continuation reached the provider but failed before text/tool_use. The recovery
    // chain, rather than per-turn output, now owns eligibility for the bounded second attempt.
    h.emit({
      type: 'error',
      data: {
        message: 'Selected model is at capacity. Please try a different model.',
        isTerminal: true,
      },
    });
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(3));
    expect(mocks.createMessage).toHaveBeenNthCalledWith(
      3,
      'scheduler-session',
      expect.objectContaining({
        agentMeta: expect.objectContaining({
          autoResumeInfo: expect.objectContaining({ attempt: 2, maxAttempts: 5 }),
        }),
      }),
    );

    h.emit({ type: 'text', data: { text: 'recovered', isFinal: true } });
    h.emit({ type: 'done', data: {} });
    await expect(firePromise).resolves.toEqual({
      sessionId: 'scheduler-session',
      resultText: 'recovered',
    });
  });

  it('settles recovery bookkeeping when running status arrives before send resolves', async () => {
    vi.useFakeTimers();
    let sendCount = 0;
    let releaseResumeSend!: () => void;
    const resumeSendGate = new Promise<void>((resolve) => {
      releaseResumeSend = resolve;
    });
    const h = createSessionHarness(async (_message, opts) => {
      sendCount += 1;
      await opts?.onAccepted?.();
      if (sendCount > 1) await resumeSendGate;
      return { accepted: true };
    });
    const { runner } = createRunnerHarness(h.session);
    const firePromise = runner.fire(baseSchedule(), createFireContext());

    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    h.emit({ type: 'status', data: { isRunning: true } });
    h.emit({ type: 'text', data: { text: 'partial output', isFinal: false } });
    h.emit({
      type: 'error',
      data: {
        message: 'Selected model is at capacity. Please try a different model.',
        isTerminal: true,
      },
    });
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.waitFor(() => expect(mocks.createMessage).toHaveBeenCalledTimes(2));

    h.emit({ type: 'status', data: { isRunning: true } });
    releaseResumeSend();
    await vi.waitFor(() =>
      expect(mocks.discardSchedulerSuppressedError).toHaveBeenCalledWith('scheduler-session'),
    );

    h.emit({ type: 'text', data: { text: 'completed', isFinal: true } });
    h.emit({ type: 'done', data: {} });
    await expect(firePromise).resolves.toEqual({
      sessionId: 'scheduler-session',
      resultText: 'completed',
    });
  });

  it('keeps concurrent waiters isolated by Schedule run id', async () => {
    vi.useFakeTimers();
    const h = createSessionHarness(async (_message, opts) => {
      await opts?.onAccepted?.();
      return { accepted: true };
    });
    const { runner, notifier } = createRunnerHarness(h.session);
    const firstFire = runner.fire(baseSchedule(), createFireContext('run-first'));
    const secondFire = runner.fire(baseSchedule(), createFireContext('run-second'));

    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    const firstOrigin = {
      kind: 'scheduler',
      scheduleId: 'schedule-1',
      scheduleName: 'review-pr unattended run',
      runId: 'run-first',
    } as const;
    h.emit({ type: 'status', data: { isRunning: true }, turnOrigin: firstOrigin });
    h.emit({
      type: 'text',
      data: { text: 'first partial', isFinal: false },
      turnOrigin: firstOrigin,
    });
    h.emit({
      type: 'error',
      data: {
        message: 'Selected model is at capacity. Please try a different model.',
        isTerminal: true,
      },
      turnOrigin: firstOrigin,
    });
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(3));
    expect(h.send.mock.calls[2]?.[1]?.origin).toEqual(firstOrigin);
    await vi.waitFor(() => expect(mocks.discardSchedulerSuppressedError).toHaveBeenCalledTimes(1));

    h.emit({ type: 'done', data: {}, turnOrigin: firstOrigin });
    await expect(firstFire).resolves.toEqual({
      sessionId: 'scheduler-session',
      resultText: 'first partial',
    });
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(h.listenerCount()).toBe(1);

    const secondOrigin = { ...firstOrigin, runId: 'run-second' } as const;
    h.emit({ type: 'done', data: {}, turnOrigin: secondOrigin });
    await expect(secondFire).resolves.toEqual({
      sessionId: 'scheduler-session',
      resultText: undefined,
    });
    expect(notifier.notify).toHaveBeenCalledTimes(2);
  });

  it('does not continue a capacity error when the turn produced no output', async () => {
    const h = createSessionHarness(async (_message, opts) => {
      await opts?.onAccepted?.();
      return { accepted: true };
    });
    const { runner, notifier } = createRunnerHarness(h.session);
    const firePromise = runner.fire(baseSchedule(), createFireContext());

    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    h.emit({ type: 'status', data: { isRunning: true } });
    h.emit({
      type: 'error',
      data: {
        message: 'Selected model is at capacity. Please try a different model.',
        reason: 'upstream-overload',
        isTerminal: true,
      },
    });

    await expect(firePromise).rejects.toThrow(/capacity/);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(latestNotifiedRun(notifier)).toEqual(expect.objectContaining({ status: 'failed' }));
  });

  it('does not continue deterministic errors after partial output', async () => {
    const h = createSessionHarness(async (_message, opts) => {
      await opts?.onAccepted?.();
      return { accepted: true };
    });
    const { runner, notifier } = createRunnerHarness(h.session);
    const firePromise = runner.fire(baseSchedule(), createFireContext());

    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    h.emit({ type: 'status', data: { isRunning: true } });
    h.emit({ type: 'text', data: { text: 'partial output', isFinal: false } });
    h.emit({
      type: 'error',
      data: {
        message: 'invalid api key',
        sdkError: 'authentication_failed',
        isTerminal: true,
      },
    });

    await expect(firePromise).rejects.toThrow(/invalid api key/);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(latestNotifiedRun(notifier)).toEqual(expect.objectContaining({ status: 'failed' }));
  });

  it('cancels a pending interrupted-turn continuation when the Schedule run is aborted', async () => {
    vi.useFakeTimers();
    const h = createSessionHarness(async (_message, opts) => {
      await opts?.onAccepted?.();
      return { accepted: true };
    });
    const { runner, notifier } = createRunnerHarness(h.session);
    const ctx = createFireContext();
    const firePromise = runner.fire(baseSchedule(), ctx);

    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    h.emit({ type: 'status', data: { isRunning: true } });
    h.emit({ type: 'text', data: { text: 'partial output', isFinal: false } });
    h.emit({
      type: 'error',
      data: {
        message: 'Selected model is at capacity. Please try a different model.',
        reason: 'upstream-overload',
        isTerminal: true,
      },
    });
    ctx.controller.abort();

    await expect(firePromise).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeSchedulerSuppressedError).toHaveBeenCalledWith('scheduler-session');
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(latestNotifiedRun(notifier)).toEqual(expect.objectContaining({ status: 'failed' }));
  });

  it('cancels a pending continuation when a real user message supersedes the backoff', async () => {
    vi.useFakeTimers();
    const h = createSessionHarness(async (_message, opts) => {
      await opts?.onAccepted?.();
      return { accepted: true };
    });
    const { runner } = createRunnerHarness(h.session);
    const firePromise = runner.fire(baseSchedule(), createFireContext());

    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    h.emit({ type: 'status', data: { isRunning: true } });
    h.emit({ type: 'text', data: { text: 'partial output', isFinal: false } });
    h.emit({
      type: 'error',
      data: {
        message: 'Selected model is at capacity. Please try a different model.',
        isTerminal: true,
      },
    });

    mocks.schedulerRecoveryHandlers
      .get('scheduler-session')
      ?.values()
      .next().value?.onReset('user-intervention');
    await expect(firePromise).rejects.toThrow(/superseded by user input/);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeSchedulerSuppressedError).toHaveBeenCalledWith('scheduler-session');
  });

  it('ignores a late successful send outcome after the session reset settles the waiter', async () => {
    vi.useFakeTimers();
    let sendCount = 0;
    let releaseResumeSend!: (result: SessionSendResult) => void;
    const resumeSendGate = new Promise<SessionSendResult>((resolve) => {
      releaseResumeSend = resolve;
    });
    let markResumeSendSettled!: () => void;
    const resumeSendSettled = new Promise<void>((resolve) => {
      markResumeSendSettled = resolve;
    });
    const h = createSessionHarness(async (_message, opts) => {
      sendCount += 1;
      await opts?.onAccepted?.();
      if (sendCount === 1) return { accepted: true };
      try {
        return await resumeSendGate;
      } finally {
        markResumeSendSettled();
      }
    });
    const { runner } = createRunnerHarness(h.session);
    const firePromise = runner.fire(baseSchedule(), createFireContext());

    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    h.emit({ type: 'status', data: { isRunning: true } });
    h.emit({ type: 'text', data: { text: 'partial output', isFinal: false } });
    h.emit({
      type: 'error',
      data: {
        message: 'Selected model is at capacity. Please try a different model.',
        isTerminal: true,
      },
    });
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.waitFor(() => expect(mocks.createMessage).toHaveBeenCalledTimes(2));

    mocks.schedulerRecoveryHandlers.get('scheduler-session')?.values().next().value?.onReset('session-reset');
    await expect(firePromise).rejects.toThrow(/session reset/);
    releaseResumeSend({ accepted: true });
    await resumeSendSettled;

    expect(mocks.finalizeSchedulerSuppressedError).toHaveBeenCalledWith('scheduler-session');
    expect(mocks.discardSchedulerSuppressedError).not.toHaveBeenCalled();
  });

  it('blocks a late accepted callback after reset before it can persist a continuation', async () => {
    vi.useFakeTimers();
    let sendCount = 0;
    let allowResumeAccepted!: () => void;
    const resumeAcceptedGate = new Promise<void>((resolve) => {
      allowResumeAccepted = resolve;
    });
    let markResumeSendSettled!: () => void;
    const resumeSendSettled = new Promise<void>((resolve) => {
      markResumeSendSettled = resolve;
    });
    const h = createSessionHarness(async (_message, opts) => {
      sendCount += 1;
      try {
        if (sendCount > 1) await resumeAcceptedGate;
        await opts?.onAccepted?.();
        return { accepted: true };
      } finally {
        if (sendCount > 1) markResumeSendSettled();
      }
    });
    const { runner } = createRunnerHarness(h.session);
    const firePromise = runner.fire(baseSchedule(), createFireContext());

    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    h.emit({ type: 'status', data: { isRunning: true } });
    h.emit({ type: 'text', data: { text: 'partial output', isFinal: false } });
    h.emit({
      type: 'error',
      data: {
        message: 'Selected model is at capacity. Please try a different model.',
        isTerminal: true,
      },
    });
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));

    mocks.schedulerRecoveryHandlers.get('scheduler-session')?.values().next().value?.onReset('session-reset');
    await expect(firePromise).rejects.toThrow(/session reset/);
    allowResumeAccepted();
    await resumeSendSettled;

    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    expect(mocks.discardSchedulerSuppressedError).not.toHaveBeenCalled();
  });

  it('finalizes a continuation row whose persistence completes after reset', async () => {
    vi.useFakeTimers();
    let releaseResumePersist!: () => void;
    const resumePersistGate = new Promise<void>((resolve) => {
      releaseResumePersist = resolve;
    });
    mocks.createMessage.mockImplementation(async () => {
      if (mocks.createMessage.mock.calls.length === 2) await resumePersistGate;
    });
    const h = createSessionHarness(async (_message, opts) => {
      await opts?.onAccepted?.();
      return { accepted: true };
    });
    const { runner } = createRunnerHarness(h.session);
    const firePromise = runner.fire(baseSchedule(), createFireContext());

    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    h.emit({ type: 'status', data: { isRunning: true } });
    h.emit({ type: 'text', data: { text: 'partial output', isFinal: false } });
    h.emit({
      type: 'error',
      data: {
        message: 'Selected model is at capacity. Please try a different model.',
        isTerminal: true,
      },
    });
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.waitFor(() => expect(mocks.createMessage).toHaveBeenCalledTimes(2));

    mocks.schedulerRecoveryHandlers.get('scheduler-session')?.values().next().value?.onReset('session-reset');
    await expect(firePromise).rejects.toThrow(/session reset/);
    releaseResumePersist();
    await vi.waitFor(() => expect(mocks.registerSchedulerResumeOutcome).toHaveBeenCalledTimes(2));

    expect(mocks.finalizeSchedulerSuppressedError).toHaveBeenCalledTimes(2);
    expect(mocks.discardSchedulerSuppressedError).not.toHaveBeenCalled();
  });

  it('marks a direct scheduler turn headless only after acceptance and releases it at terminal', async () => {
    let releaseSend!: (result: SessionSendResult) => void;
    let onAccepted: NonNullable<SessionSendOptions>['onAccepted'];
    const sendGate = new Promise<SessionSendResult>((resolve) => {
      releaseSend = resolve;
    });
    const h = createSessionHarness(async (_message, opts) => {
      onAccepted = opts?.onAccepted;
      return sendGate;
    });
    const { runner } = createRunnerHarness(h.session);
    const firePromise = runner.fire(baseSchedule(), createFireContext());

    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    expect(isHeadlessGhostSetupTurn('scheduler-session')).toBe(false);

    await onAccepted?.();
    expect(isHeadlessGhostSetupTurn('scheduler-session')).toBe(true);
    releaseSend({ accepted: true });
    await vi.waitFor(() => expect(h.listenerCount()).toBe(1));

    h.emit({ type: 'done', data: {} });
    await expect(firePromise).resolves.toEqual({
      sessionId: 'scheduler-session',
      resultText: undefined,
    });
    expect(isHeadlessGhostSetupTurn('scheduler-session')).toBe(false);
  });

  it('broadcasts a newly accepted schedule session after its user row is durable', async () => {
    const order: string[] = [];
    mocks.createMessage.mockImplementation(async () => {
      order.push('persist');
    });
    const onSessionCreated = vi.fn(() => {
      order.push('broadcast');
    });
    const h = createSessionHarness(async (_message, opts) => {
      await opts?.onAccepted?.();
      return { accepted: true };
    });
    const { runner } = createRunnerHarness(h.session, { onSessionCreated });
    const firePromise = runner.fire(baseSchedule(), createFireContext());

    await vi.waitFor(() => expect(onSessionCreated).toHaveBeenCalledWith('scheduler-session'));
    expect(order).toEqual(['persist', 'broadcast']);

    h.emit({ type: 'done', data: {} });
    await expect(firePromise).resolves.toEqual({
      sessionId: 'scheduler-session',
      resultText: undefined,
    });
  });

  it('does not reacquire headless state when acceptance arrives after send cleanup', async () => {
    let lateOnAccepted: NonNullable<SessionSendOptions>['onAccepted'];
    const h = createSessionHarness(async (_message, opts) => {
      lateOnAccepted = opts?.onAccepted;
      return { accepted: false, reason: 'cancelled-before-dispatch' };
    });
    const { runner } = createRunnerHarness(h.session);

    await expect(runner.fire(baseSchedule(), createFireContext())).rejects.toThrow(
      /cancelled-before-dispatch/,
    );
    expect(isHeadlessGhostSetupTurn('scheduler-session')).toBe(false);

    await lateOnAccepted?.();
    expect(isHeadlessGhostSetupTurn('scheduler-session')).toBe(false);
    expect(mocks.createMessage).not.toHaveBeenCalled();
  });
});
