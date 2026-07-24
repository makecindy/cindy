/**
 * 心跳撞忙排队派发(fireHeartbeatViaQueue)单测。
 *
 * 背景(2026-07-14 实踩,会话 0686cfa0):心跳 fire 撞上绑定会话正忙时,旧路径
 * 要么盲发(遇 maker-core isTurnRunning 误报空闲会把 prompt 注入运行中的 turn),
 * 要么只静默顺延。新路径把 prompt 作为排队消息入 coordinator 队列(UI 可见、
 * 可删除),drain 派发(onAccepted)后沿用既有 run 结果捕获/通知链路。
 *
 * 覆盖:
 *  - 撞忙 → enqueuePrompt(text 带静默协议后缀 / persistedContent 是原始 prompt /
 *    origin=scheduler),不直发 session.send、不自行 createMessage
 *  - accepted → 等 turn done → success run 带 resultText
 *  - 同 schedule 已有排队项 → 顺延(deferred),不重复入队
 *  - 排队项被丢弃(用户删除)→ run 以含 aborted 的错误收尾
 *  - pause/delete abort → removeQueuedPrompt 撤项
 *  - 会话空闲 → 不入队,走原直发路径(行为回归)
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

import { MakerScheduleRunner, type SchedulerQueueDeps } from '../runner';
import { isHeadlessGhostSetupTurn } from '../../mcp-integrations/ghostSetupInteractionSurface';

type SessionSendOptions = Parameters<Session['send']>[1];
type SendImpl = (
  message: Parameters<Session['send']>[0],
  opts?: SessionSendOptions,
) => Promise<SessionSendResult>;

const SESSION_ID = 'bound-session';

interface FakeSessionHarness {
  session: Session;
  send: ReturnType<typeof vi.fn<SendImpl>>;
  setModel: ReturnType<typeof vi.fn>;
  setEffort: ReturnType<typeof vi.fn>;
  emit(event: AgentEvent): void;
  listenerCount(): number;
}

function createSessionHarness(sendImpl: SendImpl): FakeSessionHarness {
  const listeners: Array<(event: AgentEvent) => void> = [];
  const send = vi.fn<SendImpl>(sendImpl);
  const setModel = vi.fn(async () => undefined);
  const setEffort = vi.fn(async () => undefined);
  const session = {
    id: SESSION_ID,
    agentKind: 'claude-code',
    model: 'claude-opus-4-6',
    remoteHostId: null,
    codexProxyActive: undefined,
    setModel,
    setEffort,
    send,
    onEvent(listener: (event: AgentEvent) => void) {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    abort: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as Session;

  return {
    session,
    send,
    setModel,
    setEffort,
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
} {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  } as never;
}

function heartbeatSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-hb',
    name: 'PR #971 心跳',
    prompt: 'PR #971 heartbeat prompt',
    jobType: 'prompt',
    source: 'user',
    kind: 'cron',
    cronExpr: '*/10 * * * *',
    timezone: 'Asia/Hong_Kong',
    recurring: true,
    manual: false,
    agentKind: 'claude-code',
    workspaceKind: 'project',
    workingDir: '',
    useWorktree: false,
    notify: { desktop: true, feishu: false },
    status: 'active',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    targetSessionId: SESSION_ID,
    silentWhenIdle: true,
    ...overrides,
  } as Schedule;
}

function createFireContext(): FireContext & { abortController: AbortController } {
  const abortController = new AbortController();
  return {
    runId: 'run-q1',
    firedAt: 1_700_000_000_100,
    signal: abortController.signal,
    onSessionBound: vi.fn(async () => undefined),
    onTurnActive: vi.fn(),
    abortController,
  } as never;
}

function enqueueLast(queue: QueueHarness): Parameters<SchedulerQueueDeps['enqueuePrompt']>[0] {
  const last = queue.enqueueCalls.at(-1);
  if (!last) throw new Error('no enqueue call recorded');
  return last;
}

