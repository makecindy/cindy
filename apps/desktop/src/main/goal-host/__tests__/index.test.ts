import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Maker } from '@cindy/maker-core';
import type { CodexAccountUsagePayload } from '../../usageBroadcaster';
import type { GoalState, SessionLike } from '../types';
import { getActiveCatalog, setCustomProviders } from '../../maker-host/active-catalog';

const host = vi.hoisted(() => ({
  goals: new Map<string, GoalState>(),
  row: { providerId: 'openai', model: 'gpt-6-astra', agentDeviceId: null as string | null },
  codex: vi.fn<() => Promise<CodexAccountUsagePayload | null>>(),
}));

vi.mock('../../logger.js', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {} }) }));
vi.mock('../../maker-ipc/register.js', () => ({
  hasRestoredCodexQuota: vi.fn(),
  acquirePendingAgentSwitchForDirectSend: async () => () => {},
  isSessionInTurn: () => false,
  ensureGoalInputReady: async () => true,
  isGoalInputBlocked: () => false,
  stopActiveGoalTurnForClear: async () => {},
  resolveSessionRuntimeRoute: () => ({ providerId: host.row.providerId, modelId: host.row.model }),
}));
vi.mock('../../device-link/sharedTaskDispatch.js', () => ({ isSessionSharedTaskActive: () => false }));
vi.mock('../../localDb/ipc/messages.js', () => ({ createMessage: async () => {} }));
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

import { resetGoalController, startGoalController } from '../index';

const NOW = Date.parse('2026-10-29T10:00:00Z');
const RESET = NOW + 7 * 24 * 60 * 60 * 1000;

async function start(agentKind: SessionLike['agentKind'] = 'codex') {
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
  await controller.setGoal({ sessionId: 's1', objective: 'Finish the work', agentKind });
  expect(send).toHaveBeenCalledTimes(1);
  return {
    controller, send,
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

afterEach(async () => {
  await resetGoalController();
  setCustomProviders([]);
  vi.useRealTimers();
});

// Regression: the real host wiring used exhausted subscription snapshots as admission
// decisions after success. Controller-only tests inject a different quota reader.
// This unit exercises startGoalController -> real controller -> persisted state/send;
// memory storage/session boundaries prevent live model requests or owner-data access.
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
