/**
 * MakerScheduleRunner 撞忙顺延 / 活跃礼让(heartbeat 场景)。
 *
 * 验证:
 *  - B1 礼让:用户最近在远程控制(userSendAt 在窗口内)且 session 正跑 turn →
 *    不创建 session、不 send,返回 deferred FireResult。
 *  - B2 撞忙:send 抛 SESSION_RUNNING → 返回 deferred,不落失败、不通知、摘 listener。
 *  - 不命中礼让(用户很久没动 / session 空闲)→ 正常 send。
 *  - deferred FireResult 带 deferRetryMs(engine 据此短延重排)。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { AgentEvent, Maker, Session, SessionSendResult } from '@cindy/maker-core';
import type { FireContext, Logger, Notifier, Schedule } from '@cindy/maker-scheduler';

const mocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
  getSessionRowSnapshot: vi.fn(),
  ensureDialogueWorkspaceDir: vi.fn(),
  wireSessionToIpc: vi.fn(),
  isSessionInTurn: vi.fn(),
  resolveWorkingDir: vi.fn(),
  backfillSessionMeta: vi.fn(),
}));

vi.mock('../../localDb/ipc/messages.js', () => ({ createMessage: mocks.createMessage }));
vi.mock('../../localDb/ipc/sessions.js', () => ({
  getSessionRowSnapshot: mocks.getSessionRowSnapshot,
  touchUserSendInDb: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../localDb/dialogueWorkspace', () => ({ ensureDialogueWorkspaceDir: mocks.ensureDialogueWorkspaceDir }));
vi.mock('../../maker-ipc/register.js', () => ({
  wireSessionToIpc: mocks.wireSessionToIpc,
  isSessionInTurn: mocks.isSessionInTurn,
  noteSilentStopUserSend: vi.fn(),
  onSilentStopSettled: vi.fn(() => () => {}),
}));
vi.mock('../workdir-resolver', () => ({ resolveWorkingDir: mocks.resolveWorkingDir }));
vi.mock('../runners/_shared', () => ({ backfillSessionMeta: mocks.backfillSessionMeta }));

import { MakerScheduleRunner } from '../runner';
import { CredentialModeSwitchBusyError } from '../../maker-host/codex-credential-switch.js';

type SendImpl = (
  message: Parameters<Session['send']>[0],
  opts?: Parameters<Session['send']>[1],
) => Promise<SessionSendResult>;

function createSessionHarness(sendImpl: SendImpl) {
  const listeners: Array<(event: AgentEvent) => void> = [];
  const off = vi.fn(() => {
    listeners.splice(0, listeners.length);
  });
  const send = vi.fn<SendImpl>(sendImpl);
  const session = {
    id: 'heartbeat-session',
    agentKind: 'codex',
    model: 'gpt-5.4',
    remoteHostId: null,
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
    listenerCount: () => listeners.length,
    emit(event: AgentEvent) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function createLogger(): Logger {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
}

/** heartbeat schedule:带 targetSessionId 才走复用 session 分支。 */
function heartbeatSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-hb',
    name: 'PR #118 跟进',
    prompt: '【PR 跟进心跳】检查 PR 状态',
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
    targetSessionId: 'heartbeat-session',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function createFireContext(): FireContext & { abortController: AbortController } {
  const abortController = new AbortController();
  return {
    runId: 'run-hb',
    firedAt: 1_700_000_000_100,
    signal: abortController.signal,
    onSessionBound: vi.fn(async () => undefined),
    abortController,
  };
}

interface RunnerHarnessOptions {
  createSessionImpl?: () => Promise<Session>;
  sessionAlive?: boolean;
}

