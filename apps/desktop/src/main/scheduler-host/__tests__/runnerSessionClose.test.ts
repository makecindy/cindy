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
  InteractionDecision,
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
  getSessionFsSnapshot: mocks.getSessionRowSnapshot,
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

import { MakerScheduleRunner } from '../runner.desktop';
import type { MakerScheduleRunnerDeps } from '../runner';
import { Session as RuntimeSession } from '../../../../../../packages/maker-core/src/session.js';
import { createAsyncQueue } from '../../../../../../packages/maker-core/src/agents/shared/async-queue.js';
import { AgentInputCoordinator } from '../../maker-ipc/agent-input-coordinator.js';
import { createGhostAgentTurnRunner } from '../../maker-ipc/ghostAgentTurnRunner.js';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
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
    // 留空模型要靠默认解析(本 harness 未接),这里显式给模型。
    model: 'gpt-6-astra',
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

function createRunnerHarness(session: Session, extraDeps: Partial<MakerScheduleRunnerDeps> = {}) {
  const notifier: Notifier = { notify: vi.fn(async () => undefined) };
  const logger: Logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const closeSession = vi.fn(async () => undefined);
  const maker = {
    createSession: vi.fn(async () => session),
    getSessionMeta: vi.fn(async () => null),
    isSessionAlive: vi.fn(() => false),
    closeSession,
    recyclePiRuntimeIfResourcesDrifted: vi.fn(async () => false),
  } as unknown as Maker;
  const actualMaker = extraDeps.maker ?? maker;
  const runner = new MakerScheduleRunner({
    maker,
    getDb: () => ({}) as never,
    notifier,
    logger,
    ...extraDeps,
  });
  const schedulerUpdate = vi.fn(async () => ({}) as never);
  runner.attachScheduler({
    update: schedulerUpdate,
    isRunSilenced: () => false,
    isRunAbandoned: () => false,
  } as unknown as Scheduler);
  return { runner, maker: actualMaker, closeSession: actualMaker.closeSession as typeof closeSession, logger };
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

  it('keeps the fire-entry owner guard until session creation', async () => {
    const h = createSessionHarness();
    let owner = 'a';
    const bootstrapSession = vi.fn(async (_opts, _signal, assertOwner) => {
      assertOwner?.();
      return h.session;
    });
    const context = createFireContext();
    const captured = owner;
    context.assertFireContext = () => { if (owner !== captured) throw new Error('owner changed'); };
    const { runner } = createRunnerHarness(h.session, {
      findUsageLimitWait: async () => { owner = 'b'; return null; },
      bootstrapSession,
    });
    await expect(runner.fire(baseSchedule(), context)).rejects.toThrow('owner changed');
    expect(bootstrapSession).toHaveBeenCalledOnce();
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

  // #10742: existing close tests only model an already-running takeover. Exercise
  // the accepted queue -> preparing boundary with real Session/Coordinator/Ghost
  // runners. Provider and DB ports are in-memory; no model, mail or native I/O.
  it.each(['plugin', 'user'] as const)(
    'hands the runtime to accepted %s input before its next turn starts', async source => {
      const deferred = () => {
        let resolve!: () => void;
        const promise = new Promise<void>(r => { resolve = r; });
        return { promise, resolve };
      };
      const events = createAsyncQueue<AgentEvent>();
      const firstSend = deferred();
      const preparing = deferred();
      const allowDispatch = deferred();
      const dispatched = deferred();
      const abortEntered = deferred();
      const allowAbort = deferred();
      const handle = {
        id: 'fixture-provider', agentKind: 'pi' as const, model: 'fixture-model',
        send: vi.fn(async () => {}),
        events: () => events, close: async () => { events.end(); },
        abort: async () => { abortEntered.resolve(); await allowAbort.promise; },
        isTurnRunning: () => false, setInteractionResolver: () => {},
      };
      const logger = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => logger };
      const session = new RuntimeSession({
        id: 'scheduler-session', agentKind: 'pi', workDir: process.cwd(),
        handle: handle as never, capabilities: { sameTurnSteer: { supported: true } } as never, logger: logger as never, turnStallMs: 0,
        permissionMode: 'bypassPermissions',
      });
      const discarded = vi.fn();
      const terminalErrors = vi.fn();
      const coordinator = new AgentInputCoordinator({
        sendToAgent: async (_id, message, _opts, sendOpts) => {
          const text = typeof message === 'string' ? message : message.content;
          if (typeof text !== 'string') throw new Error('This fixture only sends text');
          const result = await session.send(text, {
            signal: sendOpts.signal, onTurnReserved: sendOpts.onVendorTurnReserved,
            onAccepted: async () => {
              sendOpts.persistUserMessage?.onPersisting?.();
              await sendOpts.persistUserMessage?.onPersisted?.();
            },
          });
          expect(result.accepted).not.toBe(false);
          dispatched.resolve();
          return { kind: 'session-dispatch', source: 'local', dispatched: true } as const;
        },
        steerToAgent: async () => {}, abortSession: async () => {},
        isTurnRunning: () => session.isTurnRunning(), isLiveTurnRunning: () => session.isTurnRunning(),
        isLiveSessionPresent: () => true, hasPendingInteraction: () => false,
        getTurnGeneration: () => session.getTurnGeneration(), getTurnSessionIdentity: () => session,
        getAgentKind: () => 'pi', getSdkSessionId: async () => handle.id,
        createUserMessage: async () => ({} as never), touchUserSend: async () => {},
        emitProjection: () => {}, persistTerminalSendError: terminalErrors,
        onDiscardedQueuedMessage: discarded,
        screenUserMessage: async () => {
          preparing.resolve();
          await allowDispatch.promise;
          return { action: 'allow' };
        },
      });
      session.onEvent(event => {
        if (event.type === 'done') coordinator.onTurnEvent(session.id, 'done');
      });
      session.onStatusChange(status => { if (status === 'closed') coordinator.onSessionClosed(session.id); });
      mocks.getSessionRowSnapshot.mockResolvedValue({ status: 'active', permissionMode: 'bypassPermissions', planModeEnabled: false });
      const { runner, closeSession } = createRunnerHarness(session, {
        applyPiModelSelectionUnderLock: async () => ({ status: 'applied' }),
        maker: {
          createSession: async () => session, getSession: () => session,
          getSessionMeta: async () => ({ model: 'fixture-model', agentKind: 'pi' }),
          isSessionAlive: () => true, recyclePiRuntimeIfResourcesDrifted: async () => false,
          closeSession: vi.fn(() => session.close()),
          closeSessionIfCurrent: vi.fn(async () => await session.closeIfIdle() ? 'closed' : undefined),
        } as unknown as Maker,
        schedulerQueue: {
          isSessionBusy: id => coordinator.shouldQueueNewTurn(id),
          hasPendingInput: id => coordinator.hasPendingQueuedWork(id)
            || coordinator.hasQueuedItemWhere(id, () => true, { includeRecovery: true }),
          hasQueuedPrompt: () => false, isPromptTracked: () => true,
          removeQueuedPrompt: () => {},
          enqueuePrompt: async req => {
            await req.onPreparing?.();
            await session.send(req.text, { origin: req.origin, onAccepted: () => req.onAccepted({ permissionMode: 'bypassPermissions', planMode: false }) });
            firstSend.resolve();
            return { clientId: 'scheduled-input' };
          },
        },
      });
      const enqueue = (text: string, sourcePlugin?: AgentInputQueuedMessage['sourcePlugin']) => {
        coordinator.enqueue(session.id, {
          clientId: 'follow-up', text, persistedContent: text, model: 'fixture-model',
          effort: 'medium', permissionMode: 'default', workingDir: process.cwd(),
          chatMessage: { clientId: 'follow-up', role: 'user', content: text, createdAt: new Date().toISOString() },
          createOpts: { agentKind: 'pi', workingDir: process.cwd(), model: 'fixture-model',
            effort: 'medium', permissionMode: 'default', userPrompt: '' },
          ...(sourcePlugin ? { sourcePlugin } : {}),
        });
      };
      const fire = runner.fire(baseSchedule({ agentKind: 'pi', model: 'fixture-model' }), createFireContext());
      void fire.catch(() => {});
      try {
        await Promise.race([firstSend.promise, fire.then(() => { throw new Error('fire ended before send'); })]);
        if (source === 'plugin') {
          const ghost = createGhostAgentTurnRunner({
            readSessionMeta: async () => ({}), admitLocalSession: async () => {},
            readPluginName: () => 'Fixture plugin',
            send: async params => {
              enqueue(params.message, params.sourcePlugin);
              return { ok: true, targetSessionId: session.id, wakeKind: 'queued' };
            },
            readLatestAssistant: async () => undefined, forkSessionAtMessage: async () => ({ id: 'unused' }),
            broadcastSessionCreated: () => {},
          });
          expect(await ghost({ ghostId: 'fixture-plugin', ghostVersion: '1', sourceSessionId: session.id,
            mode: 'continue', prompt: 'Completion receipt', persistedContent: 'Completion receipt' }))
            .toMatchObject({ ok: true, disposition: 'queued' });
        } else enqueue('Follow-up question');
        events.push({ type: 'text', data: 'Report complete', source: 'pi' });
        events.push({ type: 'done', data: { stopReason: 'stop' }, source: 'pi' });
        await preparing.promise;
        vi.useFakeTimers();
        await fire;
        // The original turn is settled but the next input is still preparing.
        expect(session.isTurnRunning()).toBe(false);
        expect(closeSession).not.toHaveBeenCalled();
        allowDispatch.resolve();
        await dispatched.promise;
        expect(handle.send).toHaveBeenCalledTimes(2);
        expect(coordinator.getProjection(session.id).error).toBeNull();
        expect(discarded).not.toHaveBeenCalled();
        expect(terminalErrors).not.toHaveBeenCalled();
        // Async questions intentionally outlive done; cleanup must keep them answerable.
        let answerQuestion!: (answer: InteractionDecision) => void;
        session.setInteractionListener(() => new Promise(resolve => { answerQuestion = resolve; }));
        const question = session.askUserQuestionAsync([{ question: 'Which follow-up scope?' }]);
        events.push({ type: 'done', data: { stopReason: 'stop' }, source: 'pi' });
        await vi.waitFor(() => expect(session.isTurnRunning()).toBe(false));
        await vi.advanceTimersByTimeAsync(1_000);
        expect(session.getStatus()).toBe('active');
        expect(session.manageAsyncUserQuestions({ action: 'list' }).questions).toHaveLength(1);
        if (source === 'plugin') {
          // A late answer must actually reach the provider in a third turn.
          const answer: InteractionDecision = {
            kind: 'ask_user_question', answers: { 'Which follow-up scope?': 'Keep the original scope' },
          };
          await expect(session.submitAsyncQuestionAnswer(question.request_id, answer)).resolves.toBe(true);
          answerQuestion(answer);
          await vi.waitFor(() => expect(session.manageAsyncUserQuestions({ action: 'list' }).questions).toHaveLength(0));
          expect(handle.send).toHaveBeenCalledTimes(3);
          events.push({ type: 'done', data: { stopReason: 'stop' }, source: 'pi' });
          await vi.waitFor(() => expect(session.isTurnRunning()).toBe(false));
        } else {
          const abort = session.abort();
          await abortEntered.promise;
          expect(session.getStatus()).toBe('aborting');
          await vi.advanceTimersByTimeAsync(1_000);
          expect(session.getStatus()).toBe('aborting');
          allowAbort.resolve();
          await abort;
          expect(session.manageAsyncUserQuestions({ action: 'withdraw',
            request_ids: [question.request_id], reason: 'No longer needed' }).results)
            .toEqual([{ request_id: question.request_id, status: 'withdrawn' }]);
        }
        await vi.advanceTimersByTimeAsync(1_000);
        expect(session.getStatus()).toBe('closed');
      } finally {
        vi.useRealTimers();
        allowDispatch.resolve();
        allowAbort.resolve();
        await fire.catch(() => {});
        await session.close();
      }
    },
  );

  it.each(['removed', 'owner-changed', 'runtime-replaced', 'probe-new-input', 'probe-owner-changed', 'probe-runtime-replaced', 'probe-aborting', 'probe-new-turn'] as const)(
    'deferred cleanup respects %s after queued input takes ownership', async outcome => {
      vi.useFakeTimers();
      const h = createSessionHarness();
      let pending = true;
      let inTurn = false;
      let background = false;
      let wakes = 0;
      let nativeWork = false;
      let probeRaceApplied = false;
      let status: 'active' | 'aborting' = 'active';
      let generation = 0;
      Object.assign(h.session, {
        getStatus: () => status,
        getTurnGeneration: () => generation,
        listBackgroundTasks: () => background ? [{}] : [],
        countPendingWakeContinuations: () => wakes,
        manageAsyncUserQuestions: () => ({ questions: [] }),
        hasLiveBackgroundWork: async () => {
          const snapshot = nativeWork;
          await Promise.resolve();
          if (!probeRaceApplied) {
            probeRaceApplied = true;
            if (outcome === 'probe-new-input') pending = true;
            if (outcome === 'probe-aborting') status = 'aborting';
            if (outcome === 'probe-new-turn') { generation++; nativeWork = true; }
            if (outcome === 'probe-owner-changed') owner = false;
            if (outcome === 'probe-runtime-replaced') current = { ...h.session } as Session;
          }
          return snapshot;
        },
      });
      let owner = true;
      let current: Session | null = h.session;
      const retire = vi.fn(async () => 'closed' as const);
      const { runner, closeSession } = createRunnerHarness(h.session, {
        maker: {
          createSession: async () => h.session, getSession: () => current,
          getSessionMeta: async () => null, isSessionAlive: () => false,
          closeSession: vi.fn(), closeSessionIfCurrent: retire,
          recyclePiRuntimeIfResourcesDrifted: async () => false,
        } as unknown as Maker,
        schedulerQueue: {
          isSessionBusy: () => false, hasPendingInput: () => pending,
          hasQueuedPrompt: () => false, isPromptTracked: () => false,
          removeQueuedPrompt: () => {},
          enqueuePrompt: async () => { throw new Error('initial dispatch failed'); },
        },
      });
      const context = createFireContext();
      context.assertFireContext = () => { if (!owner) throw new Error('owner changed'); };
      try {
        await expect(runner.fire(baseSchedule(), context)).rejects.toThrow('initial dispatch failed');
        await vi.advanceTimersByTimeAsync(1_000);
        expect(retire).not.toHaveBeenCalled();
        pending = false;
        inTurn = true;
        mocks.isSessionInTurn.mockImplementation(() => inTurn);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(retire).not.toHaveBeenCalled();
        inTurn = false;
        if (outcome === 'removed') {
          background = true;
          await vi.advanceTimersByTimeAsync(1_000);
          expect(retire).not.toHaveBeenCalled();
          background = false;
          wakes = 1;
          await vi.advanceTimersByTimeAsync(1_000);
          expect(retire).not.toHaveBeenCalled();
          wakes = 0;
          nativeWork = true;
          await vi.advanceTimersByTimeAsync(1_000);
          expect(retire).not.toHaveBeenCalled();
          nativeWork = false;
        }
        if (outcome === 'owner-changed') owner = false;
        if (outcome === 'runtime-replaced') current = { ...h.session } as Session;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(closeSession).not.toHaveBeenCalled();
        if (outcome === 'probe-new-input') {
          expect(retire).not.toHaveBeenCalled();
          pending = false;
          await vi.advanceTimersByTimeAsync(1_000);
        }
        if (outcome === 'probe-aborting' || outcome === 'probe-new-turn') {
          expect(retire).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1_000);
          expect(retire).not.toHaveBeenCalled();
          status = 'active';
          nativeWork = false;
          await vi.advanceTimersByTimeAsync(1_000);
        }
        if (outcome === 'removed' || outcome === 'probe-new-input'
          || outcome === 'probe-aborting' || outcome === 'probe-new-turn') {
          expect(retire).toHaveBeenCalledExactlyOnceWith(h.session, 'requested', { onlyIfIdle: true });
        } else expect(retire).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
      } finally { vi.useRealTimers(); }
    },
  );

  it('closes a fresh empty runtime when queue restoration fails before acceptance', async () => {
    const h = createSessionHarness();
    const coordinator = new AgentInputCoordinator({
      loadQueueSnapshot: async () => { throw new Error('snapshot unavailable'); },
    } as never);
    await expect(coordinator.ensureQueueRestored(h.session.id)).rejects.toThrow('snapshot unavailable');
    const { runner, closeSession } = createRunnerHarness(h.session, {
      schedulerQueue: {
        isSessionBusy: id => coordinator.shouldQueueNewTurn(id),
        hasPendingInput: id => coordinator.hasPendingQueuedWork(id)
          || coordinator.hasQueuedItemWhere(id, () => true, { includeRecovery: true }),
        hasQueuedPrompt: () => false, isPromptTracked: () => false,
        removeQueuedPrompt: () => {}, enqueuePrompt: async () => ({ retry: true }),
      },
    });
    await runner.fire(baseSchedule(), createFireContext());
    expect(coordinator.isQueueRestored(h.session.id)).toBe(false);
    expect(h.session.send).not.toHaveBeenCalled();
    expect(closeSession).toHaveBeenCalledOnce();
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
