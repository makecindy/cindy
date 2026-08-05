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

import { MakerScheduleRunner, BG_TASK_IDLE_FALLBACK_MS } from '../runner';

type SessionSendOptions = Parameters<Session['send']>[1];
type SendImpl = (
  message: Parameters<Session['send']>[0],
  opts?: SessionSendOptions,
) => Promise<SessionSendResult>;

interface FakeSessionHarness {
  session: Session;
  emit(event: AgentEvent): void;
}

function createSessionHarness(sendImpl: SendImpl): FakeSessionHarness {
  const listeners: Array<(event: AgentEvent) => void> = [];
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
    abort: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as Session;

  return {
    session,
    emit(event: AgentEvent) {
      for (const listener of [...listeners]) listener(event);
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

function taskUpdate(taskId: string, status: string): AgentEvent {
  return {
    type: 'agent_task_update',
    data: { provider: 'claude-code', taskId, status },
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
    h.emit(textFinal('waiting for subagents'));
    h.emit({ type: 'done', data: {} });
    await flushMicrotasks();
    expect(resolved).toBe(false);
    expect(notifier.notify).not.toHaveBeenCalled();

    // subagent 完成 → SDK 自动续 turn,产出真正的最终 summary
    h.emit(taskUpdate('bg-task-1', 'completed'));
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

  it('后台任务事件丢失:静默超时兜底收尾,不永久挂起', async () => {
    vi.useFakeTimers();
    const h = createSessionHarness(acceptingSend());
    const { runner, notifier, logger } = createRunnerHarness(h.session);

    const firePromise = runner.fire(baseSchedule(), createFireContext());
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.createMessage).toHaveBeenCalled();

    h.emit(taskUpdate('bg-task-1', 'running'));
    h.emit(textFinal('waiting for subagents'));
    h.emit({ type: 'done', data: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(notifier.notify).not.toHaveBeenCalled();

    // 任务完成事件永远不来 → 静默满 BG_TASK_IDLE_FALLBACK_MS 后强制收尾
    await vi.advanceTimersByTimeAsync(BG_TASK_IDLE_FALLBACK_MS);
    await firePromise;

    const run = notifiedRun(notifier);
    expect(run.status).toBe('success');
    expect(run.resultText).toBe('waiting for subagents');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('等待期间有事件流动会刷新兜底计时,不误触发', async () => {
    vi.useFakeTimers();
    const h = createSessionHarness(acceptingSend());
    const { runner, notifier } = createRunnerHarness(h.session);

    const firePromise = runner.fire(baseSchedule(), createFireContext());
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.createMessage).toHaveBeenCalled();

    h.emit(taskUpdate('bg-task-1', 'running'));
    h.emit(textFinal('waiting for subagents'));
    h.emit({ type: 'done', data: {} });

    // 每隔半个兜底窗口来一次 task_progress → 计时被刷新,不应超时收尾
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(BG_TASK_IDLE_FALLBACK_MS / 2);
      h.emit(taskUpdate('bg-task-1', 'running'));
    }
    expect(notifier.notify).not.toHaveBeenCalled();

    h.emit(taskUpdate('bg-task-1', 'completed'));
    h.emit(textFinal('final summary'));
    h.emit({ type: 'done', data: {} });
    await firePromise;

    expect(notifiedRun(notifier).resultText).toBe('final summary');
  });
});
