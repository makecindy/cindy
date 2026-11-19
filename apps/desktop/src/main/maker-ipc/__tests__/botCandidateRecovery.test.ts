import { describe, expect, it, vi } from 'vitest';
import { extractNonSecretErrorSignals } from '@cindy/maker-shared/error-redaction';
import { canResumeAfterRuntimeFallback, isBotCandidateUnavailable, isModelGroupConnectionOutOfCredit } from '../botCandidateRecovery';
import { isInterruptedTurnError, isContinuationOnlyAutoResumeReason } from '../interruptedTurnAutoResume';
import { createInterruptedTurnAutoResumeHooks } from '../interruptedTurnAutoResumeHooks';


/** Execute the production auto-resume hooks (interruptedTurnAutoResumeHooks.ts) without starting Electron or touching accounts. */
function harness(bot = true, settlePausedResumeIntoHistory?: true) {
  const item = { clientId: 'input', createOpts: {} };
  let current = true;
  let scheduled: (() => Promise<void>) | undefined;
  const resume = vi.fn(async () => 'resumed');
  const fallback = vi.fn(async () => ({ session: null, outcome: 'switched' }));
  const finalize = vi.fn();
  const guard = vi.fn(() => ({ action: 'resume', attempt: 1, maxAttempts: 5,
    episodeAttempt: 1, maxEpisodeAttempts: 10, sessionTotal: 1, attemptToken: 1, delayMs: 1000 }));
  const groupMayHandle = vi.fn((_sessionId: string, _signals: unknown) => false);
  const liveSession = {};
  const rebuildLeases = new WeakMap<object, number>();
  const deps = {
    isInterruptedTurnError, isBotCandidateUnavailable, canResumeAfterRuntimeFallback,
    isContinuationOnlyAutoResumeReason,
    providerGroupService: { mayHandleTurnError: groupMayHandle },
    inputCoordinator: { isExecutionPaused: vi.fn(() => false), isAutoResumeAttemptCurrent: vi.fn(() => true), autoRetryLastError: resume },
    interruptedTurnAutoResumeGuard: { onInterruptedTurn: guard, noteResumeSendFailed: vi.fn() },
    maybeApplySessionRuntimeFallback: fallback,
    autoResumeBookkeeping: {
      beginAttempt: vi.fn(), finalizeSuppressedError: finalize,
      schedule: (_id: string, _token: number, _delay: number, run: (attempt: { isCurrent(): boolean }) => Promise<void>) => {
        scheduled = () => run({ isCurrent: () => current });
      },
    },
    saveTurnStartedAtForDeferred: vi.fn(), beginSchedulerAutoResume: vi.fn(),
    pendingSessionRuntimeFallbackRebuilds: new WeakMap(),
    getStableSessionForTurnBoundary: () => liveSession,
    pendingContinuationOnlyAutoResumeRebuilds: rebuildLeases,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  };
  const botFallbackInputs = new WeakSet<object>();
  const hooks = createInterruptedTurnAutoResumeHooks({
    ...deps, botFallbackInputs,
    ...(settlePausedResumeIntoHistory && { settlePausedResumeIntoHistory }),
    providerGroupHeldErrors: { stash: vi.fn() }, providerGroupHeldTerminals: { stash: vi.fn() },
    pendingSchedulerAutoResumeRunBySession: new Map(), notifySchedulerAutoResumeFailed: vi.fn(),
    autoResumeAttemptToken: () => null,
  } as never);
  // The harness feeds minimal inputs; the hooks are typed for the coordinator's full queue items.
  const callbacks = {
    isResumableTurnErrorCandidate: hooks.canRecoverTurn as (...args: unknown[]) => boolean,
    onResumableTurnError: hooks.onResumableTurnError as (...args: unknown[]) => unknown,
  };
  const runtime = { callbacks };
  if (bot) botFallbackInputs.add(item.createOpts);
  return { item, ...runtime.callbacks, resume, fallback, finalize, guard, groupMayHandle, liveSession, rebuildLeases,
    paused: deps.inputCoordinator.isExecutionPaused, startupCurrent: deps.inputCoordinator.isAutoResumeAttemptCurrent,
    releaseGuard: deps.interruptedTurnAutoResumeGuard.noteResumeSendFailed,
    beginSchedulerAutoResume: deps.beginSchedulerAutoResume,
    run: () => scheduled!(), cancel: () => { current = false; } };
}