interface QueueHarness {
  deps: SchedulerQueueDeps;
  enqueueCalls: Array<Parameters<SchedulerQueueDeps['enqueuePrompt']>[0]>;
  removeCalls: Array<{ sessionId: string; clientId: string }>;
  /** 模拟 drain 派发:触发最近一次入队项的 onAccepted。 */
  accept(): Promise<void>;
  /** 模拟排队项被丢弃(用户删除 / abort 撤项)。 */
  discard(): void;
}

function createQueueHarness(opts: {
  busy: boolean;
  hasQueued?: boolean;
  /** enqueuePrompt 返回 duplicate(权威去重命中,如恢复快照后发现同任务项)。 */
  enqueueDuplicate?: boolean;
  /** enqueuePrompt 返回 retry(崩溃恢复快照未成功读回,去重做不了)。 */
  enqueueRetry?: boolean;
  /** remove 时是否触发 onDiscarded(默认 true;false 模拟项已转 recovery 的 no-op)。 */
  removeTriggersDiscard?: boolean;
  /** isPromptTracked 的返回(默认 true)。 */
  tracked?: () => boolean;
}): QueueHarness {
  const enqueueCalls: QueueHarness['enqueueCalls'] = [];
  const removeCalls: QueueHarness['removeCalls'] = [];
  return {
    enqueueCalls,
    removeCalls,
    deps: {
      isSessionBusy: () => opts.busy,
      hasQueuedPrompt: () => opts.hasQueued ?? false,
      enqueuePrompt: vi.fn(async (req) => {
        if (opts.enqueueRetry) return { retry: true as const };
        if (opts.enqueueDuplicate) return { duplicate: true as const };
        enqueueCalls.push(req);
        return { clientId: `client-${enqueueCalls.length}` };
      }),
      removeQueuedPrompt: (sessionId, clientId) => {
        removeCalls.push({ sessionId, clientId });
        // 与真实 coordinator.remove 对齐:pending 项被移除触发 onDiscarded;
        // 项已转 activeTurn/recovery 时 remove 是 no-op(removeTriggersDiscard=false)。
        if (opts.removeTriggersDiscard !== false) {
          enqueueCalls.at(-1)?.onDiscarded?.();
        }
      },
      isPromptTracked: () => (opts.tracked ? opts.tracked() : true),
    },
    async accept() {
      await enqueueCalls.at(-1)?.onAccepted();
    },
    discard() {
      enqueueCalls.at(-1)?.onDiscarded?.();
    },
  };
}

function createRunnerHarness(
  session: Session,
  schedulerQueue: SchedulerQueueDeps,
  opts: {
    availableModels?: Array<{ id: string; efforts?: readonly string[]; defaultEffort?: string | null }>;
    /** 绑定会话 meta 里的 effort(= 排队路径的 baseline.effort);默认 undefined。 */
    metaEffort?: string;
  } = {},
) {
  const logger = createLogger();
  const notifier: Notifier & { notify: ReturnType<typeof vi.fn> } = {
    notify: vi.fn(async () => undefined),
  };
  const maker = {
    createSession: vi.fn(async () => session),
    getSession: vi.fn(() => session),
    getSessionMeta: vi.fn(async () => ({
      id: SESSION_ID,
      agentKind: 'claude-code',
      workDir: '/tmp/bound',
      model: 'claude-opus-4-6',
      effort: opts.metaEffort,
      sdkSessionId: 'sdk-1',
    })),
    isSessionAlive: vi.fn(() => true),
    closeSession: vi.fn(async () => undefined),
    // issue #456:排队派发路径也按所选模型 efforts reconcile effort;测试经 availableModels 注入能力。
    getCapabilities: vi.fn((_agent: string) => ({ availableModels: opts.availableModels ?? [] })),
  } as unknown as Maker;
  const runner = new MakerScheduleRunner({
    maker,
    getDb: () => ({}) as never,
    notifier,
    logger,
    schedulerQueue,
  });
  return { runner, logger, notifier, maker };
}

