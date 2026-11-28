import { describe, expect, it, vi } from 'vitest';
import { extractNonSecretErrorSignals } from '@cindy/maker-shared/error-redaction';
import {
  canResumeAfterRuntimeFallback, isBotCandidateUnavailable, isModelGroupConnectionOutOfCredit,
  modelGroupFailureScope,
} from '../botCandidateRecovery';
import { InterruptedTurnAutoResumeGuard, isInterruptedTurnError, isContinuationOnlyAutoResumeReason } from '../interruptedTurnAutoResume';
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
    expect(h.fallback).toHaveBeenCalledWith('s', 1, 1, true, expect.any(Function), undefined, undefined);
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
    expect(h.fallback).toHaveBeenCalledWith('s', 1, 1, true, expect.any(Function), undefined, undefined);
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
    expect(h.fallback).toHaveBeenCalledWith('s', 1, 1, true, expect.any(Function), undefined, undefined);
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
    expect(h.fallback).toHaveBeenCalledWith('s', 1, 1, true, expect.any(Function), undefined, undefined);
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
    expect(bot.fallback).toHaveBeenCalledWith('s', 1, 1, true, expect.any(Function), undefined, 'pi-gateway-drop');
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
    expect(h.fallback).toHaveBeenCalledWith('s', 1, 1, false, expect.any(Function), undefined, undefined);
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
    expect(h.fallback).toHaveBeenCalledWith('s', 1, 1, true, expect.any(Function), undefined, 'remote_agent_closed');
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
    expect(h.fallback).toHaveBeenCalledWith('s', 1, 1, true, expect.any(Function), undefined, 'remote_agent_closed');
    expect(h.resume).toHaveBeenCalledOnce();
  });

  const overload = { reason: 'upstream-overload', message: 'Selected model is at capacity. Please try a different model.' };
  it('keeps the ordinary same-route retry for a Bot that has no other route', async () => {
    const h = harness();
    h.fallback.mockResolvedValue({ session: null, outcome: 'unchanged' });
    expect(h.onResumableTurnError('s', overload, h.item)).not.toBeNull();
    await h.run();
    expect(h.fallback).toHaveBeenCalledWith('s', 1, 1, true, expect.any(Function), undefined, 'upstream-overload');
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

// 生产入口与可观察结果：isBotCandidateUnavailable 与 createInterruptedTurnAutoResumeHooks 判定插件引擎终态是否切备用路由。
// 依据：docs/product-rules/cindy-bots-runtime.md §5，插件进程退出/缺登录/上游限流切备用模型，用户拒绝/超窗不切。
// 覆盖缺口：既有测试只覆盖内置引擎的 turn-failed 与 provider_* 原因，未覆盖 ACP 的三种终态 reason。
// 最小失败输入与 tier：unit，纯内存信号表驱动。
it.each([
  [{ reason: 'acp-agent-exited', message: 'The agent process ended unexpectedly.' }, true],
  [{ reason: 'acp-auth-required', message: 'The agent needs you to sign in again.' }, true],
  [{ reason: 'acp-request-failed', errorStatus: 429, message: 'Rate limit exceeded' }, true],
  [{ reason: 'acp-request-failed', message: 'User denied permission' }, false],
  [{ reason: 'acp-request-failed', message: 'Prompt too long for context window' }, false],
] as const)('classifies plugin engine failure %j for companion candidate fallback = %s', async (signals, expected) => {
  expect(isBotCandidateUnavailable(signals)).toBe(expected);
  const h = harness();
  expect(h.isResumableTurnErrorCandidate(signals, h.item)).toBe(expected);
});

// model-groups.md §4.1 (2026-11-24): a model-group task retries a transient failure on the same source twice, then
// switches; a source or connection failure switches at once, without the auto-resume backoff.
// Production entry: createInterruptedTurnAutoResumeHooks → maybeApplySessionRuntimeFallback(groupRecovery).
// Minimal failing input: a 503 on a model-group task switching source on its first retry. tier: unit.
describe('model group failure handling', () => {
  it.each([
    ['a gateway 503', { errorStatus: 503 }, 'transient'],
    ['an overload', { reason: 'upstream-overload' }, 'transient'],
    ['a provider 5xx', { reason: 'provider_server_error' }, 'transient'],
    ['an idle upstream', { reason: 'upstream_response_idle_timeout' }, 'transient'],
    ['a turn without events', { reason: 'turn_no_event_timeout' }, 'transient'],
    ['a stalled Codex reconnect', { reason: 'codex_reconnect_stalled' }, 'transient'],
    ['a short rate limit', { errorStatus: 429, sdkError: 'rate_limit' }, 'transient'],
    ['a short rate limit enriched with usageLimit by translator', { errorStatus: 429, sdkError: 'rate_limit', usageLimit: true, message: '429 Too Many Requests: rate_limit_exceeded' }, 'transient'],
    ['a Codex rateLimitExceeded tag', { codexErrorInfo: 'rateLimitExceeded', errorStatus: 429, usageLimit: true, message: 'Too Many Requests' }, 'transient'],
    ['a rate limit reported only as text', { message: 'rate limit exceeded' }, 'transient'],
    ['an unclassified upstream error', { message: 'weird upstream boom' }, 'transient'],
    ['an unclassified failed turn', { reason: 'turn-failed', message: 'weird upstream boom' }, 'transient'],
    ['out of credit', { errorStatus: 402 }, 'connection'],
    ['an account quota', { usageLimit: true }, 'connection'],
    ['a Claude subscription window limit with usageResetAt', { sdkError: 'rate_limit', usageLimit: true, usageResetAt: 1_900_000_000_000, message: "You've hit your session limit" }, 'connection'],
    ['a Codex usageLimitExceeded tag', { codexErrorInfo: 'usageLimitExceeded', errorStatus: 429, usageLimit: true, message: 'usage_limit_reached' }, 'connection'],
    ['a dead login', { reason: 'provider_auth_or_access' }, 'connection'],
    // 2026-11-27: a Claude account on hold was sorted transient, so the task retried the held account twice.
    ['a Claude account on hold', { sdkError: 'account_on_hold',
      message: "Your account is on hold and can't use Claude Code. View details or appeal: https://claude.ai/restricted" }, 'connection'],
    ['an unauthorized key', { errorStatus: 401 }, 'connection'],
    ['an ACP agent quota', { reason: 'acp-usage-limit' }, 'connection'],
    // Seen on a Pi task with a dead Agnes AI key: the status only exists as the text's prefix.
    ['a dead key reported only as text', { sdkError: '401: {"code":"","message":"Invalid token (request id: x)","type":"AgnesAI_error"}',
      message: '401: {"code":"","message":"Invalid token (request id: x)","type":"AgnesAI_error"}' }, 'connection'],
    // 2026-11-26 audit: a provider's account pool with no account left used to retry the same source twice first.
    ['an OpenAI account pool with no account left', { message: 'No subscription account is available' }, 'connection'],
    ['every pooled account limited for this model', { message: '[SUBSCRIPTION_POOL_MODEL_LIMITED] Subscription usage limit for this model' }, 'connection'],
    ['every pooled account busy', { message: '[SUBSCRIPTION_ACCOUNTS_FULL] every available subscription account has reached its concurrency limit' }, 'connection'],
    // 2026-11-29: a shared Antigravity whose account had to sign in again kept a routed task on the error.
    ['a task account that must sign in again', { message: '[SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED] The plugin engine account requires login' }, 'connection'],
    ['a task account still signing in', { message: '[SUBSCRIPTION_ACCOUNT_SIGNING_IN] The task subscription account is signing in' }, 'connection'],
    ['a startup refused for a login', { reason: 'LAZY_CREATE_FAILED', message: '[SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED] The task subscription account requires login' }, 'connection'],
    ['a startup refused for quota', { reason: 'REHYDRATE_FAILED', message: '[SUBSCRIPTION_ACCOUNT_LIMITED] The plugin engine account has reached its usage limit' }, 'connection'],
    ['a source that would not start for another reason', { reason: 'LAZY_CREATE_FAILED', message: 'spawn antigravity ENOENT' }, 'model'],
    // The coordinator hands a startup failure on as `<host code>: <message>` (sendFailureMessage).
    ['a resume the host asks to retry shortly', { reason: 'REHYDRATE_FAILED', message: "REHYDRATE_FAILED: [CODEX_RESUME_NOT_READY] Codex can't resume this task right now. Try again shortly." }, 'transient'],
    ['a prefixed startup refused for a login', { reason: 'LAZY_CREATE_FAILED', message: 'LAZY_CREATE_FAILED: [SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED] The task subscription account requires login' }, 'connection'],
    ['a startup with a prompt too long for any source', { reason: 'LAZY_CREATE_FAILED', message: 'prompt too long' }, null],
    ['a missing working directory', { reason: 'WORKDIR_MISSING', message: 'working directory is missing' }, null],
    ['a busy credential switch', { reason: 'CREDENTIAL_SWITCH_BUSY', message: 'another Codex task is running' }, null],
    ['a removed model', { reason: 'model_unavailable' }, 'model'],
    ['Pi giving up after its own retries', { reason: 'pi-gateway-drop' }, 'model'],
    ['an engine that would not start', { reason: 'agent-start-failed' }, 'model'],
    ['a prompt too long for any source', { errorStatus: 400, message: 'prompt too long' }, null],
    ['a structured context error', { reason: 'turn-failed', codexErrorInfo: 'contextWindowExceeded' }, null],
    ['a statusless content block', { reason: 'turn-failed', message: 'content_policy_violation' }, null],
    ['a misalignment policy block', { codexErrorInfo: 'misalignmentPolicyViolation', errorStatus: 403 }, null],
    ['a provider safety refusal reason', { reason: 'provider-safety-refusal', errorStatus: 403, message: 'Output blocked by content filtering policy' }, null],
    ['a rejected approval', { reason: 'acp-request-failed', message: 'User denied permission' }, null],
    ['a local permission denial', { sdkError: 'permission_error' }, null],
    ['a provider permission denial', { sdkError: 'permission_error', errorStatus: 403 }, 'model'],
    ['a malformed request', { reason: 'turn-failed', errorStatus: 422 }, null],
    ['an unknown control failure', { reason: 'user-cancelled' }, null],
  ] as const)('sorts %s', (_name, signals, scope) => {
    expect(modelGroupFailureScope(signals as never)).toBe(scope);
  });

  function groupHarness(policy: 'enabled' | 'disabled' = 'enabled', interruptedResumeEnabled = true) {
    const item = { clientId: 'input', createOpts: {} };
    const scheduled: Array<() => Promise<void>> = [];
    const delays: number[] = [];
    const fallback = vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({ session: null, outcome: 'unchanged' }));
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const guard = new InterruptedTurnAutoResumeGuard({
      isEnabled: () => policy === 'disabled' || interruptedResumeEnabled,
      log,
      random: () => 0.5,
    });
    let lastDispatchedToken: number | undefined;
    const resume = vi.fn(async (sessionId: string, token: number, ..._extra: unknown[]) => {
      guard.noteAttemptEvent(sessionId, token);
      lastDispatchedToken = token;
      return 'resumed';
    });
    const finalize = vi.fn();
    const hooks = createInterruptedTurnAutoResumeHooks({
      inputCoordinator: { isExecutionPaused: vi.fn(() => false), isAutoResumeAttemptCurrent: vi.fn(() => true),
        autoRetryLastError: resume },
      interruptedTurnAutoResumeGuard: guard,
      maybeApplySessionRuntimeFallback: fallback,
      autoResumeBookkeeping: {
        beginAttempt: vi.fn(), finalizeSuppressedError: finalize,
        schedule: (_id: string, _token: number, delay: number, run: (attempt: { isCurrent(): boolean }) => Promise<void>) => {
          delays.push(delay);
          scheduled.push(() => run({ isCurrent: () => true }));
        },
      },
      saveTurnStartedAtForDeferred: vi.fn(), beginSchedulerAutoResume: vi.fn(),
      pendingSessionRuntimeFallbackRebuilds: new WeakMap(),
      getStableSessionForTurnBoundary: () => ({}),
      pendingContinuationOnlyAutoResumeRebuilds: new WeakMap(),
      log,
      botFallbackInputs: new WeakSet(),
      modelGroupInputs: {
        get: (opts: object) => opts === item.createOpts ? policy : undefined,
        isInterruptedTurnAutoResumeEnabled: () => interruptedResumeEnabled,
      },
      providerGroupHeldErrors: { stash: vi.fn() }, providerGroupHeldTerminals: { stash: vi.fn() },
      pendingSchedulerAutoResumeRunBySession: new Map(), notifySchedulerAutoResumeFailed: vi.fn(),
      autoResumeAttemptToken: () => null,
    } as never);
    let lastResume: unknown;
    const fail = async (signals: Record<string, unknown>, onContinuedInput = false) => {
      const failedItem = onContinuedInput ? { ...item, autoResume: true, autoResumeInfo: lastResume } : item;
      const progress = (hooks.onResumableTurnError as (...args: unknown[]) => unknown)('s', signals, failedItem);
      lastResume = progress;
      if (!progress) return null;
      await scheduled.shift()!();
      const call = fallback.mock.calls.at(-1)!;
      return { requireRouteChange: call[3], recovery: call[5] as { retrySameSource?: boolean; accountUnavailable: boolean } };
    };
    return { fail, fallback, delays, resume, finalize, noteProgress: () => guard.noteProgress('s', lastDispatchedToken) };
  }

  // Unit: an accepted CONTINUE that stalls again gets another chance only after
  // real output. Enabled model groups keep their own source-switch retry budget.
  it.each([
    ['disabled', false, 1], ['disabled', true, 2], ['enabled', false, 2],
  ] as const)('recovers repeated reconnect with group=%s progress=%s', async (policy, progress, expectedSends) => {
    const h = groupHarness(policy);
    const signals = { reason: 'codex_reconnect_stalled' };
    await h.fail(signals);
    if (progress) expect(h.noteProgress()).toBe(true);
    await h.fail(signals, true);
    expect(h.resume).toHaveBeenCalledTimes(expectedSends);
  });

  // Product §4.1–4.5 / #12440: the hooks now run with the production guard instead of an
  // always-allow fake. Two transient failures on each of A and B must still let C receive the retry.
  it('retries a transient failure on the same source twice before switching, and gives the new source its own retries', async () => {
    const h = groupHarness();
    const sameSource: boolean[] = [];
    for (let i = 0; i < 6; i += 1) {
      // The third failure switches source; the group then fails transiently on the new one too.
      h.fallback.mockResolvedValueOnce({ session: null, outcome: i % 3 === 2 ? 'switched' : 'unchanged' });
      sameSource.push((await h.fail({ errorStatus: 503 }))!.recovery.retrySameSource === true);
    }
    expect(sameSource).toEqual([true, true, false, true, true, false]);
    expect(h.resume).toHaveBeenCalledTimes(6);
    expect(h.delays).toEqual([3000, 6000, 0, 3000, 6000, 0]);
  });

  it('gives the same source a fresh retry after substantive output', async () => {
    const h = groupHarness();
    const signals = { errorStatus: 503 };
    await h.fail(signals);
    await h.fail(signals);
    expect(h.noteProgress()).toBe(true);
    expect(await h.fail(signals)).toMatchObject({ requireRouteChange: false, recovery: { retrySameSource: true } });
    expect(h.delays.at(-1)).toBe(3000);
  });

  // §4.1 / #12440, unit: the real guard and hooks used on a terminal provider
  // error must retry twice in place before switching, even with ordinary auto-resume off.
  // Previously an unclassified error stopped and a typed stream interruption switched at once.
  it.each([
    ['an unclassified provider error', { message: 'weird upstream boom' }],
    ['an interrupted stream', { reason: 'upstream-stream-interrupted', message: 'Response API in-stream error' }],
  ] as const)('retries twice and then switches on %s', async (_name, signals) => {
    const h = groupHarness('enabled', false);
    for (let retry = 0; retry < 2; retry += 1) {
      expect(await h.fail(signals)).toMatchObject({ requireRouteChange: false, recovery: { retrySameSource: true } });
    }
    h.fallback.mockResolvedValueOnce({
      session: null, outcome: 'switched', sourceSwitch: { from: 'Model · A', to: 'Model · B' },
    });
    expect(await h.fail(signals)).toMatchObject({ requireRouteChange: true, recovery: { retrySameSource: false } });
    expect(h.delays).toEqual([3000, 6000, 0]);
    expect(h.resume.mock.calls.at(-1)).toEqual(['s', 3, {
      agentSwitch: { from: 'Model · A', to: 'Model · B', cause: 'failed' },
    }]);
  });

  // 测试价值：依据 #12440 与 model-groups.md §4.1（429 临时频率限制应同源重试两次再切换，且不封禁整条连接；
  // 供应商安全拦截不得触发换源绕过）；此前单测手造 429 未带 translator 实产的 usageLimit:true，漏掉了真实 429 被误判成
  // connection 立即换源且报成 usage-limit 的回归；生产入口 createInterruptedTurnAutoResumeHooks / isBotCandidateUnavailable；
  // 最小失败输入为带 usageLimit:true 的 429 信号与安全拦截信号；tier: unit。
  it('retries a translator-enriched 429 twice on the same source before switching with cause overload', async () => {
    const h = groupHarness('enabled', false);
    const rateLimitSignals = {
      errorStatus: 429,
      sdkError: 'rate_limit',
      usageLimit: true,
      codexErrorInfo: 'rateLimitExceeded',
      message: '429 Too Many Requests: rate_limit_exceeded',
    };
    for (let retry = 0; retry < 2; retry += 1) {
      expect(await h.fail(rateLimitSignals)).toMatchObject({
        requireRouteChange: false,
        recovery: { retrySameSource: true, accountUnavailable: false },
      });
    }
    h.fallback.mockResolvedValueOnce({
      session: null, outcome: 'switched', sourceSwitch: { from: 'GPT · A', to: 'GPT · B' },
    });
    expect(await h.fail(rateLimitSignals)).toMatchObject({
      requireRouteChange: true,
      recovery: { retrySameSource: false, accountUnavailable: false },
    });
    expect(h.resume.mock.calls.at(-1)).toEqual(['s', 3, {
      agentSwitch: { from: 'GPT · A', to: 'GPT · B', cause: 'overload' },
    }]);
  });

  it.each([
    { codexErrorInfo: 'misalignmentPolicyViolation', errorStatus: 403, message: 'Forbidden' },
    { reason: 'provider-safety-refusal', errorStatus: 403, message: 'Output blocked by content filtering policy' },
    { errorStatus: 403, message: '{"error":{"code":"safety_violation","message":"Blocked"}}' },
  ])('never treats a provider safety refusal as a replaceable candidate or auto-resumable failure (%j)', async (signals) => {
    const h = groupHarness();
    expect(isBotCandidateUnavailable(signals)).toBe(false);
    expect(await h.fail(signals)).toBeNull();
    expect(h.resume).not.toHaveBeenCalled();
  });

  it('leaves a deterministic failure visible even if it carries an ordinarily retryable status', async () => {
    const h = groupHarness();
    expect(await h.fail({ codexErrorInfo: 'cyberPolicy', errorStatus: 503 })).toBeNull();
    expect(h.resume).not.toHaveBeenCalled();
  });

  it.each(['exhausted', 'failed', 'unchanged'])('surfaces the error after two retries when choosing a new source returns %s', async outcome => {
    const h = groupHarness();
    const signals = { errorStatus: 503 };
    await h.fail(signals);
    await h.fail(signals);
    h.fallback.mockResolvedValueOnce({ session: null, outcome });
    await h.fail(signals);
    expect(h.resume).toHaveBeenCalledTimes(2);
    expect(h.finalize).toHaveBeenCalledWith('s', 3, { surfaceBanner: true });
  });

  it('keeps same-source continuation for a disabled model group without invoking catalog fallback', async () => {
    const h = groupHarness('disabled');
    const signals = { errorStatus: 503 };
    await h.fail(signals);
    expect(await h.fail(signals)).toMatchObject({ requireRouteChange: false, recovery: { retrySameSource: true } });
    expect(h.resume).toHaveBeenCalledTimes(2);
  });

  it('a disabled model group does not inherit global fallback when interrupted-turn resume is off', async () => {
    const h = groupHarness('disabled', false);
    expect(await h.fail({ errorStatus: 503 })).toBeNull();
    expect(h.resume).not.toHaveBeenCalled();
  });

  it.each([
    ['a removed model', { reason: 'model_unavailable' }, false],
    ['out of credit', { errorStatus: 402 }, true],
  ] as const)('switches source at once on %s, skipping the connection only when it is the connection that failed', async (_name, signals, wholeConnection) => {
    const h = groupHarness();
    const { requireRouteChange, recovery } = (await h.fail(signals))!;
    expect(requireRouteChange).toBe(true);
    expect(recovery).toMatchObject({ retrySameSource: false, accountUnavailable: wholeConnection });
    expect(h.delays).toEqual([0]);
  });

  it.each([
    ['an account quota', { usageLimit: true }, 'usage-limit'],
    ['a dead login', { reason: 'provider_auth_or_access' }, 'auth'],
    ['a removed model', { reason: 'model_unavailable' }, 'unavailable'],
    ['a dead key reported only as text', { message: '401: {"message":"Invalid token"}' }, 'auth'],
    ['a task account that must sign in again', { reason: 'LAZY_CREATE_FAILED', message: '[SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED] requires login' }, 'auth'],
    ['a task account at its limit', { reason: 'REHYDRATE_FAILED', message: '[SUBSCRIPTION_ACCOUNT_LIMITED] usage limit' }, 'usage-limit'],
  ] as const)('says on the continuation which source it moved to after %s', async (_name, signals, cause) => {
    const h = groupHarness();
    h.fallback.mockResolvedValueOnce({ session: null, outcome: 'switched', sourceSwitch: { from: 'Claude · A', to: 'GPT · B' } });
    await h.fail(signals);
    expect(h.resume.mock.calls.at(-1)).toEqual(['s', 1, { agentSwitch: { from: 'Claude · A', to: 'GPT · B', cause } }]);
  });

  it('records nothing extra when the source stayed', async () => {
    const h = groupHarness();
    await h.fail({ errorStatus: 503 });
    expect(h.resume.mock.calls.at(-1)).toEqual(['s', 1]);
  });
});