describe('Bot candidate recovery', () => {
  // Unit regression for 8bcdaae10b: the existing recovery cases never paused execution
  // between scheduling and dispatch. Exercise both sides of asynchronous route selection.
  it('runs an unpaused retry after route selection without surfacing the held error', async () => {
    const h = harness();
    h.onResumableTurnError('s', { errorStatus: 503 }, h.item);
    await h.run();
    expect(h.fallback).toHaveBeenCalledOnce();
    expect(h.resume).toHaveBeenCalledWith('s', 1);
    expect(h.releaseGuard).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
  });

  it.each(['before', 'during'])('finalizes once without a banner when paused %s route selection', async when => {
    const h = harness(true, true);
    h.onResumableTurnError('s', { errorStatus: 503 }, h.item);
    if (when === 'before') h.paused.mockReturnValue(true);
    else h.fallback.mockImplementationOnce(async () => {
      h.paused.mockReturnValue(true);
      return { session: null, outcome: 'switched' };
    });
    await h.run();
    expect(h.fallback).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
    expect(h.releaseGuard.mock.calls).toEqual([['s', 1]]);
    expect(h.finalize.mock.calls).toEqual([['s', 1, { surfaceBanner: false }]]);
    expect(h.resume).not.toHaveBeenCalled();
  });

  it.each(['attempt', 'startup'])('leaves an expired %s alone even when execution is paused', async kind => {
    const h = harness(true, true);
    h.onResumableTurnError('s', { reason: 'bot-subscription-startup-admission', errorStatus: 429 }, h.item);
    if (kind === 'attempt') h.cancel();
    else h.startupCurrent.mockReturnValue(false);
    h.paused.mockReturnValue(true);
    await h.run();
    expect(h.fallback).not.toHaveBeenCalled();
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.releaseGuard).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
  });

  // Production entry/result: createInterruptedTurnAutoResumeHooks runs the scheduled callback;
  // Desktop leaves the held error alone and neither switches routes nor sends a retry.
  // Basis: af8bd193a3 short-circuits on pause; 7f168d0212 applied Host settlement to Desktop too.
  // Coverage gap: the paused-at-dispatch tests above exercise the Host opt-in only.
  // Minimal input/tier: one current startup admission retry, paused after scheduling;
  // unit tier with an in-memory scheduler and no database or running app.
  // Standalone file wall clock: 3.65 s on Node 22.22.3.
  it('leaves a current paused desktop retry and its held error alone', async () => {
    const h = harness();
    expect(h.onResumableTurnError('s', { reason: 'bot-subscription-startup-admission', errorStatus: 429 }, h.item))
      .not.toBeNull();
    h.paused.mockReturnValue(true);
    await h.run();
    expect(h.releaseGuard).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.startupCurrent).not.toHaveBeenCalled();
  });

  // #10802 / unit: the real recovery hook must carry its original cause with
  // the scheduler lease, even if the retry later fails before a vendor event.
  it('retains the original cause when claiming recovery for a scheduled run', () => {
    const h = harness();
    const message = "You've hit your session limit";
    const item = { ...h.item, origin: { kind: 'scheduler', scheduleId: 'schedule', runId: 'run' } };
    expect(h.onResumableTurnError('s', { message }, item)).not.toBeNull();
    expect(h.beginSchedulerAutoResume).toHaveBeenCalledExactlyOnceWith('s', 'run', 1, message);
  });

  // #10119 review: use the production enrichment before the production recovery callbacks.
  it('does not turn a text-only permission denial into a provider failure after enrichment', () => {
    const message = 'Permission denied: HTTP 403';
    const signals = { message, ...extractNonSecretErrorSignals(message) };
    const h = harness();
    expect(h.isResumableTurnErrorCandidate(signals, h.item)).toBe(false);
    expect(h.onResumableTurnError('s', signals, h.item)).toBeNull();
    expect(h.fallback).not.toHaveBeenCalled();
    expect(h.guard).not.toHaveBeenCalled();
    expect(h.resume).not.toHaveBeenCalled();
  });

  // #9836: legacy/statusless provider envelopes must reach the real recovery callbacks.
  it.each(['switched', 'exhausted', 'failed'] as const)('handles the reported provider 403 after fallback %s', async (outcome) => {
    const signals = { message: 'HTTP 403: The caller does not have permission' };
    const ordinary = harness(false);
    expect(ordinary.isResumableTurnErrorCandidate(signals, ordinary.item)).toBe(false);
    const h = harness();
    h.fallback.mockResolvedValue({ session: null, outcome });
    expect(h.isResumableTurnErrorCandidate(signals, h.item)).toBe(true);
    expect(h.onResumableTurnError('s', signals, h.item)).not.toBeNull();
    await h.run();
    expect(h.fallback).toHaveBeenCalledWith('s', 1, 1, true, expect.any(Function));
    expect(h.resume).toHaveBeenCalledTimes(outcome === 'switched' ? 1 : 0);
    if (outcome !== 'switched') expect(h.finalize).toHaveBeenCalledWith('s', 1, { surfaceBanner: true });
  });

  it.each([
    { message: 'The caller does not have permission' },
    { message: 'HTTP 403: Forbidden' },
  ])('recognizes statusless provider access failure %j', signals => {
    expect(isBotCandidateUnavailable(signals)).toBe(true);
  });

  it.each([
    { reason: 'user_denied', message: 'HTTP 403: The caller does not have permission' },
    { message: 'User denied approval: HTTP 403' },
    { message: 'Permission denied: HTTP 403' },
    { message: 'HTTP 4030' },
    { message: 'tok-403-x' },
  ])('keeps control failures and opaque numbers out of recovery %j', signals => {
    expect(isBotCandidateUnavailable(signals)).toBe(false);
  });

  // Claude assistant envelopes may carry only a stable SDK tag, without an HTTP status.
  it.each([
    ['authentication_failed', true], ['rate_limit', true], ['server_error', true],
    ['billing_error', true], ['invalid_request', false], ['max_output_tokens', false],
    ['unknown', false],
  ] as const)('classifies statusless Claude %s envelopes and preserves control reasons', (sdkError, unavailable) => {
    for (const reason of [undefined, 'turn-failed']) {
      expect(isBotCandidateUnavailable({ sdkError, reason, message: `SDK error: ${sdkError}` })).toBe(unavailable);
    }
    for (const reason of ['context_overflow', 'user_denied', 'tool_use_loop_detected']) {
      expect(isBotCandidateUnavailable({ sdkError, reason, errorStatus: 503 })).toBe(false);
    }
  });

  it.each([undefined, 'unknown'])('recovers a text-only session limit with SDK tag %s', async (sdkError) => {
    const signals = { sdkError, message: "You've hit your session limit · resets 9:30pm (Asia/Shanghai)" };
    const ordinary = harness(false);
    expect(ordinary.isResumableTurnErrorCandidate(signals, ordinary.item)).toBe(false);
    const h = harness();
    expect(h.isResumableTurnErrorCandidate(signals, h.item)).toBe(true);
    expect(h.onResumableTurnError('s', signals, h.item)).not.toBeNull();
    await h.run();
    expect(h.fallback).toHaveBeenCalledWith('s', 1, 1, true, expect.any(Function));
    expect(h.resume).toHaveBeenCalledOnce();
  });

  it.each([
    { reason: 'user_denied' }, { reason: 'context_overflow' },
    { sdkError: 'invalid_request' },
  ])('preserves explicit failures despite session-limit text %j', (override) => {
    expect(isBotCandidateUnavailable({ message: "You've hit your session limit", ...override })).toBe(false);
  });

  it.each(['switched', 'exhausted'])('routes a statusless server error through Bot fallback (%s)', async (outcome) => {
    const h = harness();
    const signals = { sdkError: 'server_error', message: 'Internal server error' };
    h.fallback.mockResolvedValue({ session: null, outcome });
    expect(h.isResumableTurnErrorCandidate(signals, h.item)).toBe(true);
    expect(h.onResumableTurnError('s', signals, h.item)).not.toBeNull();
    await h.run();
    expect(h.fallback).toHaveBeenCalledWith('s', 1, 1, true, expect.any(Function));
    expect(h.resume).toHaveBeenCalledTimes(outcome === 'switched' ? 1 : 0);
    if (outcome === 'exhausted') expect(h.finalize).toHaveBeenCalledWith('s', 1, { surfaceBanner: true });
  });

  it.each([
    { reason: 'pi-gateway-drop', message: 'Connection error.' },
    { reason: 'user_model_access_denied', sdkError: 'user_model_access_denied', errorStatus: 403 },
    { sdkError: 'user_model_access_denied' },
    { errorStatus: 403, message: 'Permission denied' },
    { reason: 'turn-failed', errorStatus: 403, message: 'Permission denied' },
    { errorStatus: 401 }, { errorStatus: 402 }, { errorStatus: 429 }, { errorStatus: 503 },
    { sdkError: 'authentication_failed' }, { sdkError: 'billing_error' },
    { message: 'model deepseek does not exist' }, { message: 'Failed to start agent' },
    { message: 'Selected model is at capacity. Please try a different model.' },
  ])('allows a different candidate for %j', (signals) => {
    expect(isBotCandidateUnavailable(signals)).toBe(true);
  });

  it.each([
    { reason: 'tool_use_loop_detected', message: 'Connection error.' },
    { reason: 'context_overflow', errorStatus: 503 },
    { reason: 'user_denied', errorStatus: 403, message: 'Permission denied' },
    { message: 'Permission denied' },
    { message: 'User rejected permission', errorStatus: 403 },
    { message: 'Approval required', errorStatus: 403 },
    { message: 'User rejected permission' }, { message: 'Tool business failure' },
    { sdkError: 'invalid_request', message: 'prompt too long' },
    { reason: 'user_denied', usageLimit: true },
    { codexErrorInfo: 'sessionBudgetExceeded', usageLimit: true, message: 'budget_exceeded' },
    { message: 'invalid encrypted content' }, { message: 'thread not found' },
  ])('does not reinterpret control or input failures %j', (signals) => {
    expect(isBotCandidateUnavailable(signals)).toBe(false);
  });

  // Regression: a primary account can be exhausted while a configured backup has quota.
  // Unit tier: exercise production recovery callbacks; the old test prohibited any switch.
  const budgetExceeded = '429: {"message":"ExceededBudget: User=[REDACTED] over budget. Spend=0.0, Budget=0.0","type":"budget_exceeded","code":"429"}';
  it.each([
    { errorStatus: 429, message: budgetExceeded },
    { reason: 'turn-failed', errorStatus: 429, message: budgetExceeded },
    { sdkError: 'rate_limit', message: 'Request failed: budget_exceeded' },
    { errorStatus: 429, message: 'You exceeded your current quota, please check your plan and billing details.' },
    { message: 'insufficient_quota' },
    { usageLimit: true, message: 'Usage limit reached' },
    { codexErrorInfo: 'usageLimitExceeded', message: 'Limit reached' },
  ])('allows configured backups after primary account exhaustion %j', (signals) => {
    expect(isBotCandidateUnavailable(signals)).toBe(true);
  });

  it.each([
    { errorStatus: 429, message: 'Too Many Requests' },
    { errorStatus: 429, message: 'rate limit exceeded, retry after 3s' },
    { sdkError: 'rate_limit', message: 'SDK error: rate_limit' },
  ])('still switches candidates for transient rate limiting %j', (signals) => {
    expect(isBotCandidateUnavailable(signals)).toBe(true);
  });

  it.each(['switched', 'exhausted', 'unchanged', 'failed'])('requires a different route after quota exhaustion: %s', async (outcome) => {
    const signals = { errorStatus: 429, message: budgetExceeded };
    const ordinary = harness(false);
    expect(ordinary.isResumableTurnErrorCandidate(signals, ordinary.item)).toBe(false);
    const h = harness();
    h.fallback.mockResolvedValue({ session: null, outcome });
    expect(h.isResumableTurnErrorCandidate(signals, h.item)).toBe(true);
    expect(h.onResumableTurnError('s', signals, h.item)).not.toBeNull();
    await h.run();
    expect(h.fallback).toHaveBeenCalledWith('s', 1, 1, true, expect.any(Function));
    expect(h.resume).toHaveBeenCalledTimes(outcome === 'switched' ? 1 : 0);
    if (outcome !== 'switched') expect(h.finalize).toHaveBeenCalledWith('s', 1, { surfaceBanner: true });
  });

  const drop = { reason: 'pi-gateway-drop', message: 'Connection error.' };
  it('takes over an exhausted Pi route only for a host-identified Bot input', async () => {
    const ordinary = harness(false);
    expect(ordinary.isResumableTurnErrorCandidate(drop, ordinary.item)).toBe(false);
    expect(ordinary.onResumableTurnError('s', drop, ordinary.item)).toBeNull();
    expect(ordinary.guard).not.toHaveBeenCalled();
    const bot = harness();
    expect(bot.isResumableTurnErrorCandidate(drop, bot.item)).toBe(true);
    expect(bot.onResumableTurnError('s', drop, bot.item)).not.toBeNull();
    expect(bot.resume).not.toHaveBeenCalled();
    await bot.run();
    expect(bot.fallback).toHaveBeenCalledWith('s', 1, 1, true, expect.any(Function));
    expect(bot.resume).toHaveBeenCalledWith('s', 1);
  });

  it.each(['exhausted', 'failed', 'unchanged', 'superseded'])('returns the error without resending when fallback is %s', async (outcome) => {
    const h = harness();
    h.fallback.mockResolvedValue({ session: null, outcome });
    h.onResumableTurnError('s', drop, h.item);
    await h.run();
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.finalize).toHaveBeenCalledWith('s', 1, { surfaceBanner: true });
  });

  it('retains ordinary network auto-resume without requiring a route change', async () => {
    const h = harness(false);
    h.fallback.mockResolvedValue({ session: null, outcome: 'unchanged' });
    h.onResumableTurnError('s', { message: 'Connection error.' }, h.item);
    await h.run();
    expect(h.fallback).toHaveBeenCalledWith('s', 1, 1, false, expect.any(Function));
    expect(h.resume).toHaveBeenCalledOnce();
  });

  it('does not revive recovery after Stop or a newer user turn', async () => {
    const h = harness();
    h.fallback.mockImplementation(async () => { h.cancel(); return { session: null, outcome: 'switched' }; });
    h.onResumableTurnError('s', drop, h.item);
    await h.run();
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
  });

  it('does not bypass the existing episode budget', () => {
    const h = harness();
    h.guard.mockReturnValue({ action: 'stop' } as ReturnType<typeof h.guard>);
    expect(h.onResumableTurnError('s', drop, h.item)).toBeNull();
    expect(h.fallback).not.toHaveBeenCalled();
  });

  // A shared route's computer going away is the most common primary failure; it is
  // a property of that route, so another candidate can take over.
  const remoteClosed = { reason: 'remote_agent_closed', message: '[REMOTE_AGENT_EXPIRED] The task is no longer running on the other computer.' };
  it.each([
    remoteClosed,
    { reason: 'remote_agent_closed', message: '[REMOTE_AGENT_UNAVAILABLE] The agent on the other computer stopped (controller-gone).' },
    { reason: 'remote_agent_lost', message: '[REMOTE_AGENT_UNAVAILABLE] The agent on the other computer stopped (unreachable).' },
  ])('allows a different candidate when the remote agent of the route is gone %j', (signals) => {
    expect(isBotCandidateUnavailable(signals)).toBe(true);
  });

  it.each([
    { reason: 'user-revoked', message: '[REMOTE_AGENT_UNAVAILABLE] The agent on the other computer stopped (controller-disconnected).' },
    { reason: 'remote_agent_restarted', message: '[REMOTE_AGENT_UNAVAILABLE] The provider process stopped; reconnecting to the original conversation.' },
  ])('keeps an owner disconnect or same-computer reconnect out of the model chain %j', (signals) => {
    expect(isBotCandidateUnavailable(signals)).toBe(false);
  });

  it('moves a Bot to its next route after the remote agent closed', async () => {
    const ordinary = harness(false);
    expect(ordinary.isResumableTurnErrorCandidate(remoteClosed, ordinary.item)).toBe(false);
    expect(ordinary.onResumableTurnError('s', remoteClosed, ordinary.item)).toBeNull();
    const h = harness();
    expect(h.isResumableTurnErrorCandidate(remoteClosed, h.item)).toBe(true);
    expect(h.onResumableTurnError('s', remoteClosed, h.item)).not.toBeNull();
    // The dead remote Session closes right after this error; its scheduled resume must outlive that close.
    expect(h.rebuildLeases.get(h.liveSession)).toBe(1);
    await h.run();
    expect(h.fallback).toHaveBeenCalledWith('s', 1, 1, true, expect.any(Function));
    expect(h.resume).toHaveBeenCalledOnce();
  });

  it('never retries the closed remote route itself when no other route exists', async () => {
    const h = harness();
    h.fallback.mockResolvedValue({ session: null, outcome: 'unchanged' });
    h.onResumableTurnError('s', remoteClosed, h.item);
    await h.run();
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.finalize).toHaveBeenCalledWith('s', 1, { surfaceBanner: true });
  });

  // A synchronous group candidate is not proof of ownership. This candidate-recovery
  // callback must also work after async group eligibility declined the same failure.
  it('moves a Bot on even when its route belongs to a provider group', async () => {
    const h = harness();
    h.groupMayHandle.mockReturnValue(true);
    expect(h.onResumableTurnError('s', remoteClosed, h.item)).not.toBeNull();
    await h.run();
    expect(h.fallback).toHaveBeenCalledWith('s', 1, 1, true, expect.any(Function));
    expect(h.resume).toHaveBeenCalledOnce();
  });

  const overload = { reason: 'upstream-overload', message: 'Selected model is at capacity. Please try a different model.' };
  it('keeps the ordinary same-route retry for a Bot that has no other route', async () => {
    const h = harness();
    h.fallback.mockResolvedValue({ session: null, outcome: 'unchanged' });
    expect(h.onResumableTurnError('s', overload, h.item)).not.toBeNull();
    await h.run();
    expect(h.fallback).toHaveBeenCalledWith('s', 1, 1, true, expect.any(Function));
    expect(h.resume).toHaveBeenCalledOnce();
  });

  it('does not retry the failed route after other configured routes were exhausted', async () => {
    const h = harness();
    h.fallback.mockResolvedValue({ session: null, outcome: 'exhausted' });
    h.onResumableTurnError('s', overload, h.item);
    await h.run();
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.finalize).toHaveBeenCalledWith('s', 1, { surfaceBanner: true });
  });

  it.each([
    ['switched', false, true], ['unchanged', false, false], ['exhausted', false, false],
    ['unchanged', true, true], ['exhausted', true, false], ['failed', true, false], ['superseded', true, false],
  ] as const)('resumes a required route change after %s (same route retryable: %s) = %s', (outcome, retryable, expected) => {
    expect(canResumeAfterRuntimeFallback(true, { session: null, outcome }, retryable)).toBe(expected);
  });
});

// Unit: both providers use HTTP 429, but only an explicit quota code rules out the whole connection.
it.each([
  ['{"error":{"code":"insufficient_quota"}}', true],
  ['{"error":{"code":"rate_limit_exceeded"}}', false],
])('classifies the connection scope of 429 %s', (message, expected) => {
  expect(isModelGroupConnectionOutOfCredit({ errorStatus: 429, message })).toBe(expected);
});
