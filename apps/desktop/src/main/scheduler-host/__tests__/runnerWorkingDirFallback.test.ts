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
}

function createSessionHarness(): FakeSessionHarness {
  const listeners: Array<(event: AgentEvent) => void> = [];
  const sendImpl: SendImpl = async (_message, opts) => {
    await opts?.onAccepted?.();
    return { accepted: true };
  };
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

function baseSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    name: 'no-dir task',
    prompt: 'do the thing',
    jobType: 'prompt',
    source: 'user',
    kind: 'cron',
    cronExpr: '*/10 * * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    agentKind: 'codex',
    workspaceKind: 'project',
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
  opts: {
    resolveDefaultModelRoute?: ConstructorParameters<
      typeof MakerScheduleRunner
    >[0]['resolveDefaultModelRoute'];
  } = {},
) {
  const notifier: Notifier = { notify: vi.fn(async () => undefined) };
  const logger: Logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const createSession = vi.fn(async () => session);
  const maker = {
    createSession,
    getSessionMeta: vi.fn(async () => null),
    isSessionAlive: vi.fn(() => false),
    closeSession: vi.fn(async () => undefined),
  } as unknown as Maker;
  const runner = new MakerScheduleRunner({
    maker,
    getDb: () => ({}) as never,
    notifier,
    logger,
    resolveDefaultModelRoute: opts.resolveDefaultModelRoute,
  });
  // 回退分支会把存量 project 形态任务的分类自愈写回 dialogue —— 用 fake
  // scheduler 捕获 update 调用
  const schedulerUpdate = vi.fn(async () => ({}) as never);
  runner.attachScheduler({
    update: schedulerUpdate,
    isRunSilenced: () => false,
    isRunAbandoned: () => false,
  } as unknown as Scheduler);
  return { runner, createSession, schedulerUpdate };
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

describe('MakerScheduleRunner workingDir fallback(未指定目录回退 dialogue 工作区)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMessage.mockResolvedValue(undefined);
    mocks.backfillSessionMeta.mockResolvedValue(undefined);
    mocks.ensureDialogueWorkspaceDir.mockReturnValue('/managed/dialogue/dir');
    mocks.resolveWorkingDir.mockResolvedValue({ ok: true, path: '/wt/dir' });
    mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active' });
  });

  it('project 形态但 workingDir 缺失 → 分配 dialogue 工作区而非报错(MCP 建任务常见形态)', async () => {
    const h = createSessionHarness();
    const { runner, createSession, schedulerUpdate } = createRunnerHarness(h.session);

    await fireToCompletion(runner, baseSchedule({ workingDir: undefined }), h);

    // 存量坏数据自愈:project 形态走了回退 → 分类落库改成 dialogue
    expect(schedulerUpdate).toHaveBeenCalledWith('schedule-1', {
      workspaceKind: 'dialogue',
    });

    expect(mocks.ensureDialogueWorkspaceDir).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workingDir: '/managed/dialogue/dir' }),
    );
    // 回退的会话按 dialogue 落库 → 侧边栏归入"对话"分组
    expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ workspaceKind: 'dialogue' }),
      expect.anything(),
    );
  });

  it('workingDir 为空白串同样回退', async () => {
    const h = createSessionHarness();
    const { runner, createSession } = createRunnerHarness(h.session);

    await fireToCompletion(runner, baseSchedule({ workingDir: '   ' }), h);

    expect(mocks.ensureDialogueWorkspaceDir).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workingDir: '/managed/dialogue/dir' }),
    );
  });

  it('显式 workingDir 不受影响,不走 dialogue 分配', async () => {
    const h = createSessionHarness();
    const { runner, createSession } = createRunnerHarness(h.session);

    await fireToCompletion(runner, baseSchedule({ workingDir: '/repo/project' }), h);

    expect(mocks.ensureDialogueWorkspaceDir).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workingDir: '/repo/project' }),
    );
    // 显式项目目录的会话保持 project 归组
    expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ workspaceKind: 'project' }),
      expect.anything(),
    );
  });

  it('creates unattended Pi schedules with a connected model/provider pair and non-blocking permission mode', async () => {
    const h = createSessionHarness();
    const resolveDefaultModelRoute = vi.fn(async () => ({
      model: 'local-pi-model',
      providerId: 'local-byom',
    }));
    const { runner, createSession } = createRunnerHarness(h.session, { resolveDefaultModelRoute });

    await fireToCompletion(
      runner,
      baseSchedule({ agentKind: 'pi', model: undefined, workingDir: '/repo/pi-project' }),
      h,
    );

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      agentKind: 'pi',
      model: 'local-pi-model',
      providerId: 'local-byom',
      permissionMode: 'bypassPermissions',
      workingDir: '/repo/pi-project',
    }));
    expect(resolveDefaultModelRoute).toHaveBeenCalledWith('pi', null);
  });

  it('workspaceKind 已是 dialogue → 不重复落库自愈', async () => {
    const h = createSessionHarness();
    const { runner, schedulerUpdate } = createRunnerHarness(h.session);

    await fireToCompletion(
      runner,
      baseSchedule({ workspaceKind: 'dialogue', workingDir: undefined }),
      h,
    );

    expect(mocks.ensureDialogueWorkspaceDir).toHaveBeenCalledTimes(1);
    expect(schedulerUpdate).not.toHaveBeenCalled();
  });

  it('useWorktree=true 且无 workingDir → 仍走 worktree 解析(不被 dialogue 回退劫持)', async () => {
    const h = createSessionHarness();
    const { runner, createSession } = createRunnerHarness(h.session);

    await fireToCompletion(
      runner,
      baseSchedule({ workingDir: undefined, useWorktree: true }),
      h,
    );

    expect(mocks.ensureDialogueWorkspaceDir).not.toHaveBeenCalled();
    expect(mocks.resolveWorkingDir).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workingDir: '/wt/dir' }),
    );
  });
});
