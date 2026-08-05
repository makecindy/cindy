/**
 * MakerScheduleRunner 模型选择回归测试。
 *
 * 背景（2026-06 实际线上踩坑）：
 *   1. 任务编辑器空 model 时 UI 显示 availableModels[0]（Opus 4.8），但 runner 的
 *      defaultModelFor 兜底硬编码成了上一代（Opus 4.7）—— 用户"看着选了 4.8 实际跑 4.7"。
 *   2. heartbeat（持续会话）模式 runner 只读绑定 session 的 meta.model，schedule.model
 *      被静默忽略 —— 用户在任务里改模型永远不生效。
 *
 * 防回归点：
 *   - 非 heartbeat：schedule.model 透传；空时兜底 claude-sonnet-4-6 / gpt-5.5
 *     （成本保守,故意不跟对话的 Opus 默认;必须与 renderer useScheduleForm.ts
 *     schedulerFallbackModel 同步）。
 *   - heartbeat：schedule.model 显式设置时优先于 meta.model，并通过 session.setModel
 *     同步给运行时（覆盖 maker.createSession 复用 active session 忽略 opts.model 的路径）
 *     + backfillSessionMeta 落库；schedule.model 留空才沿用 meta.model，且不触发 setModel。
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
} from '@cindy/maker-scheduler';

const mocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
  getSessionRowSnapshot: vi.fn(),
  ensureDialogueWorkspaceDir: vi.fn(),
  wireSessionToIpc: vi.fn(),
  resolveWorkingDir: vi.fn(),
  backfillSessionMeta: vi.fn(),
  getSessionProvider: vi.fn(),
  setSessionProvider: vi.fn(),
  hydrateSessionProvider: vi.fn(),
  isSessionInTurn: vi.fn(),
}));

vi.mock('../../maker-host/session-provider-store.js', () => ({
  getSessionProvider: mocks.getSessionProvider,
  setSessionProvider: mocks.setSessionProvider,
  hydrateSessionProvider: mocks.hydrateSessionProvider,
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

type SessionSendOptions = Parameters<Session['send']>[1];
type SendImpl = (
  message: Parameters<Session['send']>[0],
  opts?: SessionSendOptions,
) => Promise<SessionSendResult>;

interface FakeSessionHarness {
  session: Session;
  send: ReturnType<typeof vi.fn<SendImpl>>;
  setModel: ReturnType<typeof vi.fn>;
  setEffort: ReturnType<typeof vi.fn>;
  emit(event: AgentEvent): void;
}

function createSessionHarness(): FakeSessionHarness {
  const listeners: Array<(event: AgentEvent) => void> = [];
  const send = vi.fn<SendImpl>(async (_message, opts) => {
    await opts?.onAccepted?.();
    return { accepted: true };
  });
  // setModel 声明 string 入参(签名与真实 Session.setModel 一致),下面 mockImplementation 才能
  // 按 (m) 更新 session.model;测试可再用 mockRejectedValue / mockImplementation 覆盖。
  const setModel = vi.fn(async (_m: string): Promise<void> => {});
  const setEffort = vi.fn(async () => undefined);
  const session = {
    id: 'scheduler-session',
    agentKind: 'claude-code',
    model: 'claude-sonnet-4-6',
    remoteHostId: null,
    send,
    setModel,
    setEffort,
    onEvent(listener: (event: AgentEvent) => void) {
      listeners.push(listener);
      return () => {
        listeners.splice(0, listeners.length);
      };
    },
    abort: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as Session;

  // 忠实镜像真实 Session:`get model()` 随 setModel 成功更新 handle.model。runner 现按 live
  // session.model(而非 getSessionMeta 快照)确定复用会话实际在跑的模型,harness 必须同样更新。
  // 需要模拟"setModel 抛错"的用例用 mockRejectedValue 覆盖本实现(reject → 不更新 = Claude 语义);
  // 模拟 Codex"await 前先改 model 再抛"的用例用 mockImplementation 显式先改 model 再 throw。
  setModel.mockImplementation(async (m: string) => {
    (session as { model: string }).model = m;
  });

  return {
    session,
    send,
    setModel,
    setEffort,
    emit(event: AgentEvent) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function createLogger(): Logger {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
}

function baseSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    name: 'model selection test',
    prompt: 'do the thing',
    jobType: 'prompt',
    source: 'user',
    kind: 'cron',
    cronExpr: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    agentKind: 'claude-code',
    workspaceKind: 'project',
    workingDir: '/work',
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

interface RunnerHarness {
  runner: MakerScheduleRunner;
  createSession: ReturnType<typeof vi.fn>;
  closeSession: ReturnType<typeof vi.fn>;
}

function createRunnerHarness(
  h: FakeSessionHarness,
  meta: { model?: string; effort?: string; workDir?: string; sdkSessionId?: string } | null = null,
  opts: {
    sessionAlive?: boolean;
    activeSessions?: Session[];
    availableModels?: Array<{ id: string; efforts?: readonly string[]; defaultEffort?: string | null }>;
    checkModelRoute?: ConstructorParameters<typeof MakerScheduleRunner>[0]['checkModelRoute'];
    resolveRouteCopyCapabilities?: ConstructorParameters<
      typeof MakerScheduleRunner
    >[0]['resolveRouteCopyCapabilities'];
  } = {},
): RunnerHarness {
  const createSession = vi.fn(async () => h.session);
  const closeSession = vi.fn(async () => undefined);
  const maker = {
    createSession,
    getSessionMeta: vi.fn(async () => meta),
    getSession: vi.fn(() => h.session),
    listActiveSessions: vi.fn(() => opts.activeSessions ?? [h.session]),
    closeSession,
    // issue #456:runner fire 时按所选模型 efforts reconcile effort;测试经 availableModels 注入能力。
    getCapabilities: vi.fn((_agent: string) => ({ availableModels: opts.availableModels ?? [] })),
    // 默认 false = fresh spawn（opts.model/effort 已生效）；true 模拟进程内
    // 复用 active session 的路径（createSession 忽略 opts, setModel/setEffort 是唯一通道）。
    isSessionAlive: vi.fn(() => opts.sessionAlive ?? false),
  } as unknown as Maker;
  const notifier: Notifier = { notify: vi.fn(async () => undefined) };
  const runner = new MakerScheduleRunner({
    maker,
    getDb: () => ({}) as never,
    notifier,
    logger: createLogger(),
    checkModelRoute: opts.checkModelRoute,
    resolveRouteCopyCapabilities: opts.resolveRouteCopyCapabilities,
  });
  return { runner, createSession, closeSession };
}

/** 跑完整个 fire：等 send 被调用后 emit done，返回 createSession 收到的 opts。 */
async function fireToCompletion(
  harness: RunnerHarness,
  h: FakeSessionHarness,
  schedule: Schedule,
): Promise<{ model: string; effort?: string }> {
  const firePromise = harness.runner.fire(schedule, createFireContext());
  await vi.waitFor(() => expect(h.send).toHaveBeenCalled());
  h.emit({ type: 'done', data: {} });
  await firePromise;
  return harness.createSession.mock.calls[0][0] as { model: string; effort?: string };
}