function createRunnerHarness(session: Session, options: RunnerHarnessOptions = {}) {
  const logger = createLogger();
  const notifier: Notifier & { notify: ReturnType<typeof vi.fn> } = {
    notify: vi.fn(async () => undefined),
  };
  const maker = {
    createSession: vi.fn(async () => {
      if (options.createSessionImpl) return options.createSessionImpl();
      return session;
    }),
    getSession: vi.fn(() => session),
    closeSession: vi.fn(async () => undefined),
    // heartbeat alive 分支:getSessionMeta 返回有效 meta(非 null → 不归档)
    getSessionMeta: vi.fn(async () => ({ sdkSessionId: 'sdk-1', workDir: 'F:\\X', model: 'gpt-5.4' })),
    isSessionAlive: vi.fn(() => options.sessionAlive ?? true),
  } as unknown as Maker;
  const runner = new MakerScheduleRunner({ maker, getDb: () => ({}) as never, notifier, logger });
  return { runner, logger, notifier, maker };
}

describe('MakerScheduleRunner 顺延 / 礼让', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMessage.mockResolvedValue(undefined);
    mocks.backfillSessionMeta.mockResolvedValue(undefined);
    mocks.resolveWorkingDir.mockResolvedValue({ ok: true, path: 'F:\\X' });
  });

  it('does not create a session or send a turn for a pre-aborted run', async () => {
    const h = createSessionHarness(async () => ({ accepted: true }));
    const { runner, maker } = createRunnerHarness(h.session);
    const ctx = createFireContext();
    ctx.abortController.abort();

    await expect(runner.fire(heartbeatSchedule(), ctx)).rejects.toThrow(
      'schedule fire aborted before runner entry',
    );
    expect(maker.createSession).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(mocks.resolveWorkingDir).not.toHaveBeenCalled();
  });

  it('rethrows a send-time abort without notifying a schedule failure', async () => {
    mocks.getSessionRowSnapshot.mockResolvedValue({
      status: 'active',
      title: null,
      userSendAt: null,
    });
    mocks.isSessionInTurn.mockReturnValue(false);
    const ctx = createFireContext();
    const h = createSessionHarness(async () => {
      ctx.abortController.abort();
      throw new Error('send cancelled by schedule abort');
    });
    const { runner, notifier } = createRunnerHarness(h.session);

    await expect(runner.fire(heartbeatSchedule(), ctx)).rejects.toThrow(
      'send cancelled by schedule abort',
    );
    expect(notifier.notify).not.toHaveBeenCalled();
    expect(h.off).toHaveBeenCalledTimes(1);
  });

  it('B1 礼让:用户最近活跃 + session 正跑 turn → deferred,不建 session 不 send', async () => {
    mocks.getSessionRowSnapshot.mockResolvedValue({
      status: 'active',
      title: null,
      userSendAt: Date.now() - 60_000, // 1 分钟前用户刚发过 → 窗口内
    });
    mocks.isSessionInTurn.mockReturnValue(true);

    const h = createSessionHarness(async () => ({ accepted: true }));
    const { runner, notifier, maker } = createRunnerHarness(h.session);

    const result = await runner.fire(heartbeatSchedule(), createFireContext());

    expect(result.deferred).toBe(true);
    expect(result.deferRetryMs).toBeGreaterThan(0);
    expect(maker.createSession).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('不礼让:用户很久没动 → 正常 send(即便 isSessionInTurn 误报也不让)', async () => {
    mocks.getSessionRowSnapshot.mockResolvedValue({
      status: 'active',
      title: null,
      userSendAt: Date.now() - 30 * 60_000, // 30 分钟前 → 窗口外
    });
    mocks.isSessionInTurn.mockReturnValue(true);

    const h = createSessionHarness(async (_m, opts) => {
      await opts?.onAccepted?.();
      return { accepted: true };
    });
    const { runner } = createRunnerHarness(h.session);

    const firePromise = runner.fire(heartbeatSchedule(), createFireContext());
    await new Promise((r) => setTimeout(r, 10));
    expect(h.send).toHaveBeenCalledTimes(1); // 正常派发,不礼让
    h.emit({ type: 'done', data: {} }); // 收尾让 turn 结束,避免 fire 悬挂
    await firePromise;
  });

  it('不礼让:session 空闲(isSessionInTurn=false)→ 正常 send', async () => {
    mocks.getSessionRowSnapshot.mockResolvedValue({
      status: 'active',
      title: null,
      userSendAt: Date.now() - 60_000, // 用户刚发过,但 session 已空闲
    });
    mocks.isSessionInTurn.mockReturnValue(false);

    const h = createSessionHarness(async (_m, opts) => {
      await opts?.onAccepted?.();
      return { accepted: true };
    });
    const { runner } = createRunnerHarness(h.session);

    const firePromise = runner.fire(heartbeatSchedule(), createFireContext());
    await new Promise((r) => setTimeout(r, 10));
    expect(h.send).toHaveBeenCalledTimes(1);
    h.emit({ type: 'done', data: {} });
    await firePromise;
  });

  it('B2 撞忙:send 抛 SESSION_RUNNING → deferred,不通知、摘 listener', async () => {
    mocks.getSessionRowSnapshot.mockResolvedValue({
      status: 'active',
      title: null,
      userSendAt: null, // 没用户活跃 → 不走 B1,落到 B2
    });
    mocks.isSessionInTurn.mockReturnValue(false);

    const err = new Error('SESSION_RUNNING: existing turn') as Error & { code?: string };
    err.code = 'SESSION_RUNNING';
    const h = createSessionHarness(async () => {
      throw err;
    });
    const { runner, notifier } = createRunnerHarness(h.session);

    const result = await runner.fire(heartbeatSchedule(), createFireContext());

    expect(result.deferred).toBe(true);
    expect(result.deferRetryMs).toBeGreaterThan(0);
    expect(notifier.notify).not.toHaveBeenCalled(); // 不落失败 run / 不通知
    expect(h.off).toHaveBeenCalled(); // turnFinished listener 已摘
  });

  it('fresh Codex credential mode 撞忙:active recurring schedule → deferred,不 send', async () => {
    const h = createSessionHarness(async () => ({ accepted: true }));
    const busy = new CredentialModeSwitchBusyError(['other-codex-session']);
    const { runner, notifier, maker } = createRunnerHarness(h.session, {
      sessionAlive: false,
      createSessionImpl: async () => {
        throw busy;
      },
    });

    const result = await runner.fire(
      heartbeatSchedule({
        targetSessionId: undefined,
        workingDir: 'F:\\X',
      }),
      createFireContext(),
    );

    expect(result.deferred).toBe(true);
    expect(result.deferRetryMs).toBeGreaterThan(0);
    expect(maker.createSession).toHaveBeenCalledTimes(1);
    expect(h.send).not.toHaveBeenCalled();
    expect(mocks.wireSessionToIpc).not.toHaveBeenCalled();
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('credential family 切换但 heartbeat 正在 turn 中 → 先顺延,不关闭 live session', async () => {
    mocks.getSessionRowSnapshot.mockResolvedValue({
      status: 'active',
      title: null,
      userSendAt: null,
      providerId: 'xd',
    });
    mocks.isSessionInTurn.mockReturnValue(true);

    const h = createSessionHarness(async () => ({ accepted: true }));
    Object.defineProperty(h.session, 'model', { value: 'codex/gpt-5.5' });
    const { runner, notifier, maker } = createRunnerHarness(h.session);

    const result = await runner.fire(
      heartbeatSchedule({ model: 'gpt-5.4', providerId: 'openai' }),
      createFireContext(),
    );

    expect(result.deferred).toBe(true);
    expect(maker.closeSession).not.toHaveBeenCalled();
    expect(maker.createSession).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it('credential family 切换但 heartbeat 不可顺延 → 可见失败,不关闭 live session', async () => {
    mocks.getSessionRowSnapshot.mockResolvedValue({
      status: 'active',
      title: null,
      userSendAt: null,
      providerId: 'xd',
    });
    mocks.isSessionInTurn.mockReturnValue(true);

    const h = createSessionHarness(async () => ({ accepted: true }));
    Object.defineProperty(h.session, 'model', { value: 'codex/gpt-5.5' });
    const { runner, notifier, maker } = createRunnerHarness(h.session);

    await expect(
      runner.fire(
        heartbeatSchedule({
          model: 'gpt-5.4',
          providerId: 'openai',
          status: 'expired',
        }),
        createFireContext(),
      ),
    ).rejects.toThrow(/SESSION_RUNNING/);

    expect(maker.closeSession).not.toHaveBeenCalled();
    expect(maker.createSession).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    const finalRun = (notifier.notify.mock.calls[0] as unknown[])[1] as { status: string };
    expect(finalRun.status).toBe('failed');
  });

  it('B 边界:expired/非 recurring heartbeat 撞忙 → 不顺延,回退为可见失败(PR #129 Thread A/E)', async () => {
    // canDefer 只在 recurring && active 时为 true。expired 行不在 activeSchedules、
    // 重启不被 listActive 加载 —— 若静默顺延,写的 nextFireAt 永不被 tick 捡起 = 丢任务。
    // 故这类撞忙不顺延,走原 failed 路径(notify 失败 + throw),用户可见可重试。
    mocks.getSessionRowSnapshot.mockResolvedValue({
      status: 'active',
      title: null,
      userSendAt: null,
    });
    mocks.isSessionInTurn.mockReturnValue(false);

    const err = new Error('SESSION_RUNNING: existing turn') as Error & { code?: string };
    err.code = 'SESSION_RUNNING';
    const h = createSessionHarness(async () => {
      throw err;
    });
    const { runner, notifier } = createRunnerHarness(h.session);

    // status:'expired' → canDefer=false → 不顺延
    await expect(
      runner.fire(heartbeatSchedule({ status: 'expired' }), createFireContext()),
    ).rejects.toThrow();
    expect(notifier.notify).toHaveBeenCalledTimes(1); // 失败可见
    const finalRun = (notifier.notify.mock.calls[0] as unknown[])[1] as { status: string };
    expect(finalRun.status).toBe('failed');
  });

  it('B 边界:manual 任务撞忙 → 不顺延(顺延会给"只能手动跑"的任务排出自动触发)', async () => {
    // manual: true, recurring: true 的任务契约是**只能经 runNow 触发**:nextFireAt 永不
    // 设置,computeNextFireAt 对它返回 undefined。但顺延分支是直接写
    // `nextFireAt: retryAt` 并把行塞回 activeSchedules 的,绕过那道语义闸 —— 一次"立即
    // 运行"撞忙就给它凭空排出一次自动触发(review #944 第十九轮 P1)。canDefer 原来的
    // 注释已经把 manual 算进排除项,代码没跟上。
    mocks.getSessionRowSnapshot.mockResolvedValue({
      status: 'active',
      title: null,
      userSendAt: null,
    });
    mocks.isSessionInTurn.mockReturnValue(false);

    const err = new Error('SESSION_RUNNING: existing turn') as Error & { code?: string };
    err.code = 'SESSION_RUNNING';
    const h = createSessionHarness(async () => {
      throw err;
    });
    const { runner, notifier } = createRunnerHarness(h.session);

    await expect(
      runner.fire(
        heartbeatSchedule({ manual: true, recurring: true, status: 'active' }),
        createFireContext(),
      ),
    ).rejects.toThrow(/SESSION_RUNNING/);
    expect(notifier.notify).toHaveBeenCalledTimes(1); // 可见失败,用户可以自己再点一次
    const finalRun = (notifier.notify.mock.calls[0] as unknown[])[1] as { status: string };
    expect(finalRun.status).toBe('failed');
  });
});
