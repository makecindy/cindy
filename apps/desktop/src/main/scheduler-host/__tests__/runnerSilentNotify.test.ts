import { describe, expect, it, vi, beforeEach } from 'vitest';

import type {
  AgentEvent,
  Maker,
  Session,
  SessionSendResult,
} from '@cindy/maker-core';
import type { Scheduler } from '@cindy/maker-scheduler';
import type {
  FireContext,
  Logger,
  Notifier,
  Schedule,
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
  opts: { silenced: boolean; abandoned?: boolean },
) {
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
  const isRunSilenced = vi.fn(() => opts.silenced);
  const isRunAbandoned = vi.fn(() => opts.abandoned === true);
  runner.attachScheduler({ isRunSilenced, isRunAbandoned } as unknown as Scheduler);
  return { runner, notifier, isRunSilenced, isRunAbandoned };
}

/** send 接受 + onAccepted 落库,emit done 后 fire 才会 resolve */
function acceptingSend(): SendImpl {
  return async (_message, opts) => {
    await opts?.onAccepted?.();
    return { accepted: true };
  };
}

async function fireToCompletion(
  runner: MakerScheduleRunner,
  h: FakeSessionHarness,
): Promise<void> {
  const firePromise = runner.fire(baseSchedule(), createFireContext());
  await vi.waitFor(() => {
    expect(mocks.createMessage).toHaveBeenCalled();
  });
  h.emit({ type: 'done', data: {} });
  await firePromise;
}

