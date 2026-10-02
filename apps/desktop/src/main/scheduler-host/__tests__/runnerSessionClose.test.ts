/**
 * MakerScheduleRunner ephemeral 会话收尾回归测试。
 *
 * 背景(2026-07-07 凌晨 OOM 事故):runner 对每次 fire 新建的会话从不 closeSession,
 * in-memory 句柄(agent 子进程 + MCP 注册 + 事件 wiring)在 main 进程单调积累,一夜
 * 186 个未关闭会话耗尽 V8 堆。修复:fire 的收尾包装在 run 终态后关闭 ephemeral 会话
 * (非 heartbeat、非持续会话),数据已落库不丢,UI 打开走 lazy resume。
 */
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
  Scheduler,
} from '@cindy/maker-scheduler';

const mocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
  getSessionRowSnapshot: vi.fn(),
  ensureDialogueWorkspaceDir: vi.fn(),
  wireSessionToIpc: vi.fn(),
  isSessionInTurn: vi.fn(),
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
  isSessionInTurn: mocks.isSessionInTurn,
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
import { isHeadlessGhostSetupTurn } from '../../mcp-integrations/ghostSetupInteractionSurface';

type SessionSendOptions = Parameters<Session['send']>[1];
type SendImpl = (
  message: Parameters<Session['send']>[0],
  opts?: SessionSendOptions,
) => Promise<SessionSendResult>;

interface FakeSessionHarness {
  session: Session;
  headlessDuringSend: boolean[];
  headlessAfterAccepted: boolean[];
  emit(event: AgentEvent): void;
}

function createSessionHarness(opts?: { sendImpl?: SendImpl }): FakeSessionHarness {
  const listeners: Array<(event: AgentEvent) => void> = [];
  const headlessDuringSend: boolean[] = [];
  const headlessAfterAccepted: boolean[] = [];
  const sendImpl: SendImpl =
    opts?.sendImpl ??
    (async (_message, sendOpts) => {
      await sendOpts?.onAccepted?.();
      return { accepted: true };
    });
  const session = {
    id: 'scheduler-session',
    agentKind: 'codex',
    send: vi.fn<SendImpl>(async (message, sendOpts) => {
      headlessDuringSend.push(isHeadlessGhostSetupTurn('scheduler-session'));
      const wrappedOpts = sendOpts
        ? {
            ...sendOpts,
            onAccepted: async () => {
              await sendOpts.onAccepted?.();
              headlessAfterAccepted.push(isHeadlessGhostSetupTurn('scheduler-session'));
            },
          }
        : sendOpts;
      return sendImpl(message, wrappedOpts);
    }),
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
    headlessDuringSend,
    headlessAfterAccepted,
    emit(event: AgentEvent) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function baseSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    name: 'close task',
    prompt: 'do the thing',
    jobType: 'prompt',
    source: 'user',
    kind: 'cron',
    cronExpr: '*/10 * * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    agentKind: 'codex',
    workspaceKind: 'dialogue',
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
  const notifier: Notifier = { notify: vi.fn(async () => undefined) };
  const logger: Logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const closeSession = vi.fn(async () => undefined);
  const maker = {
    createSession: vi.fn(async () => session),
    getSessionMeta: vi.fn(async () => null),
    isSessionAlive: vi.fn(() => false),
    closeSession,
  } as unknown as Maker;
  const runner = new MakerScheduleRunner({
    maker,
    getDb: () => ({}) as never,
    notifier,
    logger,
  });
  const schedulerUpdate = vi.fn(async () => ({}) as never);
  runner.attachScheduler({
    update: schedulerUpdate,
    isRunSilenced: () => false,
    isRunAbandoned: () => false,
  } as unknown as Scheduler);
  return { runner, maker, closeSession, logger };
}

async function fireToCompletion(
  runner: MakerScheduleRunner,
  schedule: Schedule,
  h: FakeSessionHarness,
): Promise<void> {
  const firePromise = runner.fire(schedule, createFireContext());
  await vi.waitFor(() => {
    expect(mocks.createMessage).toHaveBeenCalled();
  });
  h.emit({ type: 'done', data: {} });
  await firePromise;
}

describe('MakerScheduleRunner ephemeral 会话收尾(run 终态后 closeSession)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMessage.mockResolvedValue(undefined);
    mocks.backfillSessionMeta.mockResolvedValue(undefined);
    mocks.ensureDialogueWorkspaceDir.mockReturnValue('/managed/dialogue/dir');
    mocks.resolveWorkingDir.mockResolvedValue({ ok: true, path: '/wt/dir' });
    mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active' });
    mocks.isSessionInTurn.mockReturnValue(false);
  });

  it('ephemeral dialogue 任务:run 成功后关闭会话', async () => {
    const h = createSessionHarness();
    const { runner, closeSession } = createRunnerHarness(h.session);

    await fireToCompletion(runner, baseSchedule(), h);

    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith('scheduler-session');
  });

  it('ephemeral 任务:run 失败(send 抛错)同样收尾关闭', async () => {
    const h = createSessionHarness({
      sendImpl: async () => {
        throw new Error('boom');
      },
    });
    const { runner, closeSession } = createRunnerHarness(h.session);

    await expect(runner.fire(baseSchedule(), createFireContext())).rejects.toThrow(
      /Session send failed before dispatch/,
    );

    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith('scheduler-session');
  });

  it('heartbeat(绑定既有会话)不关闭 —— 会话生命周期不归 runner 管', async () => {
    const h = createSessionHarness();
    const { runner, maker, closeSession } = createRunnerHarness(h.session);
    (maker.getSessionMeta as ReturnType<typeof vi.fn>).mockResolvedValue({
      sdkSessionId: 'sdk-1',
      workDir: '/hb/dir',
      model: 'gpt-5.5',
    });

    await fireToCompletion(
      runner,
      baseSchedule({ targetSessionId: 'scheduler-session', workspaceKind: 'project' }),
      h,
    );

    expect(closeSession).not.toHaveBeenCalled();
    expect(maker.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ vendorOptions: { source: 'scheduler' } }),
    );
    expect(h.headlessDuringSend).toEqual([false]);
    expect(h.headlessAfterAccepted).toEqual([true]);
    expect(isHeadlessGhostSetupTurn('scheduler-session')).toBe(false);
  });

  it('persistentSession(持续会话)不关闭 —— 跨 fire 复用同一 session', async () => {
    const h = createSessionHarness();
    const { runner, closeSession } = createRunnerHarness(h.session);

    await fireToCompletion(runner, baseSchedule({ persistentSession: true }), h);

    expect(closeSession).not.toHaveBeenCalled();
    expect(h.headlessDuringSend).toEqual([false]);
    expect(h.headlessAfterAccepted).toEqual([true]);
    expect(isHeadlessGhostSetupTurn('scheduler-session')).toBe(false);
  });

  it('收尾时会话上有新 turn 在跑(用户接管)→ 让位不关', async () => {
    const h = createSessionHarness();
    const { runner, closeSession } = createRunnerHarness(h.session);
    mocks.isSessionInTurn.mockReturnValue(true);

    await fireToCompletion(runner, baseSchedule(), h);

    expect(closeSession).not.toHaveBeenCalled();
  });

  it('closeSession 抛错不影响 fire 结果(仅 warn)', async () => {
    const h = createSessionHarness();
    const { runner, closeSession, logger } = createRunnerHarness(h.session);
    (closeSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('close boom'));

    await fireToCompletion(runner, baseSchedule(), h);

    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '[runner] ephemeral session close failed (non-fatal)',
      expect.objectContaining({ sessionId: 'scheduler-session' }),
    );
  });
});
