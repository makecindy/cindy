import { Session, type AgentEvent, type AgentSessionHandle } from '@cindy/maker-core';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { handleSessionEvent, type SessionEventDependencies } from '../sessionEventPipeline.js';
import { installSessionTurnObserver } from '../sessionTurnObserver.js';
import { createSessionBindingLifecycle } from '../sessionBindingLifecycle.js';
import { SessionTurnActivityTracker } from '../sessionTurnActivityTracker.js';
import { ProductTurnWallClockTracker, ProductTurnUsageTargetTracker } from '../turnWallClock.js';
import { ClaudeOutputLagTimingGuard } from '../../usage/modelUsageDelta.js';
import { createWorkerTurnStartSequencer } from '../workerTurnStartSequencer.js';

const effects = vi.hoisted(() => {
  const calls: string[] = [];
  const fns = new Map<string, ReturnType<typeof vi.fn>>();
  function fn(name: string) {
    if (!fns.has(name))
      fns.set(
        name,
        vi.fn(() => {
          calls.push(name);
        }),
      );
    return fns.get(name)!;
  }
  return { calls, fns, fn };
});
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../maker-host/auth-adapters.js', () => ({
  readClaudeApiKey: effects.fn('readClaudeApiKey'),
}));
vi.mock('../../sessionSpendBroadcaster.js', () => ({
  recordSessionTurnSpend: effects.fn('recordSessionTurnSpend'),
  recordSessionTurnTokens: effects.fn('recordSessionTurnTokens'),
  recordSessionContextSnapshot: effects.fn('recordSessionContextSnapshot'),
}));
vi.mock('../../turnCostBroadcaster.js', () => ({
  recordSchedulerTurnCost: effects.fn('recordSchedulerTurnCost'),
  recordTurnUsageOnMessage: effects.fn('recordTurnUsageOnMessage'),
  codexUsageToTokens: effects.fn('codexUsageToTokens'),
  piUsageToTokens: effects.fn('piUsageToTokens'),
}));
vi.mock('../../modelMismatchBroadcaster.js', () => ({
  recordModelMismatchOnMessage: effects.fn('recordModelMismatchOnMessage'),
}));
vi.mock('../../usage/claudeAccountUsage.js', () => ({
  triggerClaudeAccountUsageRefresh: effects.fn('triggerClaudeAccountUsageRefresh'),
}));
vi.mock('../../usage/modelPricing.js', () => ({
  getGatewayModelPricing: effects.fn('getGatewayModelPricing'),
  isModelPricingRefreshInFlight: effects.fn('isModelPricingRefreshInFlight'),
  getGatewayAccountCurrency: effects.fn('getGatewayAccountCurrency'),
  getGatewayModelPricingForModel: effects.fn('getGatewayModelPricingForModel'),
  getModelPriceQuote: effects.fn('getModelPriceQuote'),
}));
vi.mock('../../usage/referenceModelPricing.js', () => ({
  readModelPriceOverridesSnapshot: effects.fn('readModelPriceOverridesSnapshot'),
  getClaudeSubscriptionValuePrice: effects.fn('getClaudeSubscriptionValuePrice'),
  getCodexSubscriptionValuePrice: effects.fn('getCodexSubscriptionValuePrice'),
  getReferenceModelPricing: effects.fn('getReferenceModelPricing'),
  getCodexProviderSubscriptionValuePrice: effects.fn('getCodexProviderSubscriptionValuePrice'),
  getSubscriptionDirectValuePrice: effects.fn('getSubscriptionDirectValuePrice'),
}));
vi.mock('../../usage/ledgerCurrency.js', () => ({
  currentLedgerCurrency: effects.fn('currentLedgerCurrency'),
}));
vi.mock('../usage.js', () => ({
  triggerClaudeSubscriptionUsageRefresh: effects.fn('triggerClaudeSubscriptionUsageRefresh'),
  triggerCodexAccountUsageRefresh: effects.fn('triggerCodexAccountUsageRefresh'),
  triggerXaiSubscriptionUsageRefresh: effects.fn('triggerXaiSubscriptionUsageRefresh'),
}));
vi.mock('../../usageBroadcaster.js', () => ({
  rebroadcastTodaySpend: effects.fn('rebroadcastTodaySpend'),
  recordModelTurnUsage: effects.fn('recordModelTurnUsage'),
  recordTurnSpend: effects.fn('recordTurnSpend'),
  rebroadcastCodexTodayUsage: effects.fn('rebroadcastCodexTodayUsage'),
  recordCodexTurnUsage: effects.fn('recordCodexTurnUsage'),
  recordCodexAccountUsageSnapshot: effects.fn('recordCodexAccountUsageSnapshot'),
}));
vi.mock('../schedule.js', () => ({
  broadcastSchedulerChanged: effects.fn('broadcastSchedulerChanged'),
}));
vi.mock('../../maker-host/session-provider-store.js', () => ({
  getSessionProvider: effects.fn('getSessionProvider'),
}));
vi.mock('../../maker-host/active-catalog.js', () => ({
  getActiveCatalog: effects.fn('getActiveCatalog'),
}));
vi.mock('../../maker-host/claude-session-route-registry.js', () => ({
  readClaudeSessionRoute: effects.fn('readClaudeSessionRoute'),
}));
vi.mock('../../maker-host/codex-proxy-host.js', () => ({
  getCodexProxyAuthInjection: effects.fn('getCodexProxyAuthInjection'),
}));
vi.mock('../../maker-host/provider-route.js', () => ({
  isUserProviderSession: effects.fn('isUserProviderSession'),
}));
vi.mock('../../messagePersistBroadcaster.js', () => ({
  reserveTurnErrorPersistId: effects.fn('reserveTurnErrorPersistId'),
  backgroundTurnPredatesSessionClear: effects.fn('backgroundTurnPredatesSessionClear'),
  noteAgentMeta: effects.fn('noteAgentMeta'),
  noteTurnStarted: effects.fn('noteTurnStarted'),
  enqueueDurableWrite: effects.fn('enqueueDurableWrite'),
  flushAssistantBlock: effects.fn('flushAssistantBlock'),
  onAssistantTextEvent: effects.fn('onAssistantTextEvent'),
  onAgentTaskUpdateEvent: effects.fn('onAgentTaskUpdateEvent'),
  onThinkingEvent: effects.fn('onThinkingEvent'),
  onToolResultEvent: effects.fn('onToolResultEvent'),
  onToolResultFullEvent: effects.fn('onToolResultFullEvent'),
  onToolUseEvent: effects.fn('onToolUseEvent'),
  consumeLastAssistantPersistId: effects.fn('consumeLastAssistantPersistId'),
  consumeLastTopLevelAssistantPersistId: effects.fn('consumeLastTopLevelAssistantPersistId'),
  drainPersistQueue: effects.fn('drainPersistQueue'),
  flushOrphanToolResults: effects.fn('flushOrphanToolResults'),
  isSuccessfulCodexDoneEventData: effects.fn('isSuccessfulCodexDoneEventData'),
  markAssistantTurnCompleted: effects.fn('markAssistantTurnCompleted'),
  markAssistantTurnFailed: effects.fn('markAssistantTurnFailed'),
  clearCodexPlanRowsForSession: effects.fn('clearCodexPlanRowsForSession'),
  persistCodexPlanOnDone: effects.fn('persistCodexPlanOnDone'),
  persistCodexPlanOnTerminalError: effects.fn('persistCodexPlanOnTerminalError'),
  preserveTurnPersistStateForBackground: effects.fn('preserveTurnPersistStateForBackground'),
  onTurnErrorEvent: effects.fn('onTurnErrorEvent'),
  releaseReservedTurnErrorPersistId: effects.fn('releaseReservedTurnErrorPersistId'),
  resetTurnPersistState: effects.fn('resetTurnPersistState'),
  saveTurnStartedAtForDeferred: effects.fn('saveTurnStartedAtForDeferred'),
}));
vi.mock('../../maker-host/claude-session-background-activity.js', () => ({
  noteClaudeSessionTurnState: effects.fn('noteClaudeSessionTurnState'),
}));
vi.mock('../../subagentObservationRewindFence.js', () => ({
  noteSubagentObservationTurnStarted: effects.fn('noteSubagentObservationTurnStarted'),
  captureSubagentObservationGeneration: effects.fn('captureSubagentObservationGeneration'),
  enqueueSubagentObservationWrite: effects.fn('enqueueSubagentObservationWrite'),
}));
vi.mock('../../localDb/ipc/sessions.js', () => ({
  persistSessionFields: effects.fn('persistSessionFields'),
}));
vi.mock('../../localDb/sessionActiveTurn.js', () => ({
  markSessionTurnStarted: effects.fn('markSessionTurnStarted'),
}));
vi.mock('../../remote-ssh/index.js', () => ({
  isCcMgrUpgradeInFlight: effects.fn('isCcMgrUpgradeInFlight'),
}));
vi.mock('../promptPredictionStopLedger.js', () => ({
  clearPromptPredictionSessionStopped: effects.fn('clearPromptPredictionSessionStopped'),
}));
vi.mock('../../turn-change-set/store.js', () => ({
  finalizeTurnChangeSet: effects.fn('finalizeTurnChangeSet'),
}));
vi.mock('../../maker-host/session-effort-store.js', () => ({
  getSessionFastMode: effects.fn('getSessionFastMode'),
}));
vi.mock('../../maker-host/claude-gateway-error-observer.js', () => ({
  consumeClaudeOpusPlanMismatch: effects.fn('consumeClaudeOpusPlanMismatch'),
}));
vi.mock('../../maker-host/catalog-to-descriptors.js', () => ({
  resolveVerifiedContextWindow: effects.fn('resolveVerifiedContextWindow'),
}));
vi.mock('../../localDb/subagentRuns.js', () => ({
  persistSubagentTaskUpdate: effects.fn('persistSubagentTaskUpdate'),
}));
vi.mock('../../localDb/ipc/subagentRuns.js', () => ({
  broadcastSubagentRunsChanged: effects.fn('broadcastSubagentRunsChanged'),
}));
vi.mock('../../sessionTaskSummary.js', () => ({
  maybeGenerateSessionTaskSummary: effects.fn('maybeGenerateSessionTaskSummary'),
  refreshSessionListPreview: effects.fn('refreshSessionListPreview'),
}));
vi.mock('../../cindy-brain/index.js', () => ({
  hasEnabledGhostAssistantHook: effects.fn('hasEnabledGhostAssistantHook'),
  runGhostAssistantReplyHook: effects.fn('runGhostAssistantReplyHook'),
}));
vi.mock('../../cindy-brain/subscriptionGateway.js', () => ({
  withGhostAssistantHookModel: effects.fn('withGhostAssistantHookModel'),
}));
vi.mock('../../maker-host/model-route-guard-live.js', () => ({
  verdictForModelRoute: effects.fn('verdictForModelRoute'),
}));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function microtasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function event(
  type: AgentEvent['type'],
  data: unknown = {},
  extra: Partial<AgentEvent> = {},
): AgentEvent {
  return { type, source: 'codex', data, ...extra } as AgentEvent;
}

