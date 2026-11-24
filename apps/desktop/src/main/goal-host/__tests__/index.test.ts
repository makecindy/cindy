import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Maker } from '@cindy/maker-core';
import { buildUserProvider } from '@cindy/model-providers';
import type { OpenCodeGoUsageSnapshot } from '../../../shared/opencodeGoUsage';
import type { readOpenCodeGoAccountUsage } from '../../maker-host/provider-account-usage';
import type { CodexAccountUsagePayload } from '../../usageBroadcaster';
import type { GoalState, SessionLike } from '../types';
import { getActiveCatalog, setCustomProviders } from '../../maker-host/active-catalog';
import { AgentInputCoordinator, type AgentInputCoordinatorDeps } from '../../maker-ipc/agent-input-coordinator';
import { MAKER_INVOKE } from '../../maker-ipc/channels';
import { registerGoalHandlers } from '../../maker-ipc/goal';
import { DEFAULT_DRAFT_SESSION_TITLE } from '@cindy/maker-shared/session-title';
import { acquireSendToSessionLock, withSendToSessionLock } from '../../maker-ipc/sendToSessionLock';

const host = vi.hoisted(() => ({
  goals: new Map<string, GoalState>(),
  row: { providerId: 'openai', model: 'gpt-6-astra', agentDeviceId: null as string | null },
  codex: vi.fn<() => Promise<CodexAccountUsagePayload | null>>(),
  go: vi.fn<typeof readOpenCodeGoAccountUsage>(),
  goalHandlers: new Map<string, (event: unknown, input: unknown) => Promise<unknown>>(),
  acquireGoalRoute: vi.fn<(sessionId: string) => Promise<() => void>>(),
  goalInputBlocked: vi.fn<(sessionId: string) => boolean>(),
  dbOwner: {} as object,
  createMessage: vi.fn<() => Promise<void>>(),
  persistInitialTaskTitle: vi.fn<(id: string, title: string, expected: string) => Promise<boolean>>(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>) => {
    host.goalHandlers.set(channel, handler);
  } },
}));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => 'test-owner',
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({ tapWindowBroadcast: vi.fn() }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }));
vi.mock('../../maker-ipc/register.js', () => ({
  hasRestoredCodexQuota: vi.fn(),
  acquirePendingAgentSwitchForDirectSend: host.acquireGoalRoute,
  isSessionInTurn: () => false,
  ensureGoalInputReady: async (id: string) => !host.goalInputBlocked(id),
  isGoalInputBlocked: host.goalInputBlocked,
  stopActiveGoalTurnForClear: async () => {},
  resolveSessionRuntimeRoute: () => ({ providerId: host.row.providerId, modelId: host.row.model }),
}));
vi.mock('../../device-link/sharedTaskDispatch.js', () => ({ isSessionSharedTaskActive: () => false }));
vi.mock('../../localDb/ipc/messages.js', () => ({ createMessage: host.createMessage }));
vi.mock('../../localDb/client/current.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../localDb/client/current.js')>(),
  getCurrentDbClientSnapshot: () => host.dbOwner,
}));
vi.mock('../../maker-ipc/createdTaskTitles.js', () => ({
  persistInitialTaskTitle: host.persistInitialTaskTitle,
}));
vi.mock('../../localDb/ipc/sessions.js', () => ({
  getSessionRowSnapshot: async () => host.row,
  touchSessionActivityInDb: async () => {},
}));
vi.mock('../../maker-host/goal-settings-store.js', () => ({
  readGoalSettings: () => ({ maxTurns: null, budgetTokens: null, noProgressLimit: null }),
  writeGoalSettings: async () => {},
}));
vi.mock('../../usageBroadcaster.js', () => ({
  readCodexAccountUsageSnapshot: host.codex,
  readClaudeSubscriptionUsageSnapshot: async () => ({ fiveHour: { utilization: 100, resetsAt: RESET / 1000 } }),
  readXaiSubscriptionUsageSnapshot: async () => null,
}));
vi.mock('../../usage/subscriptionAccountUsage.js', () => ({ readSubscriptionAccountUsage: async () => null }));
vi.mock('../../maker-host/provider-account-usage.js', () => ({ readOpenCodeGoAccountUsage: host.go }));
vi.mock('../../usage/claudeAccountUsage.js', () => ({ readClaudeAccountUsageSnapshot: () => null }));
vi.mock('../../maker-ipc/usage.js', () => ({ onCodexAutoResetRestored: () => () => {} }));
vi.mock('../sessionRestore.js', () => ({
  restoreSessionForGoal: async (id: string, deps: { maker: Maker }) => deps.maker.getSession(id),
}));
vi.mock('../storage', () => ({
  GoalStorage: class {
    async get(id: string) { return host.goals.get(id) ?? null; }
    async upsert(state: GoalState) { host.goals.set(state.sessionId, { ...state }); }
    async update(id: string, patch: Partial<GoalState>) {
      const previous = host.goals.get(id);
      if (!previous) return null;
      const next = { ...previous, ...patch };
      host.goals.set(id, next);
      return next;
    }
    async clear(id: string) { host.goals.delete(id); }
    async listActive() { return [...host.goals.values()].filter(g => g.status === 'active'); }
    async listUsageLimited() { return [...host.goals.values()].filter(g => g.status === 'usageLimited'); }
  },
}));