describe('MakerScheduleRunner silent-run notification skip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMessage.mockResolvedValue(undefined);
    mocks.backfillSessionMeta.mockResolvedValue(undefined);
    mocks.resolveWorkingDir.mockResolvedValue({ ok: true, path: '/repo/project' });
    mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active' });
  });

  it('success + silenced → 跳过完成通知', async () => {
    const h = createSessionHarness(acceptingSend());
    const { runner, notifier, isRunSilenced } = createRunnerHarness(h.session, { silenced: true });

    await fireToCompletion(runner, h);

    expect(isRunSilenced).toHaveBeenCalledWith('run-1');
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('success + 未静默 → 照常通知', async () => {
    const h = createSessionHarness(acceptingSend());
    const { runner, notifier } = createRunnerHarness(h.session, { silenced: false });

    await fireToCompletion(runner, h);

    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });

  it('silentWhenIdle=true → 发送隐藏主动上报协议,落库仍保留原始 prompt', async () => {
    const h = createSessionHarness(acceptingSend());
    const { runner } = createRunnerHarness(h.session, { silenced: false });

    const firePromise = runner.fire(
      baseSchedule({ silentWhenIdle: true }),
      createFireContext(),
    );
    await vi.waitFor(() => {
      expect(mocks.createMessage).toHaveBeenCalled();
    });
    h.emit({ type: 'done', data: {} });
    await firePromise;

    const sent = (h.session.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      content: string;
    };
    expect(sent.content.startsWith('check the PR status')).toBe(true);
    expect(sent.content).toContain('schedule_notify_current_run');
    expect(sent.content).toContain('Successful runs do not notify by default');
    expect(sent.content).toContain('call_tool');
    expect(sent.content).toContain('args: {}');
    expect(sent.content).not.toContain('run-1');
    const [, body] = mocks.createMessage.mock.calls[0];
    expect(body.content).toBe('check the PR status');
  });

  it('silentWhenIdle=false → prompt 原样,不注入协议', async () => {
    const h = createSessionHarness(acceptingSend());
    const { runner } = createRunnerHarness(h.session, { silenced: false });

    await fireToCompletion(runner, h);

    const sent = (h.session.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      content: string;
    };
    expect(sent.content).toBe('check the PR status');
  });

  it('failed + silenced → 仍然通知(fail-safe,异常必须可见)', async () => {
    const h = createSessionHarness(async (_message, opts) => {
      await opts?.onAccepted?.();
      throw new Error('send blew up');
    });
    const { runner, notifier } = createRunnerHarness(h.session, { silenced: true });

    await expect(runner.fire(baseSchedule(), createFireContext())).rejects.toThrow();

    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });

  it('已被卡死守卫强制收口的 run:success 迟到 settle 不重复通知', async () => {
    // 引擎强制收口时已按任务配置投过失败通知。常见顺序是"引擎先投、runner 几分钟后才
    // settle",runner 若照常走 finalizeRun,用户会为同一轮收到两条
    // (review #944 第十四轮 P1)。
    const h = createSessionHarness(acceptingSend());
    const { runner, notifier, isRunAbandoned } = createRunnerHarness(h.session, {
      silenced: false,
      abandoned: true,
    });

    await fireToCompletion(runner, h);

    expect(isRunAbandoned).toHaveBeenCalled();
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('已被卡死守卫强制收口的 run:失败路径也不重复通知', async () => {
    const h = createSessionHarness(async (_message, opts) => {
      await opts?.onAccepted?.();
      throw new Error('send blew up');
    });
    const { runner, notifier } = createRunnerHarness(h.session, {
      silenced: false,
      abandoned: true,
    });

    await expect(runner.fire(baseSchedule(), createFireContext())).rejects.toThrow();

    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('通知权在投递开始之前就已认领(不是投递完才认领)', async () => {
    // abandoned 预检只在进入 notify 之前有效。notifier.notify 是 await,期间强制收口完全
    // 可能把这一轮标成 abandoned,并因为 runnerNotifiedFailure 还是 false 而并发投出第二
    // 条通知。认领必须早于投递,引擎的 needsForcedFailureNotification 才看得见
    // (review #944 第十五轮 P1)。
    const h = createSessionHarness(acceptingSend());
    const { runner, notifier } = createRunnerHarness(h.session, { silenced: false });
    const notified: string[] = [];
    const ctx = createFireContext();
    (ctx as { onRunnerNotified?: (k: string) => void }).onRunnerNotified = (k) => {
      notified.push(k);
    };
    // 投递卡住:此刻若还没认领,就存在竞态窗口
    let releaseNotify!: () => void;
    notifier.notify.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseNotify = resolve; }),
    );

    const firePromise = runner.fire(baseSchedule(), ctx);
    await vi.waitFor(() => expect(mocks.createMessage).toHaveBeenCalled());
    h.emit({ type: 'done', data: {} });

    // 投递仍挂着,但认领已经发生
    await vi.waitFor(() => expect(notifier.notify).toHaveBeenCalled());
    expect(notified).toEqual(['success']);

    releaseNotify();
    await firePromise;
    expect(notified).toEqual(['success']);
  });

  it('守卫 abort 之后才拿到成功结果:压住这条自相矛盾的成功通知', async () => {
    // 守卫 abort 已经发出、强制释放的宽限还没到点时,runner 可能恰好拿到成功结果。此刻
    // abandoned 仍是 false,旧实现照常投一条"成功";紧接着引擎看到 stallAbortedAt,把这一轮
    // 记成 failed 并补投一条"失败" —— 同一轮两条互相矛盾的通知(review #944 第十八轮 P1)。
    const h = createSessionHarness(acceptingSend());
    const { runner, notifier } = createRunnerHarness(h.session, { silenced: false });
    const controller = new AbortController();
    const ctx = createFireContext();
    (ctx as { signal: AbortSignal }).signal = controller.signal;

    const firePromise = runner.fire(baseSchedule(), ctx);
    await vi.waitFor(() => expect(mocks.createMessage).toHaveBeenCalled());
    controller.abort(); // 卡死守卫开火
    h.emit({ type: 'done', data: {} }); // 但这一轮其实跑完了
    await firePromise;

    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('守卫 abort 之后拿到失败结果:失败通知照发(异常必须可见)', async () => {
    // 压 success 不能顺手把失败也压掉。引擎那边有 needsForcedFailureNotification 兜着
    // 去重(runner 认领过 'failure' 就不再补投),所以这条照发不会变成双份。
    // 注:send 自己抛错时若 signal 已 abort,runner 更早就直接 rethrow、压根不到
    // finalizeRun(第五轮已确立的语义,由引擎补发)。能带着 runError 走到 finalizeRun 的
    // 是"turn 已受理、之后收到终态 error"这条路,所以这里这么构造。
    const h = createSessionHarness(acceptingSend());
    const { runner, notifier } = createRunnerHarness(h.session, { silenced: false });
    const controller = new AbortController();
    const ctx = createFireContext();
    (ctx as { signal: AbortSignal }).signal = controller.signal;

    const firePromise = runner.fire(baseSchedule(), ctx);
    await vi.waitFor(() => expect(mocks.createMessage).toHaveBeenCalled());
    controller.abort();
    h.emit({ type: 'error', data: { message: 'upstream died', isTerminal: true } });
    await expect(firePromise).rejects.toThrow();

    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });

  it('未被强制收口时通知照发(去重不能变成永久静默)', async () => {
    const h = createSessionHarness(acceptingSend());
    const { runner, notifier } = createRunnerHarness(h.session, {
      silenced: false,
      abandoned: false,
    });

    await fireToCompletion(runner, h);

    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });
});
