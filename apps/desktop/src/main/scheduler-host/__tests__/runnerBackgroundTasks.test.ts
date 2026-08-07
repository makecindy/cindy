import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

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
  emit(event: AgentEvent): void;
  emitStatus(status: 'active' | 'aborting' | 'closed' | 'error'): void;
  setContinuationState(
    continuationId: number,
    state: 'awaiting' | 'active' | 'cancelled',
    emit?: boolean,
  ): void;
}

function createSessionHarness(sendImpl: SendImpl): FakeSessionHarness {
  const listeners: Array<(event: AgentEvent) => void> = [];
  const statusListeners: Array<
    (status: 'active' | 'aborting' | 'closed' | 'error') => void
  > = [];
  const continuationListeners: Array<(
    continuationId: number,
    state: 'awaiting' | 'active' | 'cancelled',
  ) => void> = [];
  const continuationStates = new Map<
    number,
    'awaiting' | 'active' | 'cancelled'
  >();
  const session = {
    id: 'scheduler-session',
    agentKind: 'claude-code',
    send: vi.fn<SendImpl>(sendImpl),
    onEvent(listener: (event: AgentEvent) => void) {
      listeners.push(listener);
      return vi.fn(() => {
        listeners.splice(0, listeners.length);
      });
    },
    beginTurnContinuationWait: (continuationId?: number) =>
      continuationId === undefined ? null : continuationStates.get(continuationId) ?? null,
    onTurnContinuationChange(
      listener: (
        continuationId: number,
        state: 'awaiting' | 'active' | 'cancelled',
      ) => void,
    ) {
      continuationListeners.push(listener);
      return vi.fn(() => {
        const index = continuationListeners.indexOf(listener);
        if (index >= 0) continuationListeners.splice(index, 1);
      });
    },
    onStatusChange(
      listener: (status: 'active' | 'aborting' | 'closed' | 'error') => void,
    ) {
      statusListeners.push(listener);
      return vi.fn(() => {
        statusListeners.splice(0, statusListeners.length);
      });
    },
    abort: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as Session;

  return {
    session,
    emit(event: AgentEvent) {
      for (const listener of [...listeners]) listener(event);
    },
    emitStatus(status) {
      for (const listener of [...statusListeners]) listener(status);
    },
    setContinuationState(continuationId, state, emit = false) {
      continuationStates.set(continuationId, state);
      if (!emit) return;
      for (const listener of [...continuationListeners]) {
        listener(continuationId, state);
      }
    },
  };
}

function baseSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    name: 'auto pr review',
    prompt: 'review pending PRs',
    jobType: 'prompt',
    source: 'user',
    kind: 'cron',
    cronExpr: '*/10 * * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    agentKind: 'claude-code',
    workspaceKind: 'project',
    workingDir: '/repo/project',
    useWorktree: false,
    notify: { desktop: true, feishu: false },
    status: 'active',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function createFireContext(): FireContext {
  return {
    runId: 'run-1',
    firedAt: 1_700_000_000_100,
    signal: new AbortController().signal,
    onSessionBound: vi.fn(async () => undefined),
  };
}

function createRunnerHarness(session: Session) {
  const notifier: Notifier & { notify: ReturnType<typeof vi.fn> } = {
    notify: vi.fn(async () => undefined),
  };
  const logger: Logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
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
  });
  return { runner, notifier, logger };
}

function acceptingSend(): SendImpl {
  return async (_message, opts) => {
    await opts?.onAccepted?.();
    return { accepted: true };
  };
}

function textFinal(text: string): AgentEvent {
  return { type: 'text', data: { text, isFinal: true } };
}

function taskUpdate(
  taskId: string,
  status: string,
  taskType: string = 'local_agent',
  provider: string = 'claude-code',
): AgentEvent {
  return {
    type: 'agent_task_update',
    data: { provider, taskId, status, taskType },
  };
}

/** 只 flush microtask 队列,不依赖真实时间(fake/real timers 通用)。 */
async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function notifiedRun(notifier: { notify: ReturnType<typeof vi.fn> }): ScheduleRun {
  expect(notifier.notify).toHaveBeenCalledTimes(1);
  return notifier.notify.mock.calls[0][1] as ScheduleRun;
}

