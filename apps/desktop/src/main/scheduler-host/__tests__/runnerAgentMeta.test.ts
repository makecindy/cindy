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
} from '@cindy/maker-scheduler';

const mocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
  getSessionRowSnapshot: vi.fn(),
  touchUserSendInDb: vi.fn(),
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
  getSessionSearchModeEnabled: vi.fn(async () => false),
  touchUserSendInDb: mocks.touchUserSendInDb,
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
}

function createSessionHarness(sendImpl: SendImpl): FakeSessionHarness {
  const listeners: Array<(event: AgentEvent) => void> = [];
  const session = {
    id: 'scheduler-session',
    agentKind: 'codex',
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

function createLogger(): Logger {
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
    name: 'pr follow-up',
    prompt: 'check the PR status',
    jobType: 'prompt',
    source: 'user',
    kind: 'cron',
    cronExpr: '*/10 * * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    agentKind: 'codex',
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

function createRunnerHarness(
  session: Session,
  opts: { sessionMeta?: Record<string, unknown> | null } = {},
) {
  const logger = createLogger();
  const notifier: Notifier = { notify: vi.fn(async () => undefined) };
  const maker = {
    createSession: vi.fn(async () => session),
    getSessionMeta: vi.fn(async () => opts.sessionMeta ?? null),
    isSessionAlive: vi.fn(() => false),
    closeSession: vi.fn(async () => undefined),
  } as unknown as Maker;
  const runner = new MakerScheduleRunner({
    maker,
    getDb: () => ({}) as never,
    notifier,
    logger,
  });
  return { runner, logger, notifier, maker };
}

/** send 接受 + onAccepted 落库 + 终态事件,跑通完整 fire 主路径 */
function acceptingSend(): SendImpl {
  return async (_message, opts) => {
    await opts?.onAccepted?.();
    return { accepted: true };
  };
}

async function fireToCompletion(
  runner: MakerScheduleRunner,
  schedule: Schedule,
  h: FakeSessionHarness,
): Promise<void> {
  const firePromise = runner.fire(schedule, createFireContext());
  // 等 send/onAccepted 跑完、terminal listener 挂上,再 emit done 收尾
  await vi.waitFor(() => {
    expect(mocks.createMessage).toHaveBeenCalled();
  });
  h.emit({ type: 'done', data: {} });
  await firePromise;
}

describe('MakerScheduleRunner agentMeta automation origin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMessage.mockResolvedValue(undefined);
    mocks.touchUserSendInDb.mockResolvedValue(undefined);
    mocks.backfillSessionMeta.mockResolvedValue(undefined);
    mocks.resolveWorkingDir.mockResolvedValue({ ok: true, path: '/repo/project' });
    mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active' });
  });

  it('heartbeat fire 注入的 user 消息带 scheduler origin 标记', async () => {
    const h = createSessionHarness(acceptingSend());
    const { runner } = createRunnerHarness(h.session, {
      sessionMeta: { sdkSessionId: 'sdk-1', workDir: '/repo/project' },
    });
    const schedule = baseSchedule({ targetSessionId: 'scheduler-session' });

    await fireToCompletion(runner, schedule, h);

    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    const [sessionId, body] = mocks.createMessage.mock.calls[0];
    expect(sessionId).toBe('scheduler-session');
    expect(body.role).toBe('user');
    expect(body.content).toBe('check the PR status');
    expect(body.agentMeta).toEqual({
      origin: {
        kind: 'scheduler',
        scheduleId: 'schedule-1',
        scheduleName: 'pr follow-up',
        runId: 'run-1',
      },
    });
  });

  it('非 heartbeat 新建 session 路径同样带 scheduler origin 标记', async () => {
    const h = createSessionHarness(acceptingSend());
    const { runner } = createRunnerHarness(h.session);
    const schedule = baseSchedule();

    await fireToCompletion(runner, schedule, h);

    expect(mocks.createMessage).toHaveBeenCalledTimes(1);
    const [, body] = mocks.createMessage.mock.calls[0];
    expect(body.role).toBe('user');
    expect(body.content).toBe('check the PR status');
    expect(body.agentMeta?.origin).toEqual({
      kind: 'scheduler',
      scheduleId: 'schedule-1',
      scheduleName: 'pr follow-up',
      runId: 'run-1',
    });
  });

  it('heartbeat fire 绑定既有会话时把 userSendAt bump 到本次 firedAt(侧栏 userSendAt 排序据此冒头)', async () => {
    const h = createSessionHarness(acceptingSend());
    const { runner } = createRunnerHarness(h.session, {
      sessionMeta: { sdkSessionId: 'sdk-1', workDir: '/repo/project' },
    });
    const schedule = baseSchedule({ targetSessionId: 'scheduler-session' });

    await fireToCompletion(runner, schedule, h);

    // 绑定既有会话每次 fire 都刷成本次 firedAt —— userSendAt 排序据此让它冒到列表顶。
    expect(mocks.touchUserSendInDb).toHaveBeenCalledTimes(1);
    expect(mocks.touchUserSendInDb).toHaveBeenCalledWith('scheduler-session', 1_700_000_000_100);
  });

  it('非 heartbeat 新建 session 路径同样 bump userSendAt 到 firedAt', async () => {
    const h = createSessionHarness(acceptingSend());
    const { runner } = createRunnerHarness(h.session);
    const schedule = baseSchedule();

    await fireToCompletion(runner, schedule, h);

    expect(mocks.touchUserSendInDb).toHaveBeenCalledTimes(1);
    const [, atMs] = mocks.touchUserSendInDb.mock.calls[0];
    expect(atMs).toBe(1_700_000_000_100);
  });
});