import { resetGoalController, startGoalController, waitForGoalController } from '../index';

const NOW = Date.parse('2026-10-29T10:00:00Z');
const RESET = NOW + 7 * 24 * 60 * 60 * 1000;

async function start(agentKind: SessionLike['agentKind'] = 'codex', viaIpc = false, persistInitialTitle?: true) {
  let listener: ((event: AgentEvent) => void) | null = null;
  const send = vi.fn(async (_message: unknown, options?: {
    onDispatching?: () => void;
    onAccepted?: () => void | Promise<void>;
  }) => {
    options?.onDispatching?.();
    await options?.onAccepted?.();
    return { accepted: true };
  });
  const session = {
    id: 's1', agentKind, send,
    onEvent(next: (event: AgentEvent) => void) {
      listener = next;
      return () => { listener = null; };
    },
    isTurnRunning: () => false,
    abort: async () => {},
  };
  const controller = startGoalController({
    maker: { getSession: () => session } as unknown as Maker,
    getDb: () => { throw new Error('This test must not access a database'); },
    broadcastStatus: () => {},
  });
  await vi.advanceTimersByTimeAsync(0);
  if (viaIpc) {
    registerGoalHandlers();
    await host.goalHandlers.get(MAKER_INVOKE.GOAL_SET)!(null, {
      sessionId: 's1', objective: 'Finish the work', persistInitialTitle,
    });
  } else {
    await controller.setGoal({ sessionId: 's1', objective: 'Finish the work', agentKind });
  }
  expect(send).toHaveBeenCalledTimes(1);
  return {
    controller, send,
    finishUser() {
      listener?.({ type: 'done', data: {}, turnOrigin: { kind: 'user' } } as AgentEvent);
    },
    finish(error?: Record<string, unknown>) {
      const emit = (event: unknown) => listener?.(event as AgentEvent);
      if (error) {
        emit({ type: 'error', source: agentKind, turnOrigin: { kind: 'goal' }, data: { isTerminal: true, ...error } });
      } else {
        emit({ type: 'tool_use', data: { name: 'read_file' } });
        emit({ type: 'text', data: { text: '{"goal_status":"continue","reason":"Work remains"}', isFinal: true } });
        emit({ type: 'done', data: {}, turnOrigin: { kind: 'goal' } });
      }
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  host.goals.clear();
  host.goalHandlers.clear();
  host.dbOwner = {};
  host.createMessage.mockReset().mockResolvedValue(undefined);
  host.persistInitialTaskTitle.mockReset().mockResolvedValue(true);
  host.acquireGoalRoute.mockReset().mockImplementation(async () => () => {});
  host.goalInputBlocked.mockReset().mockReturnValue(false);
  host.row = { providerId: 'openai', model: 'gpt-6-astra', agentDeviceId: null };
  const openai = getActiveCatalog().providers.find(p => p.id === 'openai')!;
  setCustomProviders([{ ...openai, id: 'work-account', auth: { ...openai.auth, native: 'codex' } }]);
  host.codex.mockReset();
  const snapshot = {
    primary: { usedPercent: 100, resetsAt: RESET / 1000 },
    credits: { hasCredits: true, unlimited: false, balance: '100' },
  };
  host.codex.mockResolvedValue({ ...snapshot, webSnapshot: snapshot });
});

// #11431, unit: run the Desktop Goal Set handler, live controller and queue
// together. The controller-only queue tests release after dispatch preparation
// has already returned, missing an ordinary terminal while it still owns firing.
describe('Goal continuation after ordinary input', () => {
  it.each(['overlap', 'ordinary-finishes-later', 'paused', 'stopped', 'occupied'] as const)('%s', async scenario => {
    const dispatches: string[] = [];
    let userRunning = false;
    let wakeOnProjection = (_id: string) => {};
    const userDispatchStarted = Promise.withResolvers<void>();
    const settleUserSend = Promise.withResolvers<void>();
    const coordinator = new AgentInputCoordinator({
      sendToAgent: (id, _message, _create, options) => withSendToSessionLock(id, async () => {
        await options.persistUserMessage?.onPersisted?.();
        dispatches.push('user');
        userRunning = true;
        userDispatchStarted.resolve();
        // The send transaction can still be settling accepted input under the
        // route lock when the coordinator receives the ordinary turn's done.
        await settleUserSend.promise;
        return { kind: 'session-dispatch', source: 'test', dispatched: true };
      }),
      steerToAgent: async () => {},
      abortSession: async () => {},
      isTurnRunning: () => userRunning,
      hasPendingInteraction: () => false,
      getAgentKind: () => 'codex',
      getSdkSessionId: async () => undefined,
      createUserMessage: vi.fn<AgentInputCoordinatorDeps['createUserMessage']>(),
      touchUserSend: async () => {},
      emitProjection: ({ sessionId }) => {
        if (!coordinator.shouldQueueNewTurn(sessionId)) wakeOnProjection(sessionId);
      },
    });
    host.goalInputBlocked.mockImplementation(id => coordinator.shouldQueueNewTurn(id));
    const h = await start('codex', true);
    const dispatch = h.send.getMockImplementation()!;
    h.send.mockImplementation((message, options) => {
      dispatches.push('goal');
      return dispatch(message, options);
    });
    const wake = vi.fn((id: string) => { void h.controller.maybeContinueActiveGoal(id); });
    wakeOnProjection = wake;
    const continuationPreparing = vi.fn();
    const continuationAcquiredRoute = vi.fn();
    host.acquireGoalRoute.mockImplementation(acquireSendToSessionLock).mockImplementationOnce(async id => {
      continuationPreparing();
      // Place the ordinary send ahead of Goal at the async pre-lock boundary.
      await userDispatchStarted.promise;
      const release = await acquireSendToSessionLock(id);
      continuationAcquiredRoute();
      return release;
    });
    try {
      h.finish();
      await vi.advanceTimersByTimeAsync(200);
      expect(continuationPreparing).toHaveBeenCalledOnce();
      expect(await h.controller.getStatus('s1')).toMatchObject({ status: 'active', turnsUsed: 1 });
      coordinator.enqueue('s1', {
        clientId: 'ordinary',
        text: 'Ordinary input',
        persistedContent: 'Ordinary input',
        workingDir: '/repo',
        model: 'gpt-6',
        effort: 'medium',
        permissionMode: 'default',
        chatMessage: {
          clientId: 'ordinary', role: 'user', content: 'Ordinary input', isStreaming: false,
          createdAt: new Date(NOW).toISOString(),
        },
        createOpts: {
          agentKind: 'codex', workingDir: '/repo', model: 'gpt-6', effort: 'medium',
          permissionMode: 'default', userPrompt: '', makerMemoryEnabled: false,
        },
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(dispatches).toEqual(['user']);
      expect(coordinator.shouldQueueNewTurn('s1')).toBe(true);
      expect(wake).not.toHaveBeenCalled();
      expect(continuationAcquiredRoute).not.toHaveBeenCalled();

      if (scenario === 'ordinary-finishes-later') {
        settleUserSend.resolve();
        await vi.advanceTimersByTimeAsync(500);
        expect(continuationAcquiredRoute).toHaveBeenCalledOnce();
        expect(dispatches).toEqual(['user']);
      }

      userRunning = false;
      coordinator.onTurnEvent('s1', 'done');
      h.finishUser();
      expect(wake).toHaveBeenCalledWith('s1');
      expect(coordinator.shouldQueueNewTurn('s1')).toBe(false);
      await vi.advanceTimersByTimeAsync(200);

      if (scenario !== 'ordinary-finishes-later') {
        expect(continuationAcquiredRoute).not.toHaveBeenCalled();
        expect(dispatches).toEqual(['user']);
        if (scenario === 'paused') {
          await host.goalHandlers.get(MAKER_INVOKE.GOAL_PAUSE)!(null, 's1');
        }
        if (scenario === 'stopped') {
          await h.controller.pauseGoal('s1', 'paused: stopped by user');
          coordinator.stop('s1');
        }
        if (scenario === 'occupied') coordinator.setInteractionLock('s1', 'approval', true);
        settleUserSend.resolve();
        await vi.advanceTimersByTimeAsync(500);
        expect(continuationAcquiredRoute).toHaveBeenCalledOnce();
      }

      if (scenario === 'paused' || scenario === 'stopped') {
        expect(await h.controller.getStatus('s1')).toMatchObject({ status: 'paused', turnsUsed: 1 });
        expect(dispatches).toEqual(['user']);
        return;
      }
      if (scenario === 'occupied') {
        expect(dispatches).toEqual(['user']);
        const attempts = host.goalInputBlocked.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(host.goalInputBlocked).toHaveBeenCalledTimes(attempts);
        coordinator.setInteractionLock('s1', 'approval', false);
        await vi.advanceTimersByTimeAsync(500);
      }
      expect(await h.controller.getStatus('s1')).toMatchObject({ status: 'active', turnsUsed: 1 });
      expect(dispatches).toEqual(['user', 'goal']);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(dispatches).toEqual(['user', 'goal']);
    } finally {
      userDispatchStarted.resolve();
      settleUserSend.resolve();
    }
  });
});

afterEach(async () => {
  await resetGoalController();
  setCustomProviders([]);
  vi.useRealTimers();
});

// Regression: the real host wiring used exhausted subscription snapshots as admission
// decisions after success. Controller-only tests inject a different quota reader.
// This unit exercises startGoalController -> real controller -> persisted state/send;
// memory storage/session boundaries prevent live model requests or owner-data access.
describe('initial goal title over maker:goal:set', () => {
  it('waits for the initial title write before acknowledging the new goal', async () => {
    let remoteTitle = DEFAULT_DRAFT_SESSION_TITLE;
    const writeStarted = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    host.persistInitialTaskTitle.mockImplementation(async (_id, title, expected) => {
      writeStarted.resolve();
      await releaseWrite.promise;
      if (remoteTitle !== expected) return false;
      remoteTitle = title;
      return true;
    });
    let acknowledged = false;
    const creating = start('codex', true, true).then(() => { acknowledged = true; });
    await Promise.race([writeStarted.promise, creating]);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(acknowledged).toBe(false);
      expect(remoteTitle).toBe(DEFAULT_DRAFT_SESSION_TITLE);
    } finally {
      releaseWrite.resolve();
      await creating;
    }
    expect(remoteTitle).toBe('Finish the work');
    expect(host.persistInitialTaskTitle).toHaveBeenCalledWith(
      's1', 'Finish the work', DEFAULT_DRAFT_SESSION_TITLE,
    );
    expect(host.createMessage.mock.invocationCallOrder[0])
      .toBeLessThan(host.persistInitialTaskTitle.mock.invocationCallOrder[0]);
  });

  it('keeps the title when new-goal persistence races a manual rename', async () => {
    let remoteTitle = DEFAULT_DRAFT_SESSION_TITLE;
    host.createMessage.mockImplementationOnce(async () => { remoteTitle = 'My manual title'; });
    host.persistInitialTaskTitle.mockImplementation(async (_id, title, expected) => {
      if (remoteTitle !== expected) return false;
      remoteTitle = title;
      return true;
    });
    await start('codex', true, true);
    expect(remoteTitle).toBe('My manual title');
  });

  it('leaves desktop title generation and subsequent goal edits to their existing paths', async () => {
    await start('codex', true);
    await host.goalHandlers.get(MAKER_INVOKE.GOAL_SET)!(null, {
      sessionId: 's1', objective: 'A revised objective', persistInitialTitle: true,
    });
    expect(host.persistInitialTaskTitle).not.toHaveBeenCalled();
  });

  it('skips the title when the current database changes while the objective is saved', async () => {
    host.createMessage.mockImplementationOnce(async () => { host.dbOwner = {}; });
    await start('codex', true, true);
    expect(host.persistInitialTaskTitle).not.toHaveBeenCalled();
  });

  it('allows the goal to start when title storage fails', async () => {
    host.persistInitialTaskTitle.mockRejectedValueOnce(new Error('title store unavailable'));
    await start('codex', true, true);
    expect(host.goals.get('s1')?.objective).toBe('Finish the work');
    expect(host.persistInitialTaskTitle).toHaveBeenCalledTimes(1);
  });
});

describe('ChatGPT goal admission', () => {
  it.each([
    { agent: 'codex', provider: 'openai' },
    { agent: 'claude-code', provider: 'openai' },
    { agent: 'pi', provider: 'openai' },
    { agent: 'codex', provider: 'work-account' },
  ] as const)('lets the provider admit the next $agent turn on $provider despite advisory quota', async ({ agent, provider }) => {
    host.row.providerId = provider;
    const h = await start(agent);
    h.finish();
    await vi.advanceTimersByTimeAsync(200);
    expect(await h.controller.getStatus('s1')).toMatchObject({ status: 'active', usageResetAt: null });
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it('keeps a genuine rejection and its exhausted-window reset despite available credits', async () => {
    const h = await start();
    h.finish({ codexErrorInfo: 'usageLimitExceeded', message: 'Usage limit reached' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await h.controller.getStatus('s1')).toMatchObject({ status: 'usageLimited', usageResetAt: RESET });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('leaves a rejection without a trustworthy reset stopped instead of retrying from credit data', async () => {
    host.codex.mockResolvedValue({ primary: { usedPercent: 10, resetsAt: RESET / 1000 }, credits: { hasCredits: true, unlimited: false } });
    const h = await start();
    h.finish({ codexErrorInfo: 'usageLimitExceeded', message: 'Usage limit reached' });
    await vi.advanceTimersByTimeAsync(86400000);
    expect(await h.controller.getStatus('s1')).toMatchObject({ status: 'usageLimited', usageResetAt: null });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('retains proactive quota handling for other subscription families', async () => {
    host.row.providerId = 'anthropic';
    const h = await start('claude-code');
    h.finish();
    await vi.advanceTimersByTimeAsync(200);
    expect(await h.controller.getStatus('s1')).toMatchObject({ status: 'usageLimited', usageResetAt: RESET });
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});

// Unit regression: Go quota cards had a deadline, but the real Goal host never
// scheduled a continuation. Controller-only tests supply the deadline themselves.
describe('OpenCode Go goal recovery', () => {
  const fiveHours = 5 * 60 * 60 * 1000;
  const month = 30 * 24 * 60 * 60 * 1000;
  const rolling = { id: 'rolling', limited: true, usedPercent: 100, resetsAt: NOW + 43 * 60_000 } as const;
  const goError = { message: 'Go usage limit exceeded', errorStatus: 429 };

  beforeEach(() => {
    const provider = buildUserProvider({ id: 'my-go', name: 'My Go', runtimes: { pi: {
      baseUrl: 'https://opencode.ai/zen/go/v1', wireProtocol: 'openai-chat',
      models: [{ id: 'go-model', name: 'Go model' }],
    } } });
    setCustomProviders([provider]);
    host.row.providerId = provider.id;
    host.row.model = 'go-model';
    host.go.mockReset();
  });

  function quota(windows: OpenCodeGoUsageSnapshot['windows'], stale = false) {
    host.go.mockResolvedValue({
      status: 'ready', stale, snapshot: { kind: 'opencode-go-quota', fetchedAt: NOW, windows },
    });
  }

  it('waits for the rolling reset on the selected connection and sends the next goal turn once', async () => {
    quota([rolling, { id: 'weekly', limited: false, usedPercent: 42, resetsAt: RESET }]);
    const h = await start('pi');
    h.finish();
    await vi.advanceTimersByTimeAsync(200);
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(host.go).not.toHaveBeenCalled();
    h.finish(goError);
    await vi.advanceTimersByTimeAsync(rolling.resetsAt - Date.now() - 1);
    expect(await h.controller.getStatus('s1')).toMatchObject({ status: 'usageLimited', usageResetAt: rolling.resetsAt });
    expect(host.go).toHaveBeenCalledWith({ providerId: 'my-go', agent: 'pi' }, 'after-limit');
    expect(h.send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await h.controller.getStatus('s1')).toMatchObject({ status: 'active', usageResetAt: null });
    expect(h.send).toHaveBeenCalledTimes(3);
  });

  it('waits for all limited windows even when the monthly reset exceeds one native timer', async () => {
    quota([rolling, { id: 'monthly', limited: true, usedPercent: 99.9, resetsAt: NOW + month }]);
    const h = await start('pi');
    h.finish(goError);
    await vi.advanceTimersByTimeAsync(month - 1);
    expect(await h.controller.getStatus('s1')).toMatchObject({ status: 'usageLimited', usageResetAt: NOW + month });
    expect(h.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it('reads the rejecting engine’s Go connection when the goal was created on another engine', async () => {
    quota([rolling]);
    const h = await start('pi');
    const saved = host.goals.get('s1')!;
    host.goals.set('s1', { ...saved, agentKind: 'codex' });
    h.finish(goError);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.go).toHaveBeenCalledWith({ providerId: 'my-go', agent: 'pi' }, 'after-limit');
    expect(await h.controller.getStatus('s1')).toMatchObject({ status: 'usageLimited', usageResetAt: rolling.resetsAt });
  });

  it.each([
    { reason: 'missing reset', windows: [rolling, { ...rolling, id: 'weekly' as const, resetsAt: null }] },
    { reason: 'expired reset', windows: [{ ...rolling, resetsAt: NOW }] },
    { reason: 'stale snapshot', windows: [rolling], stale: true },
    { reason: 'ordinary rate limit', windows: [{ ...rolling, limited: false }] },
  ])('keeps manual recovery with a $reason despite a generic retry hint', async ({ windows, stale }) => {
    quota(windows, stale);
    const h = await start('pi');
    h.finish({ message: 'Too many requests. Try again in 30s', errorStatus: 429 });
    await vi.advanceTimersByTimeAsync(fiveHours);
    expect(await h.controller.getStatus('s1')).toMatchObject({ status: 'usageLimited', usageResetAt: null });
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  it('does not schedule a remote goal against a local connection with the same id', async () => {
    host.row.agentDeviceId = 'other-computer';
    quota([rolling]);
    const h = await start('pi');
    h.finish(goError);
    await vi.advanceTimersByTimeAsync(fiveHours);
    expect(await h.controller.getStatus('s1')).toMatchObject({ status: 'usageLimited', usageResetAt: null });
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(host.go).not.toHaveBeenCalled();
  });
});

// 2026-11-10 startup regression, unit: real host readiness must release pending
// reads only for its own controller lifetime. Prior tests always started first.
describe('Goal startup readiness', () => {
  it('releases a queued query when Goal starts, independently of Scheduler readiness', async () => {
    let finished = false;
    const pending = waitForGoalController().then(controller => { finished = true; return controller; });
    await Promise.resolve();
    expect(finished).toBe(false);
    const { controller } = await start();
    expect(await pending).toBe(controller);
  });

  it('rejects an old owner waiter on reset and allows a new waiter to reach the next controller', async () => {
    const rejected = expect(waitForGoalController()).rejects.toMatchObject({ name: 'GoalControllerDisposedError' });
    await resetGoalController();
    await rejected;
    const pending = waitForGoalController();
    const { controller } = await start();
    expect(await pending).toBe(controller);
  });

  it('times out without dispatching late work when startup never completes', async () => {
    const pending = waitForGoalController();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const { controller } = await start();
    expect(await waitForGoalController()).toBe(controller);
  });
});
