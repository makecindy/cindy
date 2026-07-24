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
  resolveWorkingDir: vi.fn(),
  backfillSessionMeta: vi.fn(),
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
  isSessionInTurn: () => false,
  noteSilentStopUserSend: vi.fn(),
  onSilentStopSettled: vi.fn(() => () => {}),
}));

vi.mock('../workdir-resolver', () => ({
  resolveWorkingDir: mocks.resolveWorkingDir,
}));

vi.mock('../runners/_shared', () => ({
  backfillSessionMeta: mocks.backfillSessionMeta,
}));

import { MakerScheduleRunner } from '../runner';

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
  const off = vi.fn(() => {
    listeners.splice(0, listeners.length);
  });
  const send = vi.fn<SendImpl>(sendImpl);
  const session = {
    id: 'scheduler-session',
    agentKind: 'codex',
    send,
    onEvent(listener: (event: AgentEvent) => void) {
      listeners.push(listener);
      return off;
    },
    abort: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as Session;

  return {
    session,
    send,
    off,
    emit(event: AgentEvent) {
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

function createFireContext(): FireContext & {
  controller: AbortController;
  removeAbortListener: ReturnType<typeof vi.spyOn>;
} {
  const abortController = new AbortController();
  const removeAbortListener = vi.spyOn(abortController.signal, 'removeEventListener');
  return {
    runId: 'run-1',
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
    mocks.createMessage.mockResolvedValue(undefined);
    mocks.backfillSessionMeta.mockResolvedValue(undefined);
    mocks.resolveWorkingDir.mockResolvedValue({ ok: true, path: 'F:\\XDMaker' });
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
    expect(ctx.removeAbortListener).toHaveBeenCalledTimes(1);
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
    expect(ctx.removeAbortListener).toHaveBeenCalledTimes(1);
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
    const h = createSessionHarness(async () => ({
      accepted: false,
      reason: 'cancelled-before-dispatch',
    }));
    const order: string[] = [];
    const applyPendingAgentSwitch = vi.fn(async () => {
      order.push('apply');
    });
    const { runner, maker } = createRunnerHarness(h.session, { applyPendingAgentSwitch });
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
    expect(applyPendingAgentSwitch).toHaveBeenCalledWith('scheduler-session', ctx.signal);
    expect(maker.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'scheduler-session',
        agentKind: 'codex',
        model: 'gpt-5.5-codex',
      }),
    );
    expect(h.send).toHaveBeenCalledTimes(1);
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
    expect(ctx.removeAbortListener).toHaveBeenCalledTimes(1);
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
    expect(ctx.removeAbortListener).toHaveBeenCalledTimes(1);
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
    expect(ctx.removeAbortListener).toHaveBeenCalledTimes(1);
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
    expect(ctx.removeAbortListener).toHaveBeenCalledTimes(1);
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
});