function harness() {
  const log = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => log,
  };
  const ended = deferred();
  const handle = {
    id: 'provider',
    agentKind: 'codex',
    model: 'test-model',
    send: vi.fn(async () => {}),
    close: vi.fn(async () => {
      ended.resolve();
    }),
    setInteractionResolver: vi.fn(),
    async *events() {
      await ended.promise;
      yield* [] as AgentEvent[];
    },
  } as unknown as AgentSessionHandle;
  const session = new Session({
    id: 'task',
    agentKind: 'codex',
    workDir: '/unused',
    handle,
    capabilities: {} as never,
    logger: log,
    turnStallMs: 0,
  });
  const activity = new SessionTurnActivityTracker();
  const deps = {
    log,
    isFencedStaleSessionTerminal: vi.fn(() => false),
    redactEventForRenderer: vi.fn((value: AgentEvent) => ({ ...value, data: { redacted: true } })),
    interruptedTurnAutoResumeGuard: {
      noteAttemptEvent: vi.fn(),
      noteTurnStarted: vi.fn(),
      noteAttemptSettled: vi.fn(),
      noteProgress: vi.fn(() => true),
    },
    handleAgentIslandInteractionDismissed: vi.fn(),
    clearPendingInteraction: vi.fn(() => null),
    defaultDecisionForPending: vi.fn(),
    persistInteractionDecision: vi.fn(),
    broadcastToAllWindows: effects.fn('broadcast'),
    broadcastCodexImageAsToolResult: vi.fn(async () => {}),
    autoResumeBookkeeping: {
      discardReplacementProvenByProviderEvent: vi.fn(),
      clearFailedTurnCompletionTail: vi.fn(),
      settleOutcome: vi.fn(),
      noteFailedTurnCompletionTail: vi.fn(),
      stashSuppressedError: vi.fn(),
      stashOrcaSuppressedTerminal: vi.fn(() => true),
      consumeFailedTurnCompletionTail: vi.fn(() => false),
      hasSuppressedError: vi.fn(() => false),
    },
    pendingFailedTurnAssistantPersistId: new Map<string, string>(),
    silentStopAutoResumeGuard: { noteTurnStarted: vi.fn() },
    sessionTurnActivityTracker: activity,
    productTurnWallClockTracker: new ProductTurnWallClockTracker(),
    productTurnUsageTargetTracker: new ProductTurnUsageTargetTracker(),
    advanceSessionTurnBoundaryGeneration: vi.fn(() => 1),
    gitSnapshotCoordinator: {
      hasPendingTurnStart: vi.fn(() => false),
      onTurnStart: effects.fn('git-start'),
      onTurnEnd: effects.fn('git-end'),
      onTurnAbort: effects.fn('git-abort'),
    },
    workerTurnStartSequencer: createWorkerTurnStartSequencer(log),
    orcaTeamServiceForEvents: {
      handleWorkerTurnStarted: effects.fn('worker-start'),
      captureWorkerText: vi.fn(),
      captureWorkerTerminalTurn: vi.fn(() => ({ owner: 'old-turn' })),
      handleWorkerTerminalTurn: effects.fn('worker-terminal'),
    },
    turnModelPromiseBySession: new Map<string, Promise<string>>(),
    readSessionModelForUsage: vi.fn(async () => 'test-model'),
    turnPiFastModeBySession: new Map<string, boolean>(),
    silentStopTurnLeaseGate: { turnLeaseIdForEvent: vi.fn(() => 'instance:1') },
    agentInputCoordinatorHolder: {
      onTurnEvent: vi.fn(),
      noteSuppressedTerminalError: vi.fn(),
      onExternalTurnSettled: vi.fn(),
      isAutoResumePending: vi.fn(() => false),
      isAutoResumeDeferred: vi.fn(() => false),
      getAutoResumeAttemptToken: vi.fn(() => 5),
      getAutoResumeDeferredOwner: vi.fn(() => null),
    },
    handleSilentStopTurnEnd: vi.fn(async () => {}),
    isRemoteAuthRetryErrorEvent: vi.fn(() => false),
    isGatewayProxyTokenRecoveryErrorEvent: vi.fn(() => false),
    overflowSuppressedBroadcasts: new Map(),
    handleAgentIslandEventAfterBroadcast: effects.fn('island'),
    notifyGoalIdleAfterTurnSettled: vi.fn(() => {
      expect(activity.isSessionInTurn('task')).toBe(false);
      effects.calls.push('goal');
    }),
    settlePendingCredentialSwitch: effects.fn('credentials'),
    settlePendingSessionRuntimeControlHolder: effects.fn('runtime'),
    deferredCodexRestartHolder: null,
    refreshRemoteCodexMcpOnTurnSettledHolder: null,
    markTurnEndedAfterPersistDrain: effects.fn('turn-drain'),
    contextOverflowRolloverHolder: null,
    lastReportedModelUsageBySession: new Map(),
    claudeOutputLagTimingGuard: new ClaudeOutputLagTimingGuard(),
    lastReportedCostUsdBySession: new Map<string, number>(),
    unpricedSubscriptionValueMarker: () => ({
      amount: 0,
      currency: 'USD',
      approximate: true,
      kind: 'value-estimate',
      estimateReasons: ['subscription-value'],
    }),
  };
  // External services are reduced to their public event-facing methods. Session,
  // activity, wall clock, usage target and worker sequencing above are real.
  const dependencies = deps as unknown as SessionEventDependencies;
  const emit = (value: AgentEvent) => handleSessionEvent(dependencies, session, value);
  return {
    deps,
    dependencies,
    activity,
    session,
    handle,
    emit,
    dispose: async () => {
      activity.deleteSession('task');
      await session.close();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const [name, fn] of effects.fns)
    fn.mockReset().mockImplementation(() => {
      effects.calls.push(name);
    });
  effects.calls.length = 0;
  for (const name of [
    'drainPersistQueue',
    'recordModelTurnUsage',
    'recordTurnUsageOnMessage',
    'recordSchedulerTurnCost',
    'persistSessionFields',
    'getGatewayModelPricingForModel',
  ])
    effects.fn(name).mockResolvedValue(undefined);
  effects.fn('getActiveCatalog').mockReturnValue({ providers: [] });
  effects.fn('currentLedgerCurrency').mockReturnValue('USD');
  effects.fn('reserveTurnErrorPersistId').mockImplementation(() => {
    effects.calls.push('reserve');
    return 'error-row';
  });
  effects.fn('onAssistantTextEvent').mockReturnValue('assistant-row');
  effects.fn('onToolUseEvent').mockReturnValue('tool-row');
  effects.fn('isSuccessfulCodexDoneEventData').mockReturnValue(true);
  effects.fn('verdictForModelRoute').mockResolvedValue({ kind: 'pass' });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function ordered(...names: string[]) {
  let previous = -1;
  for (const name of names) {
    const index = effects.calls.indexOf(name);
    expect(index, name).toBeGreaterThan(previous);
    previous = index;
  }
}

describe('production Session event pipeline', () => {
  it('keeps continuation segments running, then seals the final product boundary', async () => {
    const h = harness();
    vi.setSystemTime(1000);
    h.emit(event('status', { isRunning: true }, { source: 'claude-code' }));
    effects.fn('consumeLastAssistantPersistId').mockReturnValueOnce('segment-row');
    vi.setSystemTime(3000);
    h.emit(event('done', {}, { source: 'claude-code', turnContinuationId: 0 }));
    expect(h.activity.isSessionInTurn('task')).toBe(true);
    expect(h.deps.notifyGoalIdleAfterTurnSettled).not.toHaveBeenCalled();
    expect(effects.fn('turn-drain')).not.toHaveBeenCalled();
    expect(h.deps.gitSnapshotCoordinator.onTurnEnd).not.toHaveBeenCalled();
    expect(effects.fn('clearCodexPlanRowsForSession')).not.toHaveBeenCalled();
    expect(effects.fn('resetTurnPersistState')).toHaveBeenCalledOnce();
    await microtasks();
    expect(h.deps.orcaTeamServiceForEvents.handleWorkerTerminalTurn).not.toHaveBeenCalled();
    effects.fn('recordTurnUsageOnMessage').mockClear();
    vi.setSystemTime(5000);
    h.emit(event('done', { total_cost_usd: 0, duration_ms: 20 }, { source: 'claude-code' }));
    expect(h.activity.isSessionInTurn('task')).toBe(false);
    expect(h.deps.notifyGoalIdleAfterTurnSettled).toHaveBeenCalledOnce();
    await microtasks();
    expect(effects.fn('recordTurnUsageOnMessage')).toHaveBeenCalledWith({
      sessionId: 'task',
      clientId: 'segment-row',
      turnUsageDetails: expect.objectContaining({ turnDurationMs: 4000 }),
    });
    await h.dispose();
  });

  it('keeps the silent-stop decision window running and rejects an unowned late terminal', async () => {
    const h = harness();
    h.emit(event('done', { silentStop: true }));
    expect(h.activity.isSessionInTurn('task')).toBe(true);
    expect(h.deps.notifyGoalIdleAfterTurnSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.deps.handleSilentStopTurnEnd).toHaveBeenCalledOnce();
    h.deps.silentStopTurnLeaseGate.turnLeaseIdForEvent.mockReturnValue(undefined as never);
    effects.fn('broadcast').mockClear();
    h.emit(event('done', { silentStop: true }));
    expect(effects.fn('broadcast')).not.toHaveBeenCalled();
    await h.dispose();
  });

  it('records context after status delivery and preserves Pi runtime context windows', async () => {
    const h = harness();
    Object.defineProperty(h.session, 'agentKind', { value: 'pi' });
    effects.fn('resolveVerifiedContextWindow').mockReturnValue(99999);
    h.emit(
      event(
        'status',
        { isRunning: false, status: 'Done', contextTokens: 50, contextWindow: 12345 },
        { source: 'pi' },
      ),
    );
    ordered('broadcast', 'recordSessionContextSnapshot');
    expect(effects.fn('recordSessionContextSnapshot')).toHaveBeenCalledWith('task', 50, 12345);
    await h.dispose();
  });

  it('prefers the verified context window for a non-Pi session', async () => {
    const h = harness();
    effects.fn('resolveVerifiedContextWindow').mockReturnValue(99999);
    h.emit(
      event(
        'status',
        { isRunning: false, status: 'Done', contextTokens: 50, contextWindow: 12345 },
        { source: 'claude-code' },
      ),
    );
    expect(effects.fn('recordSessionContextSnapshot')).toHaveBeenCalledWith('task', 50, 99999);
    await h.dispose();
  });

  it('keeps a retryable error running without resetting persistence', async () => {
    const h = harness();
    h.activity.setSessionInTurn('task', true);
    h.emit(event('error', { message: 'retrying', isTerminal: false }));
    expect(h.activity.isSessionInTurn('task')).toBe(true);
    expect(h.deps.notifyGoalIdleAfterTurnSettled).not.toHaveBeenCalled();
    expect(effects.fn('resetTurnPersistState')).not.toHaveBeenCalled();
    expect(effects.fn('turn-drain')).not.toHaveBeenCalled();
    expect(h.deps.gitSnapshotCoordinator.onTurnAbort).not.toHaveBeenCalled();
    expect(effects.fn('broadcast')).toHaveBeenCalledOnce();
    await h.dispose();
  });

  it('reserves the live error identity before delivery, then seals and persists before drain/reset', async () => {
    const h = harness();
    h.activity.setSessionInTurn('task', true);
    effects.fn('consumeLastAssistantPersistId').mockReturnValue('assistant-row');
    effects.fn('consumeLastTopLevelAssistantPersistId').mockReturnValue('assistant-row');
    h.emit(event('error', { message: 'provider secret', reason: 'sdk_crash' }));
    ordered(
      'reserve',
      'broadcast',
      'island',
      'goal',
      'credentials',
      'runtime',
      'git-abort',
      'flushAssistantBlock',
      'flushOrphanToolResults',
      'markAssistantTurnFailed',
      'onTurnErrorEvent',
      'persistCodexPlanOnTerminalError',
      'turn-drain',
      'clearCodexPlanRowsForSession',
      'preserveTurnPersistStateForBackground',
      'resetTurnPersistState',
    );
    expect(effects.fn('broadcast')).toHaveBeenCalledWith(
      'maker:event',
      expect.objectContaining({
        event: expect.objectContaining({ data: { redacted: true } }),
        persistId: 'error-row',
      }),
    );
    expect(effects.fn('onTurnErrorEvent')).toHaveBeenCalledWith(
      'task',
      { message: 'provider secret', reason: 'sdk_crash' },
      null,
      'error-row',
    );
    await h.dispose();
  });

  it.each([true, false])(
    'rechecks recovery after delivery changes pending to %s',
    async (pendingAfter) => {
      const h = harness();
      h.deps.agentInputCoordinatorHolder.isAutoResumePending.mockReturnValue(!pendingAfter);
      h.deps.broadcastToAllWindows.mockImplementation(() => {
        h.deps.agentInputCoordinatorHolder.isAutoResumePending.mockReturnValue(pendingAfter);
      });
      h.emit(event('error', { message: 'failed', reason: 'sdk_crash' }));
      expect(effects.fn('reserveTurnErrorPersistId')).toHaveBeenCalledTimes(pendingAfter ? 1 : 0);
      expect(effects.fn('onTurnErrorEvent')).toHaveBeenCalledTimes(pendingAfter ? 0 : 1);
      expect(effects.fn('releaseReservedTurnErrorPersistId')).toHaveBeenCalledTimes(
        pendingAfter ? 1 : 0,
      );
      expect(h.deps.autoResumeBookkeeping.stashSuppressedError).toHaveBeenCalledTimes(
        pendingAfter ? 1 : 0,
      );
      await h.dispose();
    },
  );

  it('keeps deferred error and its paired done out of Orca terminal handling and preserves the failure seal', async () => {
    const h = harness();
    h.deps.agentInputCoordinatorHolder.isAutoResumeDeferred.mockReturnValue(true);
    effects.fn('consumeLastAssistantPersistId').mockReturnValueOnce('failed-row');
    effects.fn('consumeLastTopLevelAssistantPersistId').mockReturnValue('failed-row');
    h.emit(event('error', { reason: 'sdk_crash' }, { sessionTurnGeneration: 4 }));
    h.deps.autoResumeBookkeeping.consumeFailedTurnCompletionTail.mockReturnValue(true);
    h.emit(event('done', {}, { sessionTurnGeneration: 4 }));
    await microtasks();
    expect(effects.fn('markAssistantTurnFailed')).toHaveBeenCalledOnce();
    expect(effects.fn('markAssistantTurnCompleted')).not.toHaveBeenCalled();
    expect(h.deps.autoResumeBookkeeping.stashOrcaSuppressedTerminal).toHaveBeenCalledOnce();
    expect(h.deps.orcaTeamServiceForEvents.handleWorkerTerminalTurn).not.toHaveBeenCalled();
    await h.dispose();
  });

  it.each(['failed', 'interrupted'])(
    'seals a Codex %s done without a preceding error as failed',
    async (status) => {
      const h = harness();
      effects.fn('isSuccessfulCodexDoneEventData').mockReturnValue(false);
      effects.fn('consumeLastTopLevelAssistantPersistId').mockReturnValueOnce('failed-row');
      h.emit(event('done', { raw: { id: 'turn', status } }));
      expect(effects.fn('isSuccessfulCodexDoneEventData')).toHaveBeenCalledWith({
        raw: { id: 'turn', status },
      });
      expect(effects.fn('markAssistantTurnFailed')).toHaveBeenCalledWith('task', 'failed-row');
      expect(effects.fn('markAssistantTurnCompleted')).not.toHaveBeenCalled();
      await h.dispose();
    },
  );

  it('passes the native fork anchor to the successful assistant seal after flushing tools', async () => {
    const h = harness();
    const nativeForkAnchor = {
      agentKind: 'codex',
      sdkSessionId: 'thread',
      kind: 'turn',
      id: 'turn',
    };
    effects.fn('consumeLastTopLevelAssistantPersistId').mockReturnValueOnce('completed-row');
    h.emit({ ...event('done'), agentMeta: { nativeForkAnchor } } as AgentEvent);
    expect(effects.fn('markAssistantTurnCompleted')).toHaveBeenCalledWith('task', 'completed-row', {
      nativeForkAnchor,
    });
    expect(effects.fn('markAssistantTurnFailed')).not.toHaveBeenCalled();
    ordered('flushOrphanToolResults', 'markAssistantTurnCompleted', 'resetTurnPersistState');
    await h.dispose();
  });

  it.each([true, false])(
    'carries remote-auth recovery classification through persistence (%s)',
    async (retry) => {
      const h = harness();
      h.deps.isRemoteAuthRetryErrorEvent.mockReturnValue(retry);
      h.emit(event('error', { message: 'auth expired', reason: 'sdk_crash' }));
      expect(effects.fn('reserveTurnErrorPersistId')).toHaveBeenCalledTimes(retry ? 0 : 1);
      expect(effects.fn('onTurnErrorEvent')).toHaveBeenCalledTimes(retry ? 0 : 1);
      expect(effects.fn('saveTurnStartedAtForDeferred')).toHaveBeenCalledTimes(retry ? 1 : 0);
      if (retry) ordered('saveTurnStartedAtForDeferred', 'resetTurnPersistState');
      await h.dispose();
    },
  );

  it.each([true, false])(
    'only counts foreground substantive output as retry progress (%s)',
    async (background) => {
      const h = harness();
      effects.fn('onToolUseEvent').mockImplementation(() => {
        effects.calls.push('tool');
        return 'tool-row';
      });
      h.deps.interruptedTurnAutoResumeGuard.noteProgress.mockImplementation(() => {
        effects.calls.push('progress');
        return true;
      });
      h.emit(
        event(
          'tool_use',
          { toolUseId: 'tool', toolName: 'read' },
          background ? { turnScope: 'background' } : {},
        ),
      );
      expect(h.deps.interruptedTurnAutoResumeGuard.noteProgress).toHaveBeenCalledTimes(
        background ? 0 : 1,
      );
      if (!background) ordered('progress', 'tool', 'broadcast');
      await h.dispose();
    },
  );

  it('flushes assistant before foreground tool use, without flushing the current turn for background tools', async () => {
    const h = harness();
    effects.fn('onToolUseEvent').mockImplementation(() => {
      effects.calls.push('tool');
      return 'tool-row';
    });
    h.emit(event('text', { text: 'hello' }));
    effects.calls.length = 0;
    h.emit(event('tool_use', { toolUseId: 'tool', toolName: 'read' }));
    ordered('flushAssistantBlock', 'tool', 'broadcast');
    effects.fn('flushAssistantBlock').mockClear();
    h.emit(event('tool_use', { toolUseId: 'background' }, { turnScope: 'background' }));
    expect(effects.fn('flushAssistantBlock')).not.toHaveBeenCalled();
    expect(effects.fn('broadcast')).toHaveBeenLastCalledWith(
      'maker:event',
      expect.objectContaining({ persistId: 'tool-row' }),
    );
    await h.dispose();
  });

  it.each(['stale', 'cleared-background', 'turn-diff'] as const)(
    'drops %s before downstream state and delivery',
    async (kind) => {
      const h = harness();
      if (kind === 'stale') h.deps.isFencedStaleSessionTerminal.mockReturnValue(true);
      if (kind === 'cleared-background')
        effects.fn('backgroundTurnPredatesSessionClear').mockReturnValue(true);
      h.emit(
        kind === 'turn-diff'
          ? event('turn_diff')
          : event(
              'done',
              {},
              kind === 'cleared-background'
                ? { turnScope: 'background', backgroundTurnStartedAt: 1 }
                : {},
            ),
      );
      expect(effects.fn('broadcast')).not.toHaveBeenCalled();
      expect(h.deps.agentInputCoordinatorHolder.onTurnEvent).not.toHaveBeenCalled();
      expect(effects.fn('flushAssistantBlock')).not.toHaveBeenCalled();
      await h.dispose();
    },
  );

  it('broadcasts background status without starting or settling the product turn', async () => {
    const h = harness();
    h.emit(event('status', { isRunning: true }, { turnScope: 'background' }));
    h.emit(event('status', { isRunning: false }, { turnScope: 'background' }));
    expect(h.activity.isSessionInTurn('task')).toBe(false);
    expect(effects.fn('noteTurnStarted')).not.toHaveBeenCalled();
    expect(effects.fn('turn-drain')).not.toHaveBeenCalled();
    expect(effects.fn('broadcast')).toHaveBeenCalledTimes(2);
    await h.dispose();
  });

  it('waits for accepted persistence and worker start while returning synchronously', async () => {
    const h = harness(),
      writes = deferred(),
      start = deferred();
    effects.fn('drainPersistQueue').mockReturnValue(writes.promise);
    h.deps.orcaTeamServiceForEvents.handleWorkerTurnStarted.mockReturnValue(start.promise);
    h.emit(event('status', { isRunning: true }));
    effects.calls.length = 0;
    expect(h.emit(event('done'))).toBeUndefined();
    ordered(
      'broadcast',
      'island',
      'goal',
      'git-end',
      'flushAssistantBlock',
      'persistCodexPlanOnDone',
      'turn-drain',
      'resetTurnPersistState',
    );
    expect(effects.fn('refreshSessionListPreview')).not.toHaveBeenCalled();
    expect(h.deps.orcaTeamServiceForEvents.handleWorkerTerminalTurn).not.toHaveBeenCalled();
    h.deps.orcaTeamServiceForEvents.captureWorkerTerminalTurn.mockReturnValue({
      owner: 'new-turn',
    });
    start.resolve();
    writes.resolve();
    await microtasks();
    expect(h.deps.orcaTeamServiceForEvents.handleWorkerTerminalTurn).toHaveBeenCalledWith(
      expect.objectContaining({ capture: { owner: 'old-turn' } }),
    );
    expect(effects.fn('refreshSessionListPreview')).toHaveBeenCalledOnce();
    expect(effects.fn('maybeGenerateSessionTaskSummary')).toHaveBeenCalledWith('task', {
      force: true,
    });
    await h.dispose();
  });

  it.each([null, 'ssh-host'])(
    'only records local Codex account snapshots (remote=%s)',
    async (remoteHostId) => {
      const h = harness();
      Object.defineProperty(h.session, 'remoteHostId', { value: remoteHostId });
      h.emit(event('account_usage', { remaining: 42 }));
      expect(effects.fn('recordCodexAccountUsageSnapshot')).toHaveBeenCalledTimes(
        remoteHostId ? 0 : 1,
      );
      if (!remoteHostId) ordered('broadcast', 'recordCodexAccountUsageSnapshot');
      await h.dispose();
    },
  );
});

describe('provider turn observer on real Session.send', () => {
  function observerDeps() {
    return {
      log: { debug: vi.fn() },
      providerTurnLeaseId: (id: string, turn: number) => `${id}:${turn}`,
      silentStopTurnLeaseGate: {
        supersede: vi.fn(),
        supersedeOwnedBy: vi.fn(),
        schedule: vi.fn(() => true),
      },
      sessionTurnLeaseTracker: {
        markTurnStarted: vi.fn(async () => {
          effects.calls.push('lease-start');
        }),
        markTurnEnded: vi.fn(async () => {}),
      },
    };
  }
  it.each(['reject', 'reroute'] as const)(
    'stops a paid-model %s before lease and provider dispatch',
    async (kind) => {
      const h = harness(),
        deps = observerDeps();
      effects
        .fn('verdictForModelRoute')
        .mockResolvedValue({ kind, reason: 'payment-required', providerId: 'other' });
      const dispose = installSessionTurnObserver(deps, h.session);
      await expect(h.session.send('test')).rejects.toThrow(
        kind === 'reject' ? 'requires paid access' : 'must switch',
      );
      expect(deps.sessionTurnLeaseTracker.markTurnStarted).not.toHaveBeenCalled();
      expect(h.handle.send).not.toHaveBeenCalled();
      dispose();
      await h.dispose();
    },
  );
  it('waits for permission and lease before dispatch, and tears down the owned lease', async () => {
    const h = harness(),
      deps = observerDeps(),
      permission = deferred();
    effects.fn('verdictForModelRoute').mockImplementation(async () => {
      await permission.promise;
      effects.calls.push('permission');
      return { kind: 'pass' };
    });
    vi.mocked(h.handle.send).mockImplementation(async () => {
      effects.calls.push('provider-send');
    });
    const dispose = installSessionTurnObserver(deps, h.session);
    const sending = h.session.send('test');
    await microtasks();
    expect(h.handle.send).not.toHaveBeenCalled();
    permission.resolve();
    await sending;
    ordered('permission', 'lease-start', 'provider-send');
    dispose();
    expect(deps.silentStopTurnLeaseGate.supersedeOwnedBy).toHaveBeenCalledWith(
      'task',
      `${h.session.instanceId}:`,
    );
    await h.dispose();
  });
  it('leaves remote provider admission and leases to the remote host', async () => {
    const h = harness(),
      deps = observerDeps();
    Object.defineProperty(h.session, 'remoteHostId', { value: 'ssh-host' });
    const dispose = installSessionTurnObserver(deps, h.session);
    await h.session.send('remote');
    expect(effects.fn('verdictForModelRoute')).not.toHaveBeenCalled();
    expect(deps.sessionTurnLeaseTracker.markTurnStarted).not.toHaveBeenCalled();
    expect(h.handle.send).toHaveBeenCalledOnce();
    dispose();
    await h.dispose();
  });
});

describe('usage through the production event pipeline', () => {
  const tokens = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheCreateTokens: 0 };
  const segment = { ...tokens, model: 'test-model', priceVariant: 'standard' };
  function usage(source: 'codex' | 'pi') {
    return source === 'codex'
      ? { promptTokens: 100, completionTokens: 20, cachedTokens: 10, segments: [segment] }
      : { ...tokens, segments: [segment], segmentsComplete: true };
  }
  function pricing(subscription: boolean) {
    const quote = {
      providerId: subscription ? 'openai' : 'xd',
      modelId: 'test-model',
      currency: 'USD',
      source: subscription ? 'subscription-reference' : 'gateway',
      approximate: subscription,
      inputPerMtok: 1,
      outputPerMtok: 2,
      cacheReadPerMtok: 0.1,
    };
    effects.fn('getSessionProvider').mockReturnValue(subscription ? 'openai' : 'xd');
    effects
      .fn('getCodexProxyAuthInjection')
      .mockReturnValue(subscription ? 'oauth-bearer' : 'env-key');
    effects.fn('getGatewayModelPricingForModel').mockResolvedValue({ xd: { 'test-model': quote } });
    effects.fn('getModelPriceQuote').mockReturnValue(quote);
    const referenceQuote = {
      ...quote,
      providerId: 'openai',
      source: 'subscription-reference',
      approximate: true,
    };
    for (const name of [
      'getSubscriptionDirectValuePrice',
      'getCodexProviderSubscriptionValuePrice',
    ])
      effects.fn(name).mockReturnValue(referenceQuote);
    effects
      .fn('getReferenceModelPricing')
      .mockReturnValue({ openai: { 'test-model': referenceQuote } });
    effects.fn('codexUsageToTokens').mockReturnValue(tokens);
    effects.fn('piUsageToTokens').mockReturnValue(tokens);
    effects.fn('consumeLastAssistantPersistId').mockReturnValue('assistant-row');
  }

  it.each([
    ['codex', false],
    ['codex', true],
    ['pi', false],
    ['pi', true],
  ] as const)(
    '%s attributes %s subscription pricing without changing token facts',
    async (source, subscription) => {
      const h = harness();
      pricing(subscription);
      h.emit(event('done', { usage: usage(source) }, { source }));
      await microtasks();
      expect(effects.fn('recordSessionTurnTokens')).toHaveBeenCalledWith('task', 130);
      expect(effects.fn('recordModelTurnUsage')).toHaveBeenCalledWith(
        expect.objectContaining({
          inputTokensDelta: 100,
          outputTokensDelta: 20,
          cacheReadTokensDelta: 10,
        }),
      );
      expect(effects.fn('recordSchedulerTurnCost')).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: 'assistant-row',
          money: expect.objectContaining({ kind: subscription ? 'value-estimate' : 'actual-cost' }),
        }),
      );
      expect(effects.fn('recordTurnSpend')).toHaveBeenCalledTimes(subscription ? 0 : 1);
      expect(effects.fn('recordSessionTurnSpend')).toHaveBeenCalledTimes(subscription ? 0 : 1);
      ordered('broadcast', 'recordSessionTurnTokens');
      await h.dispose();
    },
  );

  it.each(['codex', 'claude-code'] as const)(
    'keeps remote %s usage out of local gateway charges',
    async (source) => {
      const h = harness();
      pricing(false);
      Object.defineProperty(h.session, 'remoteHostId', { value: 'ssh-host' });
      h.deps.lastReportedCostUsdBySession.set('task', 10);
      h.emit(
        event(
          'done',
          source === 'codex'
            ? { usage: usage('codex') }
            : {
                total_cost_usd: 12,
                duration_ms: 100,
                usage: { input_tokens: 100, output_tokens: 20 },
              },
          { source },
        ),
      );
      await microtasks();
      expect(effects.fn('recordTurnSpend')).not.toHaveBeenCalled();
      expect(effects.fn('recordSessionTurnSpend')).not.toHaveBeenCalled();
      expect(effects.fn('recordSchedulerTurnCost')).not.toHaveBeenCalledWith(
        expect.objectContaining({ money: expect.objectContaining({ kind: 'actual-cost' }) }),
      );
      if (source === 'codex')
        expect(effects.fn('recordModelTurnUsage')).toHaveBeenCalledWith(
          expect.objectContaining({ inputTokensDelta: 100 }),
        );
      else
        expect(effects.fn('recordTurnUsageOnMessage')).toHaveBeenCalledWith(
          expect.objectContaining({
            clientId: 'assistant-row',
            turnUsageDetails: expect.objectContaining({ turnDurationMs: 100 }),
          }),
        );
      await h.dispose();
    },
  );

  it.each(['codex', 'pi'] as const)(
    'retains %s token facts when pricing rejects',
    async (source) => {
      const h = harness();
      pricing(false);
      effects.fn('getGatewayModelPricingForModel').mockRejectedValue(new Error('offline'));
      h.emit(event('done', { usage: usage(source) }, { source }));
      await microtasks();
      expect(effects.fn('recordTurnSpend')).not.toHaveBeenCalled();
      expect(effects.fn('recordTurnUsageOnMessage')).toHaveBeenCalledWith(
        expect.objectContaining({
          clientId: 'assistant-row',
          turnUsageDetails: expect.objectContaining({ inputTokens: 100, outputTokens: 20 }),
        }),
      );
      expect(effects.fn('recordModelTurnUsage')).toHaveBeenCalledWith(
        expect.objectContaining({ inputTokensDelta: 100, outputTokensDelta: 20 }),
      );
      await h.dispose();
    },
  );

  it('keeps accepted old-turn accounting after replacement and does not block delivery on model lookup', async () => {
    const h = harness(),
      replacement = harness(),
      model = deferred<string>();
    pricing(false);
    const lifecycle = createSessionBindingLifecycle<Session, null>({
      log: h.deps.log,
      restoreInteractionListener: vi.fn(),
      beforeReplace: vi.fn(),
      onBind: vi.fn(),
      broadcastStatus: vi.fn(),
      captureCloseContext: () => null,
      cleanupClosedSession: vi.fn(),
      beforeCloseTeardown: vi.fn(),
      finalizeClosedSession: vi.fn(),
    });
    const registration = lifecycle.beginBinding(h.session)!;
    registration.disposers.push(h.session.onEvent(h.emit));
    lifecycle.attachStatusListener(registration);
    h.deps.turnModelPromiseBySession.set('task', model.promise);
    h.emit(event('done', { usage: usage('codex') }));
    expect(effects.fn('broadcast')).toHaveBeenCalledOnce();
    expect(effects.fn('recordSchedulerTurnCost')).not.toHaveBeenCalled();
    lifecycle.beginBinding(replacement.session);
    effects.fn('consumeLastAssistantPersistId').mockReturnValue('new-row');
    model.resolve('test-model');
    await microtasks();
    expect(effects.fn('recordSchedulerTurnCost')).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'assistant-row' }),
    );
    expect(lifecycle.getSession('task')).toBe(replacement.session);
    await h.dispose();
    await replacement.dispose();
  });

  it('uses only the Claude cumulative delta after establishing a baseline', async () => {
    const h = harness();
    effects.fn('getSessionProvider').mockReturnValue('custom-api');
    effects
      .fn('getActiveCatalog')
      .mockReturnValue({ providers: [{ id: 'custom-api', access: { kind: 'api' } }] });
    effects.fn('getGatewayAccountCurrency').mockResolvedValue('USD');
    effects.fn('consumeLastAssistantPersistId').mockReturnValue('assistant-row');
    h.emit(
      event(
        'done',
        { total_cost_usd: 100, usage: { input_tokens: 5000 } },
        { source: 'claude-code' },
      ),
    );
    await microtasks();
    expect(effects.fn('recordTurnSpend')).not.toHaveBeenCalled();
    h.emit(
      event(
        'done',
        { total_cost_usd: 102, usage: { input_tokens: 6000 } },
        { source: 'claude-code' },
      ),
    );
    await microtasks();
    expect(effects.fn('recordTurnSpend')).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2, kind: 'actual-cost' }),
    );
    expect(effects.fn('recordSchedulerTurnCost')).toHaveBeenCalledWith(
      expect.objectContaining({ money: expect.objectContaining({ amount: 2 }) }),
    );
    await h.dispose();
  });
});