function latestNotifiedRun(notifier: Notifier & { notify: ReturnType<typeof vi.fn> }): ScheduleRun {
  return notifier.notify.mock.calls.at(-1)?.[1] as ScheduleRun;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionRowSnapshot.mockResolvedValue({
    status: 'active',
    userSendAt: null,
    providerId: null,
  });
});

describe('MakerScheduleRunner queued dispatch (busy bound session)', () => {
  it('enqueues instead of sending directly; captures turn result after dispatch', async () => {
    const harness = createSessionHarness(async () => ({ accepted: true }));
    const queue = createQueueHarness({ busy: true });
    const { runner, notifier } = createRunnerHarness(harness.session, queue.deps);

    const firePromise = runner.fire(heartbeatSchedule(), createFireContext());

    // 入队参数:发送正文带静默协议后缀,落库/展示用原始 prompt,origin=scheduler。
    await vi.waitFor(() => expect(queue.enqueueCalls.length).toBe(1));
    const req = queue.enqueueCalls[0]!;
    expect(req.sessionId).toBe(SESSION_ID);
    expect(req.text).toContain('PR #971 heartbeat prompt');
    expect(req.text).toContain('[Silent scheduled run]');
    expect(req.persistedContent).toBe('PR #971 heartbeat prompt');
    expect(req.origin).toEqual({
      kind: 'scheduler',
      scheduleId: 'schedule-hb',
      scheduleName: 'PR #971 心跳',
      runId: 'run-q1',
    });
    // 不直发、不自行落库(coordinator drain 负责)。
    expect(harness.send).not.toHaveBeenCalled();
    expect(mocks.createMessage).not.toHaveBeenCalled();
    // 排队等待仍属于当前 Desktop turn，不能被未来的 scheduler turn
    // 提前标成 headless，否则当前 turn 的插件设置卡会被错误抑制。
    expect(isHeadlessGhostSetupTurn(SESSION_ID)).toBe(false);

    // drain 派发 → runner 挂 turn 监听 → done 收尾。
    await queue.accept();
    await vi.waitFor(() => expect(harness.listenerCount()).toBe(1));
    expect(isHeadlessGhostSetupTurn(SESSION_ID)).toBe(true);
    harness.emit({ type: 'text', data: { text: 'heartbeat summary', isFinal: true }, source: 'claude-code' });
    harness.emit({ type: 'done', data: {}, source: 'claude-code' });

    const result = await firePromise;
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.resultText).toBe('heartbeat summary');
    // listener 已摘干净,不泄漏。
    expect(harness.listenerCount()).toBe(0);
    expect(isHeadlessGhostSetupTurn(SESSION_ID)).toBe(false);
    // 收尾通知照常(未静默场景)。
    expect(latestNotifiedRun(notifier)).toMatchObject({ status: 'success' });
  });

  it('defers (no duplicate enqueue) when the schedule already has a queued prompt', async () => {
    const harness = createSessionHarness(async () => ({ accepted: true }));
    const queue = createQueueHarness({ busy: true, hasQueued: true });
    const { runner } = createRunnerHarness(harness.session, queue.deps);

    const result = await runner.fire(heartbeatSchedule(), createFireContext());
    expect(result).toMatchObject({ deferred: true });
    expect(queue.enqueueCalls.length).toBe(0);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('settles the run as aborted-style failure when the queued prompt is discarded', async () => {
    const harness = createSessionHarness(async () => ({ accepted: true }));
    const queue = createQueueHarness({ busy: true });
    const { runner } = createRunnerHarness(harness.session, queue.deps);

    const firePromise = runner.fire(heartbeatSchedule(), createFireContext());
    await vi.waitFor(() => expect(queue.enqueueCalls.length).toBe(1));
    queue.discard();

    await expect(firePromise).rejects.toThrow(/aborted/i);
    expect(harness.listenerCount()).toBe(0);
    expect(isHeadlessGhostSetupTurn(SESSION_ID)).toBe(false);
  });

  it('removes the queued prompt when ctx.signal aborts while waiting', async () => {
    const harness = createSessionHarness(async () => ({ accepted: true }));
    const queue = createQueueHarness({ busy: true });
    const { runner } = createRunnerHarness(harness.session, queue.deps);
    const ctx = createFireContext();

    const firePromise = runner.fire(heartbeatSchedule(), ctx);
    await vi.waitFor(() => expect(queue.enqueueCalls.length).toBe(1));
    ctx.abortController.abort();

    await expect(firePromise).rejects.toThrow(/aborted/i);
    expect(queue.removeCalls).toEqual([{ sessionId: SESSION_ID, clientId: 'client-1' }]);
    expect(isHeadlessGhostSetupTurn(SESSION_ID)).toBe(false);
  });

  it('defers when enqueuePrompt reports an authoritative duplicate (restored snapshot)', async () => {
    // 快路径 hasQueuedPrompt 没看到(重启后内存队列空),恢复快照后 enqueuePrompt
    // 权威去重命中 → 与快路径同语义顺延,不留双份排队项(review P1)。
    const harness = createSessionHarness(async () => ({ accepted: true }));
    const queue = createQueueHarness({ busy: true, enqueueDuplicate: true });
    const { runner } = createRunnerHarness(harness.session, queue.deps);

    const result = await runner.fire(heartbeatSchedule(), createFireContext());
    expect(result).toMatchObject({ deferred: true });
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('unblocks the dispatch wait on abort even when remove cannot trigger onDiscarded', async () => {
    // 排队项已转入 activeTurn/recovery 时 removeQueuedPrompt 是 no-op(无 onDiscarded
    // 回调),abort 必须直接解锁派发等待,否则 pause/delete 后 run 永久挂 running。
    const harness = createSessionHarness(async () => ({ accepted: true }));
    const queue = createQueueHarness({ busy: true, removeTriggersDiscard: false });
    const { runner } = createRunnerHarness(harness.session, queue.deps);
    const ctx = createFireContext();

    const firePromise = runner.fire(heartbeatSchedule(), ctx);
    await vi.waitFor(() => expect(queue.enqueueCalls.length).toBe(1));
    ctx.abortController.abort();

    await expect(firePromise).rejects.toThrow(/abort/i);
    expect(queue.removeCalls.length).toBe(1);
  });

  it('fails the run when the queued prompt silently disappears from the coordinator', async () => {
    // 存活探测:coordinator 的静默放弃路径(新输入顶掉 recovery / 清会话)不发
    // onDiscarded,靠轮询发现项消失后按失败收口,防 run 永久挂起(review P1)。
    vi.useFakeTimers();
    try {
      const harness = createSessionHarness(async () => ({ accepted: true }));
      let tracked = true;
      const queue = createQueueHarness({ busy: true, tracked: () => tracked });
      const { runner } = createRunnerHarness(harness.session, queue.deps);

      const firePromise = runner.fire(heartbeatSchedule(), createFireContext());
      const rejection = expect(firePromise).rejects.toThrow(/dropped before dispatch/i);
      await vi.waitFor(() => expect(queue.enqueueCalls.length).toBe(1));

      tracked = false;
      await vi.advanceTimersByTimeAsync(61_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers when the crash-recovery snapshot has not been restored yet (retry result)', async () => {
    // 恢复快照读回失败期间不能做持久化去重 → 不入队,顺延本次 fire(review P1)。
    const harness = createSessionHarness(async () => ({ accepted: true }));
    const queue = createQueueHarness({ busy: true, enqueueRetry: true });
    const { runner } = createRunnerHarness(harness.session, queue.deps);

    const result = await runner.fire(heartbeatSchedule(), createFireContext());
    expect(result).toMatchObject({ deferred: true });
    expect(queue.enqueueCalls.length).toBe(0);
    expect(harness.send).not.toHaveBeenCalled();
  });

  it('aborts the late-dispatched turn when accept lands after schedule pause/delete', async () => {
    // abort 撞上"项已转 activeTurn、尚未 accept"的窗口:removeQueuedPrompt 是
    // no-op,coordinator 仍会把 turn 发出去 —— accept 时刻必须补杀刚起步的 turn,
    // 不让已暂停/删除的任务继续执行(review P2)。
    const harness = createSessionHarness(async () => ({ accepted: true }));
    const queue = createQueueHarness({ busy: true, removeTriggersDiscard: false });
    const { runner, maker } = createRunnerHarness(harness.session, queue.deps);
    const ctx = createFireContext();

    const firePromise = runner.fire(heartbeatSchedule(), ctx);
    await vi.waitFor(() => expect(queue.enqueueCalls.length).toBe(1));
    ctx.abortController.abort();
    await expect(firePromise).rejects.toThrow(/abort/i);

    // coordinator 稍后仍完成了派发(accept 晚到)→ 刚起步的 turn 被立即中断。
    await queue.accept();
    expect((maker as unknown as { getSession: () => Session }).getSession).toBeDefined();
    expect((harness.session as unknown as { abort: ReturnType<typeof vi.fn> }).abort).toHaveBeenCalled();
    // 不再挂 turn 监听(run 已收口)。
    expect(harness.listenerCount()).toBe(0);
    expect(isHeadlessGhostSetupTurn(SESSION_ID)).toBe(false);
  });

  it('applies schedule model override to the live session at dispatch-accept time', async () => {
    // 任务编辑器选的模型在排队派发时刻热同步(accept 回调运行于 vendor dispatch
    // 之前,setModel 对本 turn 生效),不再被排队轮静默忽略(review P2)。
    const harness = createSessionHarness(async () => ({ accepted: true }));
    const queue = createQueueHarness({ busy: true });
    const { runner } = createRunnerHarness(harness.session, queue.deps);

    const firePromise = runner.fire(
      heartbeatSchedule({ model: 'claude-opus-4-8' }),
      createFireContext(),
    );
    await vi.waitFor(() => expect(queue.enqueueCalls.length).toBe(1));
    await queue.accept();
    expect(harness.setModel).toHaveBeenCalledWith('claude-opus-4-8');
    expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_ID,
      expect.objectContaining({ model: 'claude-opus-4-8' }),
      expect.anything(),
    );

    harness.emit({ type: 'done', data: {}, source: 'claude-code' });
    await expect(firePromise).resolves.toMatchObject({ sessionId: SESSION_ID });
  });

  it('leaves session routing untouched when the schedule has no explicit model', async () => {
    const harness = createSessionHarness(async () => ({ accepted: true }));
    const queue = createQueueHarness({ busy: true });
    const { runner } = createRunnerHarness(harness.session, queue.deps);

    const firePromise = runner.fire(heartbeatSchedule(), createFireContext());
    await vi.waitFor(() => expect(queue.enqueueCalls.length).toBe(1));
    await queue.accept();
    expect(harness.setModel).not.toHaveBeenCalled();

    harness.emit({ type: 'done', data: {}, source: 'claude-code' });
    await expect(firePromise).resolves.toMatchObject({ sessionId: SESSION_ID });
  });

  it('fails the run (no hang) when dispatch is rolled back after accept', async () => {
    // accepted 之后 send 结局为未派发(cancelled-before-dispatch / 持久化后取消):
    // register 的 sendToAgent 包装层保证调用 onAcceptedRollback —— runner 经
    // postAcceptFailed 通道收口为失败,不会挂在 turnFinished 上(review P1 佐证)。
    const harness = createSessionHarness(async () => ({ accepted: true }));
    const queue = createQueueHarness({ busy: true });
    const { runner } = createRunnerHarness(harness.session, queue.deps);

    const firePromise = runner.fire(heartbeatSchedule(), createFireContext());
    await vi.waitFor(() => expect(queue.enqueueCalls.length).toBe(1));
    await queue.accept();
    enqueueLast(queue).onAcceptedRollback?.();

    await expect(firePromise).rejects.toThrow(/rolled back after accept/i);
    expect(harness.listenerCount()).toBe(0);
    expect(isHeadlessGhostSetupTurn(SESSION_ID)).toBe(false);
  });

  it('re-applies the schedule model when the live session model drifted while queued', async () => {
    // 排队等待期间用户在聊天里切了模型:路由比较必须以派发时刻的 live.model 为
    // 基准,schedule 显式选择仍要覆盖回来(review P2)。
    const harness = createSessionHarness(async () => ({ accepted: true }));
    const queue = createQueueHarness({ busy: true });
    const { runner } = createRunnerHarness(harness.session, queue.deps);

    // schedule.model 与 fire 时刻的 meta.model 相同(claude-opus-4-6)……
    const firePromise = runner.fire(
      heartbeatSchedule({ model: 'claude-opus-4-6' }),
      createFireContext(),
    );
    await vi.waitFor(() => expect(queue.enqueueCalls.length).toBe(1));
    // ……但排队期间用户把会话切到了别的模型。
    (harness.session as unknown as { model: string }).model = 'claude-sonnet-5';
    await queue.accept();
    expect(harness.setModel).toHaveBeenCalledWith('claude-opus-4-6');

    harness.emit({ type: 'done', data: {}, source: 'claude-code' });
    await expect(firePromise).resolves.toMatchObject({ sessionId: SESSION_ID });
  });

  it('clamps the queued heartbeat effort to model capability before setEffort / backfill (issue #456)', async () => {
    // 忙会话最常走的排队分支:schedule.effort=max 但绑定模型仅到 xhigh → 派发时刻
    // 必须 clamp 到 xhigh 再 setEffort,不把模型不支持的档透给上游(直发路径的 reconcile
    // 在此分支之前 return、覆盖不到,#456 回归点)。
    const harness = createSessionHarness(async () => ({ accepted: true }));
    const queue = createQueueHarness({ busy: true });
    const { runner } = createRunnerHarness(harness.session, queue.deps, {
      availableModels: [
        { id: 'claude-opus-4-6', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
      ],
    });

    // model 与 baseline(meta.model=claude-opus-4-6)相同 → 不触发 setModel,隔离 effort 断言。
    const firePromise = runner.fire(
      heartbeatSchedule({ model: 'claude-opus-4-6', effort: 'max' }),
      createFireContext(),
    );
    await vi.waitFor(() => expect(queue.enqueueCalls.length).toBe(1));
    await queue.accept();

    expect(harness.setEffort).toHaveBeenCalledWith('xhigh');
    expect(harness.setEffort).not.toHaveBeenCalledWith('max');
    expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
      expect.anything(),
      SESSION_ID,
      expect.objectContaining({ effort: 'xhigh' }),
      expect.anything(),
    );

    harness.emit({ type: 'done', data: {}, source: 'claude-code' });
    await expect(firePromise).resolves.toMatchObject({ sessionId: SESSION_ID });
  });

  it('keeps a supported queued heartbeat effort unchanged (no downgrade, #352)', async () => {
    const harness = createSessionHarness(async () => ({ accepted: true }));
    const queue = createQueueHarness({ busy: true });
    const { runner } = createRunnerHarness(harness.session, queue.deps, {
      availableModels: [
        { id: 'claude-opus-4-6', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
      ],
    });

    const firePromise = runner.fire(
      heartbeatSchedule({ model: 'claude-opus-4-6', effort: 'high' }),
      createFireContext(),
    );
    await vi.waitFor(() => expect(queue.enqueueCalls.length).toBe(1));
    await queue.accept();

    // high 受支持 → 原样下发,不被 clamp 改动。
    expect(harness.setEffort).toHaveBeenCalledWith('high');

    harness.emit({ type: 'done', data: {}, source: 'claude-code' });
    await expect(firePromise).resolves.toMatchObject({ sessionId: SESSION_ID });
  });

  it('clamps queued effort to the running model when setModel fails (PR #479 review)', async () => {
    // 排队派发时 setModel 被拒 → turn 仍停在 live.model(claude-opus-4-6,桩里支持 max);
    // effort 必须按 live.model clamp = max,而不是按没切成功的 targetModel(仅到 xhigh)。
    const harness = createSessionHarness(async () => ({ accepted: true }));
    harness.setModel.mockRejectedValue(new Error('switchModel rejected'));
    const queue = createQueueHarness({ busy: true });
    const { runner } = createRunnerHarness(harness.session, queue.deps, {
      availableModels: [
        { id: 'claude-opus-4-6', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
        { id: 'capped-xhigh-model', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
      ],
    });

    const firePromise = runner.fire(
      heartbeatSchedule({ model: 'capped-xhigh-model', effort: 'max' }),
      createFireContext(),
    );
    await vi.waitFor(() => expect(queue.enqueueCalls.length).toBe(1));
    await queue.accept();

    expect(harness.setModel).toHaveBeenCalledWith('capped-xhigh-model'); // 尝试切(被拒)
    // live.model 仍是 claude-opus-4-6(支持 max)→ effort 按它 clamp = max,不套用 targetModel 的 xhigh。
    expect(harness.setEffort).toHaveBeenCalledWith('max');
    expect(harness.setEffort).not.toHaveBeenCalledWith('xhigh');

    harness.emit({ type: 'done', data: {}, source: 'claude-code' });
    await expect(firePromise).resolves.toMatchObject({ sessionId: SESSION_ID });
  });

  it('clamps follow-session queued effort to the drifted live model, not the stale baseline (PR #479 review)', async () => {
    // follow-session:schedule 无显式 model(沿用会话模型)但覆盖 effort=max。排队等待期间用户
    // 把会话切到只到 xhigh 的模型 → 本轮不 setModel、turn 跑在 live.model。effort 必须按 live.model
    // clamp(=xhigh),而不是按 enqueue 时的陈旧 baseline 模型(仍支持 max)—— 否则 max 透给已 capped
    // 的实际运行模型被上游拒。
    const harness = createSessionHarness(async () => ({ accepted: true }));
    const queue = createQueueHarness({ busy: true });
    const { runner } = createRunnerHarness(harness.session, queue.deps, {
      availableModels: [
        { id: 'claude-opus-4-6', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
        { id: 'capped-xhigh-model', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
      ],
    });

    // 无显式 model(follow-session),仅覆盖 effort=max。
    const firePromise = runner.fire(heartbeatSchedule({ effort: 'max' }), createFireContext());
    await vi.waitFor(() => expect(queue.enqueueCalls.length).toBe(1));
    // 排队期间用户把会话切到 capped 模型。
    (harness.session as unknown as { model: string }).model = 'capped-xhigh-model';
    await queue.accept();

    expect(harness.setModel).not.toHaveBeenCalled(); // 无显式 model → 不切
    // runtimeModel 取 live.model(capped-xhigh-model)→ max clamp 到 xhigh,不套用陈旧 baseline 的 max。
    expect(harness.setEffort).toHaveBeenCalledWith('xhigh');
    expect(harness.setEffort).not.toHaveBeenCalledWith('max');

    harness.emit({ type: 'done', data: {}, source: 'claude-code' });
    await expect(firePromise).resolves.toMatchObject({ sessionId: SESSION_ID });
  });

  it('does not clamp/apply a followed effort from the stale enqueue-time baseline (PR #479 review)', async () => {
    // follow-effort(schedule.effort 留空)+ 显式换 model 到 capped:排队路径不能拿 enqueue 时刻的
    // baseline.effort(可能已被用户在等待期改过)去 clamp 后 setEffort —— 会覆盖用户的新选择。
    // 无 live effort getter 拿不到当前真实值 → 遵循「follow 且当前值不可知 → 不动 effort」→ 不 setEffort。
    const harness = createSessionHarness(async () => ({ accepted: true }));
    const queue = createQueueHarness({ busy: true });
    const { runner } = createRunnerHarness(harness.session, queue.deps, {
      metaEffort: 'max', // enqueue 时刻 baseline.effort = max(陈旧)
      availableModels: [
        { id: 'claude-opus-4-6', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
        { id: 'capped-xhigh-model', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
      ],
    });

    // 换 model(显式)到 capped,但 effort 留空(follow)。
    const firePromise = runner.fire(
      heartbeatSchedule({ model: 'capped-xhigh-model' }),
      createFireContext(),
    );
    await vi.waitFor(() => expect(queue.enqueueCalls.length).toBe(1));
    await queue.accept();

    expect(harness.setModel).toHaveBeenCalledWith('capped-xhigh-model'); // 显式 model 照常切
    // effort 留空(follow)→ 不拿陈旧 baseline(max)clamp 出 xhigh 硬塞给会话,setEffort 完全不调。
    expect(harness.setEffort).not.toHaveBeenCalled();

    harness.emit({ type: 'done', data: {}, source: 'claude-code' });
    await expect(firePromise).resolves.toMatchObject({ sessionId: SESSION_ID });
  });

  it('reapplies explicit queued effort even when the clamp equals the stale baseline (PR #479 review)', async () => {
    // 显式 effort=max 在 capped 模型上 clamp 成 xhigh,恰好 == 上一次 fire 已 backfill 的 baseline.effort。
    // 不能因「== baseline」就 skip:baseline 是 enqueue 时刻快照,用户可能在排队期把 live effort 调低;
    // 显式档必须每次派发都重申(setEffort 幂等),否则这一 turn 会跑用户的低档而非 schedule 的显式档。
    const harness = createSessionHarness(async () => ({ accepted: true }));
    const queue = createQueueHarness({ busy: true });
    const { runner } = createRunnerHarness(harness.session, queue.deps, {
      metaEffort: 'xhigh', // baseline.effort = 上次 fire backfill 的 clamp 值
      availableModels: [
        { id: 'claude-opus-4-6', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
        { id: 'capped-xhigh-model', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
      ],
    });

    const firePromise = runner.fire(
      heartbeatSchedule({ model: 'capped-xhigh-model', effort: 'max' }), // 显式 model + 显式 effort
      createFireContext(),
    );
    await vi.waitFor(() => expect(queue.enqueueCalls.length).toBe(1));
    await queue.accept();

    expect(harness.setModel).toHaveBeenCalledWith('capped-xhigh-model');
    // 显式 effort clamp 成 xhigh,即便 == baseline 也重申一遍,不被陈旧比较 skip。
    expect(harness.setEffort).toHaveBeenCalledWith('xhigh');

    harness.emit({ type: 'done', data: {}, source: 'claude-code' });
    await expect(firePromise).resolves.toMatchObject({ sessionId: SESSION_ID });
  });

  it('keeps the direct-send path when the bound session is idle', async () => {
    const harness = createSessionHarness(async (_message, opts) => {
      await opts?.onAccepted?.();
      return { accepted: true };
    });
    const queue = createQueueHarness({ busy: false });
    const { runner } = createRunnerHarness(harness.session, queue.deps);

    const firePromise = runner.fire(heartbeatSchedule(), createFireContext());
    await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(1));
    expect(queue.enqueueCalls.length).toBe(0);
    harness.emit({ type: 'done', data: {}, source: 'claude-code' });
    await expect(firePromise).resolves.toMatchObject({ sessionId: SESSION_ID });
  });
});