describe('MakerScheduleRunner model selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMessage.mockResolvedValue(undefined);
    mocks.backfillSessionMeta.mockResolvedValue(undefined);
    mocks.resolveWorkingDir.mockResolvedValue({ ok: true, path: '/work' });
    mocks.getSessionProvider.mockReturnValue(null);
    mocks.isSessionInTurn.mockReturnValue(false);
    mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active' });
  });

  describe('effort reconcile —— fire 时按所选模型能力 clamp(issue #456)', () => {
    it('超额档(gpt-5.5 只到 xhigh + effort=max)→ createSession 收到 clamp 后的 xhigh', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h, null, {
        availableModels: [{ id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' }],
      });
      const opts = await fireToCompletion(
        harness,
        h,
        baseSchedule({ agentKind: 'codex', model: 'gpt-5.5', effort: 'max' }),
      );
      expect(opts.effort).toBe('xhigh');
    });

    it('R27:隐式改道后按落地拷贝 reconcile —— effort clamp 到拷贝档、Fast 不支持即清', async () => {
      // merged capability 支持 max,但改道后的 anthropic 拷贝只到 high 且不支持 Fast:
      // createSession 必须收到 (effort=high, fastMode=false, providerId=anthropic)。
      // provider store mock 做成有状态:fire 入口改道后 4.4.2 会 setSessionProvider,
      // 派发前重裁决读到它 ⇒ pass,不再二次改道。
      let storedProvider: string | null = null;
      mocks.setSessionProvider.mockImplementation((_id: string, pid: string | null) => {
        storedProvider = pid;
      });
      mocks.getSessionProvider.mockImplementation(() => storedProvider);
      const h = createSessionHarness();
      const harness = createRunnerHarness(h, null, {
        availableModels: [
          { id: 'gpt-5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
        ],
        checkModelRoute: vi.fn(async (_a, _m, providerId) =>
          providerId ? { kind: 'pass' as const } : { kind: 'reroute' as const, providerId: 'anthropic' },
        ),
        resolveRouteCopyCapabilities: vi.fn(async () => ({
          efforts: ['low', 'medium', 'high'],
          defaultEffort: 'high',
          supportsFastMode: false,
        })),
      });
      const opts = await fireToCompletion(
        harness,
        h,
        baseSchedule({ agentKind: 'codex', model: 'gpt-5.5', effort: 'max', fastMode: true }),
      );
      expect(opts).toMatchObject({ effort: 'high', fastMode: false, providerId: 'anthropic' });
    });

    it('模型支持该档(gpt-5.6-sol + effort=ultra)→ 原样透传,不降级(保 #352)', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h, null, {
        availableModels: [
          { id: 'gpt-5.6-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'high' },
        ],
      });
      const opts = await fireToCompletion(
        harness,
        h,
        baseSchedule({ agentKind: 'codex', model: 'gpt-5.6-sol', effort: 'ultra' }),
      );
      expect(opts.effort).toBe('ultra');
    });
  });

  describe('non-heartbeat (每次新建 session)', () => {
    it('schedule.model 留空时 Claude 兜底 claude-sonnet-4-6（成本保守,与 UI 空值回退一致）', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h);

      const opts = await fireToCompletion(harness, h, baseSchedule({ model: undefined }));

      expect(opts.model).toBe('claude-sonnet-4-6');
    });

    it('schedule.model 留空时 Codex 兜底 gpt-5.5', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h);

      const opts = await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: undefined, agentKind: 'codex' }),
      );

      expect(opts.model).toBe('gpt-5.5');
    });

    it('schedule.model 显式设置时原样透传', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h);

      const opts = await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: 'claude-sonnet-4-6' }),
      );

      expect(opts.model).toBe('claude-sonnet-4-6');
      expect(h.setModel).not.toHaveBeenCalled();
    });
  });

  describe('heartbeat (持续会话绑定)', () => {
    const HEARTBEAT_META = {
      model: 'claude-opus-4-7',
      effort: 'high',
      workDir: '/work',
      sdkSessionId: 'sdk-1',
    };

    it('schedule.model 显式设置时优先于绑定 session 的 meta.model，并同步给运行时 + 落库', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h, HEARTBEAT_META);

      const opts = await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: 'claude-opus-4-8', targetSessionId: 'scheduler-session' }),
      );

      expect(opts.model).toBe('claude-opus-4-8');
      // createSession 可能复用进程内 active session（忽略 opts.model），必须显式 setModel
      expect(h.setModel).toHaveBeenCalledWith('claude-opus-4-8');
      // sessions.model 落库，让 chat UI picker 与下次 fire 的 meta.model 一致
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ model: 'claude-opus-4-8' }),
        expect.anything(),
      );
    });

    it('schedule.model 留空时沿用 meta.model，不触发 setModel / model 落库', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h, HEARTBEAT_META);

      const opts = await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: undefined, targetSessionId: 'scheduler-session' }),
      );

      expect(opts.model).toBe('claude-opus-4-7');
      expect(h.setModel).not.toHaveBeenCalled();
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ model: undefined }),
        expect.anything(),
      );
    });

    it('schedule.model 与 meta.model 相同时不做多余的 setModel 同步', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h, HEARTBEAT_META);

      const opts = await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: 'claude-opus-4-7', targetSessionId: 'scheduler-session' }),
      );

      expect(opts.model).toBe('claude-opus-4-7');
      expect(h.setModel).not.toHaveBeenCalled();
    });

    it('setModel 失败不阻断 fire（非致命，fresh spawn 路径 opts.model 已生效）', async () => {
      const h = createSessionHarness();
      h.setModel.mockRejectedValue(new Error('switchModel not supported'));
      const harness = createRunnerHarness(h, HEARTBEAT_META);

      const opts = await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: 'claude-opus-4-8', targetSessionId: 'scheduler-session' }),
      );

      expect(opts.model).toBe('claude-opus-4-8');
      expect(h.send).toHaveBeenCalled();
      // fresh spawn 路径 opts.model 已在 createSession 生效, setModel 只是幂等兜底,
      // 失败也照常落库 —— meta 与实际运行一致。
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ model: 'claude-opus-4-8' }),
        expect.anything(),
      );
    });

    it('复用 active session 时 setModel 失败 → 跳过 model 落库, 下次 fire 可重试', async () => {
      // 反例锁定: 复用路径 createSession 忽略 opts.model, setModel 是唯一生效通道。
      // 失败仍落库的话 meta.model 变成新值 → 下次 fire 判定"无变化"不再 setModel,
      // 运行时永远停在旧 model 且 UI 显示新值（review thread: only persist after success）。
      const h = createSessionHarness();
      h.setModel.mockRejectedValue(new Error('transient RPC failure'));
      const harness = createRunnerHarness(h, HEARTBEAT_META, { sessionAlive: true });

      await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: 'claude-opus-4-8', targetSessionId: 'scheduler-session' }),
      );

      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ model: undefined }),
        expect.anything(),
      );
    });

    it('复用 active session 时 setEffort 失败 → 跳过 effort 落库, 下次 fire 可重试', async () => {
      const h = createSessionHarness();
      h.setEffort.mockRejectedValue(new Error('transient RPC failure'));
      const harness = createRunnerHarness(h, HEARTBEAT_META, { sessionAlive: true });

      await fireToCompletion(
        harness,
        h,
        baseSchedule({
          model: 'claude-opus-4-7', // 与 meta 相同, 不触发 model 同步
          effort: 'xhigh',
          targetSessionId: 'scheduler-session',
        }),
      );

      expect(h.setEffort).toHaveBeenCalledWith('xhigh');
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ effort: undefined }),
        expect.anything(),
      );
    });

    it('复用 active session 时 setModel / setEffort 成功 → 照常落库', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h, HEARTBEAT_META, { sessionAlive: true });

      await fireToCompletion(
        harness,
        h,
        baseSchedule({
          model: 'claude-opus-4-8',
          effort: 'xhigh',
          targetSessionId: 'scheduler-session',
        }),
      );

      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ model: 'claude-opus-4-8', effort: 'xhigh' }),
        expect.anything(),
      );
    });

    it('复用会话 + 超额 effort → setEffort / 落库用 clamp 后的档,不把超额档透给运行时(issue #456)', async () => {
      // heartbeat 直发路径的 reconcile 覆盖:meta.effort=high、schedule.effort=max,而
      // 绑定模型仅到 xhigh → setEffort 必须收 clamp 后的 xhigh(不是裸 max),落库同理。
      const h = createSessionHarness();
      // 复用会话实际在跑的模型 = live session.model(此用例无 setModel 切换,= meta.model)。
      (h.session as { model: string }).model = 'claude-opus-4-7';
      const harness = createRunnerHarness(h, HEARTBEAT_META, {
        sessionAlive: true,
        availableModels: [
          { id: 'claude-opus-4-7', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
        ],
      });

      await fireToCompletion(
        harness,
        h,
        baseSchedule({
          model: 'claude-opus-4-7', // 与 meta.model 相同,不触发 setModel,隔离 effort 断言
          effort: 'max',
          targetSessionId: 'scheduler-session',
        }),
      );

      expect(h.setEffort).toHaveBeenCalledWith('xhigh');
      expect(h.setEffort).not.toHaveBeenCalledWith('max');
      // 复用路径 setEffort 成功 → 落 clamp 后的实际运行值(session 行反映真跑的档)。
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ effort: 'xhigh' }),
        expect.anything(),
      );
    });

    it('复用会话 + 模型支持的 effort → 原样下发,不降级(保 #352,heartbeat 路径)', async () => {
      const h = createSessionHarness();
      // 复用会话实际在跑的模型 = live session.model(此用例无 setModel 切换,= meta.model)。
      (h.session as { model: string }).model = 'claude-opus-4-7';
      const harness = createRunnerHarness(h, HEARTBEAT_META, {
        sessionAlive: true,
        availableModels: [
          { id: 'claude-opus-4-7', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
        ],
      });

      await fireToCompletion(
        harness,
        h,
        baseSchedule({
          model: 'claude-opus-4-7',
          effort: 'xhigh', // 模型支持 → 不动
          targetSessionId: 'scheduler-session',
        }),
      );

      expect(h.setEffort).toHaveBeenCalledWith('xhigh');
    });

    it('复用会话 + setModel 失败 → effort 按仍在运行的旧模型 clamp,不套新模型的档(PR #479 review)', async () => {
      // 旧模型(meta.model)支持 max、新模型(schedule.model)仅到 xhigh;复用会话且 setModel 被拒
      // → 运行时仍停在旧模型 → setEffort 必须用「为旧模型 clamp 的 max」,而非「为新模型 clamp 的 xhigh」。
      // (efforts 由 availableModels 桩注入,与真实模型能力无关,只驱动本用例的 clamp 场景。)
      const h = createSessionHarness();
      h.setModel.mockRejectedValue(new Error('switchModel rejected'));
      // Claude setModel 抛错 → handle.model 不变,运行时仍停在旧模型 claude-opus-4-7。
      (h.session as { model: string }).model = 'claude-opus-4-7';
      const harness = createRunnerHarness(
        h,
        { model: 'claude-opus-4-7', effort: 'high', workDir: '/work', sdkSessionId: 'sdk-1' },
        {
          sessionAlive: true,
          availableModels: [
            { id: 'claude-opus-4-7', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
            { id: 'claude-opus-4-8', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
          ],
        },
      );

      await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: 'claude-opus-4-8', effort: 'max', targetSessionId: 'scheduler-session' }),
      );

      expect(h.setModel).toHaveBeenCalledWith('claude-opus-4-8'); // 尝试切换(被拒)
      // 运行时仍是旧模型 claude-opus-4-7(支持 max)→ effort 按它 clamp = max,不误降为新模型的 xhigh。
      expect(h.setEffort).toHaveBeenCalledWith('max');
      expect(h.setEffort).not.toHaveBeenCalledWith('xhigh');
      // model 落库跳过(setModel 失败,留待下次重试);effort 落按实际运行模型 clamp 后的 max。
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ model: undefined, effort: 'max' }),
        expect.anything(),
      );
    });

    it('换 model 但 effort 留空(follow)→ 沿用的会话 effort 也按新模型 clamp(PR #479 review)', async () => {
      // 会话当前在 max(旧模型支持),schedule 只换到 capped 新模型、不显式配 effort(follow)。
      // 若不把「沿用的 max」按新模型 clamp,会话会带 max 跑到只到 xhigh 的新模型上被上游拒 ——
      // 正是 #456 要消除的回归。这里 setModel 成功 → 运行时是新模型 → setEffort 必须收 clamp 后的 xhigh。
      const h = createSessionHarness();
      const harness = createRunnerHarness(
        h,
        { model: 'claude-opus-4-7', effort: 'max', workDir: '/work', sdkSessionId: 'sdk-1' },
        {
          sessionAlive: true,
          availableModels: [
            { id: 'claude-opus-4-7', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
            { id: 'claude-opus-4-8', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
          ],
        },
      );

      await fireToCompletion(
        harness,
        h,
        // effort 显式留空 = follow;model 换到只到 xhigh 的新模型。
        baseSchedule({ model: 'claude-opus-4-8', effort: undefined, targetSessionId: 'scheduler-session' }),
      );

      expect(h.setModel).toHaveBeenCalledWith('claude-opus-4-8'); // 切换成功
      // 沿用的会话档 max 被新模型 clamp 到 xhigh(而非放任 max 跑到 capped 模型)。
      expect(h.setEffort).toHaveBeenCalledWith('xhigh');
      expect(h.setEffort).not.toHaveBeenCalledWith('max');
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ model: 'claude-opus-4-8', effort: 'xhigh' }),
        expect.anything(),
      );
    });

    it('复用会话 + follow-model + 会话已被切到 capped 模型 → effort 按 live session.model clamp,不按旧 meta 快照(PR #479 review)', async () => {
      // schedule 不显式配 model(沿用会话模型)。meta 快照还是支持 max 的旧模型,但会话此前已被
      // 用户切到只到 xhigh 的 live 模型(session.model)。沿用的 effort=max 必须按 live 会话模型 clamp
      // 到 xhigh,不能按旧 meta 快照放任 max 跑到已 capped 的实际运行模型上。
      const h = createSessionHarness();
      // 会话 live 模型 = 已切到的 capped 模型(harness 默认即 claude-sonnet-4-6,这里显式点明用途)。
      (h.session as unknown as { model: string }).model = 'claude-sonnet-4-6';
      const harness = createRunnerHarness(
        h,
        { model: 'claude-opus-4-7', effort: 'max', workDir: '/work', sdkSessionId: 'sdk-1' }, // meta 旧快照(支持 max)
        {
          sessionAlive: true,
          availableModels: [
            { id: 'claude-opus-4-7', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
            { id: 'claude-sonnet-4-6', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
          ],
        },
      );

      await fireToCompletion(
        harness,
        h,
        // model + effort 都 follow(留空)。
        baseSchedule({ model: undefined, effort: undefined, targetSessionId: 'scheduler-session' }),
      );

      expect(h.setModel).not.toHaveBeenCalled(); // follow-model → 不切
      // 按 live session.model(claude-sonnet-4-6,仅到 xhigh)clamp 沿用的 max → xhigh。
      expect(h.setEffort).toHaveBeenCalledWith('xhigh');
      expect(h.setEffort).not.toHaveBeenCalledWith('max');
    });

    it('复用会话 + setModel 抛错但 handle 已改 model(模拟 Codex partial-apply)→ effort 按 live session.model clamp(PR #479 review)', async () => {
      // Codex 的 setModel 在 await push 前就先改了 handle.model,"失败"时会话其实已在新模型上。runner
      // 现按 live session.model(而非 modelSwitchApplied 启发式)定实际运行模型 —— 故 effort 按新 capped
      // 模型 clamp,不因 setModel"失败"就误按旧模型放行 max。
      const h = createSessionHarness();
      (h.session as { model: string }).model = 'claude-opus-4-7'; // 初始旧模型(支持 max)
      // setModel 先改 handle.model 再抛(partial-apply)。
      h.setModel.mockImplementation(async (m: string) => {
        (h.session as { model: string }).model = m;
        throw new Error('switch push rejected after model already applied');
      });
      const harness = createRunnerHarness(
        h,
        { model: 'claude-opus-4-7', effort: 'high', workDir: '/work', sdkSessionId: 'sdk-1' },
        {
          sessionAlive: true,
          availableModels: [
            { id: 'claude-opus-4-7', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
            { id: 'claude-opus-4-8', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
          ],
        },
      );

      await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: 'claude-opus-4-8', effort: 'max', targetSessionId: 'scheduler-session' }),
      );

      expect(h.setModel).toHaveBeenCalledWith('claude-opus-4-8');
      // handle 已切到 claude-opus-4-8(仅到 xhigh)→ effort 按它 clamp = xhigh,不按旧模型放行 max。
      expect(h.setEffort).toHaveBeenCalledWith('xhigh');
      expect(h.setEffort).not.toHaveBeenCalledWith('max');
    });

    it('冷 resume + follow-effort + setEffort 失败 → 不落库 effort,留待下次重试(PR #479 review)', async () => {
      // 冷 resume(会话不在进程内,reusedLiveSession=false):createSession 只拿到 undefined effort
      // (follow → schedule.effort 空),真正要落的 clamp 后档只经 setEffort 生效。setEffort 抛错 = 没生效,
      // 必须跳过落库,否则 DB 记了假值、下次 fire 判"已同步"不再重试(effortSwitchApplied 旧逻辑只护复用路径)。
      const h = createSessionHarness();
      h.setEffort.mockRejectedValue(new Error('setEffort rejected'));
      const harness = createRunnerHarness(
        h,
        { model: 'claude-opus-4-7', effort: 'max', workDir: '/work', sdkSessionId: 'sdk-1' }, // 会话当前档 max
        {
          sessionAlive: false, // 冷 resume(非复用)
          availableModels: [
            { id: 'claude-opus-4-7', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
            { id: 'claude-opus-4-8', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
          ],
        },
      );

      await fireToCompletion(
        harness,
        h,
        // follow-effort(留空)+ 换到只到 xhigh 的模型。
        baseSchedule({ model: 'claude-opus-4-8', effort: undefined, targetSessionId: 'scheduler-session' }),
      );

      // follow 的 max 按新模型 clamp 到 xhigh,经 setEffort 下发但失败。
      expect(h.setEffort).toHaveBeenCalledWith('xhigh');
      // setEffort 是本次 effort 的唯一生效通道(createSession 只拿到 undefined)→ 失败不落库,下次重试。
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ effort: undefined }),
        expect.anything(),
      );
    });

    it('legacy session meta 无 model 时落兜底 Sonnet 并 setModel + 落库（显式锁定静默升级契约）', async () => {
      // 历史持续会话可能从未存过 model（meta.model undefined）。此时:
      // rawModel=undefined → defaultModelFor='claude-sonnet-4-6',
      // heartbeatModelChanged=true → setModel + backfill 落库。
      // 这是有意行为（兜底必须与 UI 空值回退一致）,本用例防止未来误改。
      const h = createSessionHarness();
      const harness = createRunnerHarness(h, { workDir: '/work', sdkSessionId: 'sdk-1' });

      const opts = await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: undefined, targetSessionId: 'scheduler-session' }),
      );

      expect(opts.model).toBe('claude-sonnet-4-6');
      expect(h.setModel).toHaveBeenCalledWith('claude-sonnet-4-6');
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ model: 'claude-sonnet-4-6' }),
        expect.anything(),
      );
    });

    it('schedule.effort 与 meta.effort 不一致时 setEffort 同步运行时（active session 复用路径）', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h, HEARTBEAT_META);

      await fireToCompletion(
        harness,
        h,
        baseSchedule({
          model: 'claude-opus-4-7',
          effort: 'xhigh',
          targetSessionId: 'scheduler-session',
        }),
      );

      expect(h.setEffort).toHaveBeenCalledWith('xhigh');
    });

    it('schedule.effort 留空或与 meta.effort 相同时不触发 setEffort', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h, HEARTBEAT_META);

      await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: 'claude-opus-4-7', targetSessionId: 'scheduler-session' }),
      );
      expect(h.setEffort).not.toHaveBeenCalled();

      const h2 = createSessionHarness();
      const harness2 = createRunnerHarness(h2, HEARTBEAT_META);
      await fireToCompletion(
        harness2,
        h2,
        baseSchedule({
          model: 'claude-opus-4-7',
          effort: 'high', // 与 meta.effort 相同
          targetSessionId: 'scheduler-session',
        }),
      );
      expect(h2.setEffort).not.toHaveBeenCalled();
    });
  });

  // ── per-session 来源(供应商)注入 ──────────────────────────────────────────
  // 不变量(镜像 model,但更简单——provider 走独立内存 store,与 session 是否复用无关):
  //   - 留空 + 非 heartbeat → 不碰 store(fresh session 默认 null = 原生默认路由,no-break)。
  //   - 留空 + heartbeat → hydrate 绑定会话的 provider_id(只在内存无条目时写,不覆盖)。
  //   - 显式设置 → setSessionProvider 覆盖 + backfill 落 sessions.provider_id。
  describe('provider (来源) 注入', () => {
    it('非 heartbeat + 留空 providerId → 不调 setSessionProvider/hydrate(原生默认,no-break)', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h);

      await fireToCompletion(harness, h, baseSchedule({ model: 'claude-sonnet-4-6' }));

      expect(mocks.setSessionProvider).not.toHaveBeenCalled();
      expect(mocks.hydrateSessionProvider).not.toHaveBeenCalled();
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ providerId: undefined }),
        expect.anything(),
      );
    });

    it('非 heartbeat + 显式 providerId → setSessionProvider 覆盖 + 落库', async () => {
      const h = createSessionHarness();
      const harness = createRunnerHarness(h);

      await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: 'claude-sonnet-4-6', providerId: 'anthropic' }),
      );

      expect(mocks.setSessionProvider).toHaveBeenCalledWith('scheduler-session', 'anthropic');
      expect(mocks.hydrateSessionProvider).not.toHaveBeenCalled();
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ providerId: 'anthropic' }),
        expect.anything(),
      );
    });

    it('heartbeat + 留空 → hydrate 绑定会话的 provider_id(沿用会话来源,不覆盖、不落库)', async () => {
      mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active', providerId: 'openai' });
      const h = createSessionHarness();
      const harness = createRunnerHarness(h, {
        model: 'claude-opus-4-7',
        workDir: '/work',
        sdkSessionId: 'sdk-1',
      });

      await fireToCompletion(
        harness,
        h,
        baseSchedule({ model: undefined, targetSessionId: 'scheduler-session' }),
      );

      expect(mocks.hydrateSessionProvider).toHaveBeenCalledWith('scheduler-session', 'openai');
      expect(mocks.setSessionProvider).not.toHaveBeenCalled();
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ providerId: undefined }),
        expect.anything(),
      );
    });

    it('heartbeat + 显式 providerId → setSessionProvider 覆盖绑定会话来源 + 落库', async () => {
      mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active', providerId: 'openai' });
      const h = createSessionHarness();
      const harness = createRunnerHarness(h, {
        model: 'claude-opus-4-7',
        workDir: '/work',
        sdkSessionId: 'sdk-1',
      });

      await fireToCompletion(
        harness,
        h,
        baseSchedule({
          model: 'claude-opus-4-7',
          providerId: 'anthropic',
          targetSessionId: 'scheduler-session',
        }),
      );

      expect(mocks.setSessionProvider).toHaveBeenCalledWith('scheduler-session', 'anthropic');
      expect(mocks.hydrateSessionProvider).not.toHaveBeenCalled();
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ providerId: 'anthropic' }),
        expect.anything(),
      );
    });

    it('heartbeat 复用本地 Codex 且跨 credential family → 先关闭再按新来源重建', async () => {
      mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active', providerId: 'xd' });
      const h = createSessionHarness();
      Object.defineProperty(h.session, 'agentKind', { value: 'codex' });
      Object.defineProperty(h.session, 'model', { value: 'codex/gpt-5.5' });
      const harness = createRunnerHarness(h, {
        model: 'codex/gpt-5.5',
        workDir: '/work',
        sdkSessionId: 'sdk-1',
      }, { sessionAlive: true });

      await fireToCompletion(
        harness,
        h,
        baseSchedule({
          agentKind: 'codex',
          model: 'gpt-5.4',
          providerId: 'openai',
          targetSessionId: 'scheduler-session',
        }),
      );

      expect(harness.closeSession).toHaveBeenCalledWith('scheduler-session');
      expect(harness.closeSession.mock.invocationCallOrder[0])
        .toBeLessThan(harness.createSession.mock.invocationCallOrder[0]);
      expect(harness.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'openai', model: 'gpt-5.4' }),
      );
      expect(mocks.setSessionProvider).toHaveBeenCalledWith('scheduler-session', 'openai');
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ model: 'gpt-5.4', providerId: 'openai' }),
        expect.anything(),
      );
    });

    it('heartbeat 复用本地 Codex 且其它本地 Codex 正忙 → 顺延且不关闭任何会话', async () => {
      mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active', providerId: 'xd' });
      const h = createSessionHarness();
      Object.defineProperty(h.session, 'agentKind', { value: 'codex' });
      Object.defineProperty(h.session, 'model', { value: 'codex/gpt-5.5' });
      const busyCodexSession = {
        id: 'busy-codex-session',
        agentKind: 'codex',
        remoteHostId: null,
        isTurnRunning: () => true,
      } as unknown as Session;
      const harness = createRunnerHarness(h, {
        model: 'codex/gpt-5.5',
        workDir: '/work',
        sdkSessionId: 'sdk-1',
      }, { sessionAlive: true, activeSessions: [h.session, busyCodexSession] });

      const result = await harness.runner.fire(
        baseSchedule({
          agentKind: 'codex',
          model: 'gpt-5.4',
          providerId: 'openai',
          targetSessionId: 'scheduler-session',
        }),
        createFireContext(),
      );

      expect(result).toEqual({
        sessionId: 'scheduler-session',
        deferred: true,
        deferRetryMs: 90_000,
      });
      expect(harness.closeSession).not.toHaveBeenCalled();
      expect(harness.createSession).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
    });

    it('heartbeat 复用本地 Claude 且从 XD 切到 Anthropic → 先关闭再按新来源重建', async () => {
      mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active', providerId: 'xd' });
      const h = createSessionHarness();
      Object.defineProperty(h.session, 'model', { value: 'claude-sonnet-4-6' });
      const harness = createRunnerHarness(h, {
        model: 'claude-sonnet-4-6',
        workDir: '/work',
        sdkSessionId: 'sdk-1',
      }, { sessionAlive: true });

      await fireToCompletion(
        harness,
        h,
        baseSchedule({
          model: 'claude-opus-4-8',
          providerId: 'anthropic',
          targetSessionId: 'scheduler-session',
        }),
      );

      expect(harness.closeSession).toHaveBeenCalledWith('scheduler-session');
      expect(harness.closeSession.mock.invocationCallOrder[0])
        .toBeLessThan(harness.createSession.mock.invocationCallOrder[0]);
      expect(harness.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'anthropic', model: 'claude-opus-4-8' }),
      );
      expect(mocks.setSessionProvider).toHaveBeenCalledWith('scheduler-session', 'anthropic');
      expect(mocks.backfillSessionMeta).toHaveBeenCalledWith(
        expect.anything(),
        'scheduler-session',
        expect.objectContaining({ model: 'claude-opus-4-8', providerId: 'anthropic' }),
        expect.anything(),
      );
    });

    it('heartbeat 复用本地 Claude 且目标会话正忙 → 顺延且不关闭会话', async () => {
      mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active', providerId: 'xd' });
      const h = createSessionHarness();
      Object.defineProperty(h.session, 'model', { value: 'claude-sonnet-4-6' });
      Object.defineProperty(h.session, 'isTurnRunning', { value: () => true });
      const harness = createRunnerHarness(h, {
        model: 'claude-sonnet-4-6',
        workDir: '/work',
        sdkSessionId: 'sdk-1',
      }, { sessionAlive: true });

      const result = await harness.runner.fire(
        baseSchedule({
          model: 'claude-opus-4-8',
          providerId: 'anthropic',
          targetSessionId: 'scheduler-session',
        }),
        createFireContext(),
      );

      expect(result).toEqual({
        sessionId: 'scheduler-session',
        deferred: true,
        deferRetryMs: 90_000,
      });
      expect(harness.closeSession).not.toHaveBeenCalled();
      expect(harness.createSession).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
    });
  });
});