describe('MakerScheduleRunner background subagent task tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMessage.mockResolvedValue(undefined);
    mocks.backfillSessionMeta.mockResolvedValue(undefined);
    mocks.resolveWorkingDir.mockResolvedValue({ ok: true, path: '/repo/project' });
    mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('无后台任务:首个 done 照常收尾,resultText 为本轮最终文本', async () => {
    const h = createSessionHarness(acceptingSend());
    const { runner, notifier } = createRunnerHarness(h.session);

    const firePromise = runner.fire(baseSchedule(), createFireContext());
    await vi.waitFor(() => expect(mocks.createMessage).toHaveBeenCalled());

    h.emit(textFinal('all done'));
    h.emit({ type: 'done', data: {} });
    await firePromise;

    const run = notifiedRun(notifier);
    expect(run.status).toBe('success');
    expect(run.resultText).toBe('all done');
  });

  it('有在途后台任务:首个 done 不定格,等任务收尾后的 done 才通知最终文本', async () => {
    const h = createSessionHarness(acceptingSend());
    const { runner, notifier } = createRunnerHarness(h.session);

    const firePromise = runner.fire(baseSchedule(), createFireContext());
    let resolved = false;
    void firePromise.then(() => {
      resolved = true;
    });
    await vi.waitFor(() => expect(mocks.createMessage).toHaveBeenCalled());

    // 主 turn:派出后台 subagent 后以"等待中"文本结束
    h.emit(taskUpdate('bg-task-1', 'running'));
    h.setContinuationState(1, 'awaiting');
    h.emit(textFinal('waiting for subagents'));
    h.emit({ type: 'done', data: {}, turnContinuationId: 1 });
    await flushMicrotasks();
    expect(resolved).toBe(false);
    expect(notifier.notify).not.toHaveBeenCalled();

    // subagent 完成 → SDK 自动续 turn,产出真正的最终 summary
    h.emit(taskUpdate('bg-task-1', 'completed'));
    h.setContinuationState(1, 'active');
    h.emit(textFinal('final summary'));
    h.emit({ type: 'done', data: {} });
    await firePromise;

    const run = notifiedRun(notifier);
    expect(run.status).toBe('success');
    expect(run.resultText).toBe('final summary');
  });

  it('任务在 done 前已完成:不进入等待,首个 done 即收尾', async () => {
    const h = createSessionHarness(acceptingSend());
    const { runner, notifier } = createRunnerHarness(h.session);

    const firePromise = runner.fire(baseSchedule(), createFireContext());
    await vi.waitFor(() => expect(mocks.createMessage).toHaveBeenCalled());

    h.emit(taskUpdate('bg-task-1', 'running'));
    h.emit(taskUpdate('bg-task-1', 'completed'));
    h.emit(textFinal('all done'));
    h.emit({ type: 'done', data: {} });
    await firePromise;

    expect(notifiedRun(notifier).resultText).toBe('all done');
  });

  it('普通后台命令和 Codex 任务卡不具备 continuation 语义,首个 done 立即收尾', async () => {
    for (const event of [
      taskUpdate('bash-1', 'running', 'local_bash'),
      taskUpdate('codex-1', 'running', 'local_agent', 'codex'),
    ]) {
      const h = createSessionHarness(acceptingSend());
      const { runner, notifier } = createRunnerHarness(h.session);

      const firePromise = runner.fire(baseSchedule(), createFireContext());
      await vi.waitFor(() => expect(mocks.createMessage).toHaveBeenCalled());
      h.emit(event);
      h.emit(textFinal('done without continuation'));
      h.emit({ type: 'done', data: {} });
      await firePromise;

      expect(notifiedRun(notifier).resultText).toBe('done without continuation');
      vi.clearAllMocks();
      mocks.createMessage.mockResolvedValue(undefined);
      mocks.backfillSessionMeta.mockResolvedValue(undefined);
      mocks.resolveWorkingDir.mockResolvedValue({ ok: true, path: '/repo/project' });
      mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active' });
    }
  });

  it('pending continuation 无论静默多久都不猜完成，只等 provider 状态与下一 done', async () => {
    vi.useFakeTimers();
    const h = createSessionHarness(acceptingSend());
    const { runner, notifier } = createRunnerHarness(h.session);

    const firePromise = runner.fire(baseSchedule(), createFireContext());
    let resolved = false;
    void firePromise.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.createMessage).toHaveBeenCalled();

    h.emit(taskUpdate('bg-task-1', 'running'));
    h.setContinuationState(2, 'awaiting');
    h.emit(textFinal('waiting for subagents'));
    h.emit({ type: 'done', data: {}, turnContinuationId: 2 });
    await vi.advanceTimersByTimeAsync(0);
    expect(notifier.notify).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(resolved).toBe(false);
    expect(notifier.notify).not.toHaveBeenCalled();

    h.emit(taskUpdate('bg-task-1', 'completed'));
    h.setContinuationState(2, 'active');
    h.emit(textFinal('final summary'));
    h.emit({ type: 'done', data: {} });
    await firePromise;

    expect(notifiedRun(notifier).resultText).toBe('final summary');
  });

  it('continuation task stopped after done 收到 provider cancellation 后立即收口', async () => {
    const h = createSessionHarness(acceptingSend());
    const { runner, notifier } = createRunnerHarness(h.session);

    const firePromise = runner.fire(baseSchedule(), createFireContext());
    let resolved = false;
    void firePromise.then(() => { resolved = true; });
    await vi.waitFor(() => expect(mocks.createMessage).toHaveBeenCalled());

    h.emit(taskUpdate('bg-task-1', 'running'));
    h.setContinuationState(3, 'awaiting');
    h.emit(textFinal('等待后台任务'));
    h.emit({ type: 'done', data: {}, turnContinuationId: 3 });
    await flushMicrotasks();
    expect(resolved).toBe(false);

    h.setContinuationState(3, 'cancelled', true);
    await firePromise;
    expect(notifiedRun(notifier).resultText).toBe('等待后台任务');
  });

  it('host 消费父 done 前 continuation 已 active，仍等待第二个 done', async () => {
    const h = createSessionHarness(acceptingSend());
    const { runner, notifier } = createRunnerHarness(h.session);

    const firePromise = runner.fire(baseSchedule(), createFireContext());
    let resolved = false;
    void firePromise.then(() => { resolved = true; });
    await vi.waitFor(() => expect(mocks.createMessage).toHaveBeenCalled());

    h.setContinuationState(4, 'active');
    h.emit(textFinal('父 turn 已结束'));
    h.emit({ type: 'done', data: {}, turnContinuationId: 4 });
    await flushMicrotasks();
    expect(resolved).toBe(false);

    h.emit(textFinal('自动续 turn 的最终结果'));
    h.emit({ type: 'done', data: {} });
    await firePromise;
    expect(notifiedRun(notifier).resultText).toBe('自动续 turn 的最终结果');
  });
});
