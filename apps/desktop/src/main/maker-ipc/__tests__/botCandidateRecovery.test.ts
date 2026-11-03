import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  areCodexModelsInSameQuotaBucket,
  canResumeAfterRuntimeFallback,
  isAccountUsageExhausted,
  isBotCandidateUnavailable,
  isCandidateQuotaBlocked,
  isRouteExhaustedForCandidate,
  isSameAccountRoute,
  usageExhaustionScope,
} from '../botCandidateRecovery';
import { isInterruptedTurnError, isAcceptedTurnContinuationOnlyReason } from '../interruptedTurnAutoResume';
import { botModelRouteRuntimeKey, nextBotModelRoute, type BotModelRoute } from '../../../shared/botModelChain';

const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');

/** Execute the production registration callbacks without starting Electron or touching accounts. */
function harness(bot = true) {
  const item = { clientId: 'input', createOpts: {} };
  const hints = source.slice(source.indexOf('  const botFallbackInputs ='), source.indexOf('  const sendToAgentAccepted:'));
  const callbacks = source.slice(source.indexOf('    isResumableTurnErrorCandidate: canRecoverTurn,'), source.indexOf('    steerToAgent: (sessionId, message, sendOpts) =>'));
  let current = true;
  let scheduled: (() => Promise<void>) | undefined;
  const resume = vi.fn(async () => 'resumed');
  const fallback = vi.fn(async () => ({ session: null, outcome: 'switched' }));
  const finalize = vi.fn();
  const guard = vi.fn(() => ({ action: 'resume', attempt: 1, maxAttempts: 5,
    episodeAttempt: 1, maxEpisodeAttempts: 10, sessionTotal: 1, attemptToken: 1, delayMs: 1000 }));
  const deps = {
    isInterruptedTurnError, isAccountUsageExhausted, isBotCandidateUnavailable, canResumeAfterRuntimeFallback,
    usageExhaustionScope,
    isAcceptedTurnContinuationOnlyReason,
    inputCoordinator: { isExecutionPaused: () => false, autoRetryLastError: resume },
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
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
  };
  const js = transpileModule(`${hints}\nreturn { callbacks: { ${callbacks} }, botFallbackInputs };`, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  const runtime = new Function(...Object.keys(deps), js)(...Object.values(deps));
  if (bot) runtime.botFallbackInputs.add(item.createOpts);
  return { item, ...runtime.callbacks, resume, fallback, finalize, guard,
    run: () => scheduled!(), cancel: () => { current = false; } };
}

describe('Bot candidate recovery', () => {
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
    expect(h.fallback).toHaveBeenCalledWith('s', 1, 1, true, expect.any(Function), 'account');
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
    expect(h.fallback).toHaveBeenCalledWith('s', 1, 1, true, expect.any(Function), false);
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
    { message: 'invalid encrypted content' }, { message: 'thread not found' },
  ])('does not reinterpret control or input failures %j', (signals) => {
    expect(isBotCandidateUnavailable(signals)).toBe(false);
  });

  // Account exhaustion cannot be recovered on the same account (#5266), but a configured
  // candidate on another account can take over. Codex sends `usageLimitExceeded` with
  // "You've hit your usage limit" and no HTTP status; the structured tag is authoritative.
  const budgetExceeded = '429: {"message":"ExceededBudget: User=[REDACTED] over budget. Spend=0.0, Budget=0.0","type":"budget_exceeded","code":"429"}';
  const codexUsageLimit = { codexErrorInfo: 'usageLimitExceeded', message: "You've hit your usage limit. Upgrade to Pro or try again at 10:55 PM." };
  it.each([
    codexUsageLimit,
    { codexErrorInfo: 'usageLimitExceeded' },
    { codexErrorInfo: 'sessionBudgetExceeded' },
    { sdkError: 'billing_error' },
    { errorStatus: 429, message: budgetExceeded },
    { reason: 'turn-failed', errorStatus: 429, message: budgetExceeded },
    { sdkError: 'rate_limit', message: 'Request failed: budget_exceeded' },
    { errorStatus: 429, message: 'You exceeded your current quota, please check your plan and billing details.' },
    { message: 'insufficient_quota' },
    { message: "You've hit your session limit: budget_exceeded" },
    { message: "You've hit your session limit · resets 9:30pm (Asia/Shanghai)" },
    { sdkError: 'rate_limit', usageResetAt: 1_800_000_000_000, message: 'SDK error: rate_limit' },
    { errorStatus: 402, message: 'Payment Required' },
  ])('switches only to another account on account exhaustion %j', (signals) => {
    expect(isBotCandidateUnavailable(signals)).toBe(true);
    expect(isAccountUsageExhausted(signals)).toBe(true);
  });

  it.each([
    { reason: 'context_overflow', codexErrorInfo: 'usageLimitExceeded' },
    { reason: 'user_denied', message: 'insufficient_quota' },
  ])('keeps explicit control reasons ahead of account exhaustion %j', (signals) => {
    expect(isBotCandidateUnavailable(signals)).toBe(false);
  });

  it.each([
    { sdkError: 'invalid_request', message: 'insufficient_quota' },
    { sdkError: 'invalid_request', message: 'You exceeded your current quota' },
    { sdkError: 'max_output_tokens', message: 'insufficient_quota' },
  ])('does not reclassify unretryable SDK tags as account exhaustion %j', (signals) => {
    expect(isAccountUsageExhausted(signals)).toBe(false);
    expect(isBotCandidateUnavailable(signals)).toBe(false);
  });

  it('identifies routes that share the exhausted account', () => {
    const current = { harness: 'codex', providerId: 'openai', agentDeviceId: null };
    expect(isSameAccountRoute({ harness: 'codex', providerId: 'openai' }, current)).toBe(true);
    expect(isSameAccountRoute({ harness: 'codex', providerId: 'gemini' }, current)).toBe(false);
    expect(isSameAccountRoute({ harness: 'claude', providerId: 'openai' }, current)).toBe(true);
    expect(isSameAccountRoute({ harness: 'codex', providerId: 'openai', agentDeviceId: 'other-pc' }, current)).toBe(false);

    // Native subscription routes without a custom providerId share account only if harness matches
    const currentSub = { harness: 'claude', providerId: null, agentDeviceId: null };
    expect(isSameAccountRoute({ harness: 'claude', providerId: null }, currentSub)).toBe(true);
    expect(isSameAccountRoute({ harness: 'claude', providerId: 'anthropic' }, currentSub)).toBe(true);
    expect(isSameAccountRoute({ harness: 'codex', providerId: null }, currentSub)).toBe(false);
    expect(isSameAccountRoute({ harness: 'claude', providerId: 'openai' }, currentSub)).toBe(false);

    // Implicit Codex OAuth routes (providerId: null) resolve to canonical 'openai'
    const legacyCodex = { harness: 'codex', providerId: null, agentDeviceId: null };
    expect(isSameAccountRoute({ harness: 'codex', providerId: 'openai' }, legacyCodex)).toBe(true);
    expect(isSameAccountRoute({ harness: 'codex', providerId: null }, legacyCodex)).toBe(true);
    expect(isSameAccountRoute({ harness: 'codex', providerId: 'other-provider' }, legacyCodex)).toBe(false);

    // Implicit Pi gateway aliases (null, xd, cindy) resolve to the same canonical provider account
    const piGateway = { harness: 'pi', providerId: null, agentDeviceId: null };
    expect(isSameAccountRoute({ harness: 'pi', providerId: 'xd' }, piGateway)).toBe(true);
    expect(isSameAccountRoute({ harness: 'pi', providerId: 'cindy' }, piGateway)).toBe(true);
    expect(isSameAccountRoute({ harness: 'codex', providerId: 'xd' }, piGateway)).toBe(true);
    expect(isSameAccountRoute({ harness: 'pi', providerId: 'custom-byom' }, piGateway)).toBe(false);
  });

  it.each([
    { errorStatus: 429, message: 'Too Many Requests' },
    { errorStatus: 429, message: 'rate limit exceeded, retry after 3s' },
    { sdkError: 'rate_limit', message: 'SDK error: rate_limit' },
  ])('still switches candidates for transient rate limiting %j', (signals) => {
    expect(isBotCandidateUnavailable(signals)).toBe(true);
  });

  it('asks the Bot fallback to skip the exhausted account and resumes after a switch', async () => {
    const h = harness();
    expect(h.isResumableTurnErrorCandidate(codexUsageLimit, h.item)).toBe(true);
    expect(h.onResumableTurnError('s', codexUsageLimit, h.item)).not.toBeNull();
    await h.run();
    expect(h.fallback).toHaveBeenCalledWith('s', 1, 1, true, expect.any(Function), 'bucket');
    expect(h.resume).toHaveBeenCalledWith('s', 1);
  });

  it('passes account scope when billing or budget is exhausted', async () => {
    const h = harness();
    const billingError = { sdkError: 'billing_error', message: 'Billing error' };
    expect(h.isResumableTurnErrorCandidate(billingError, h.item)).toBe(true);
    expect(h.onResumableTurnError('s', billingError, h.item)).not.toBeNull();
    await h.run();
    expect(h.fallback).toHaveBeenCalledWith('s', 1, 1, true, expect.any(Function), 'account');
    expect(h.resume).toHaveBeenCalledWith('s', 1);
  });

  it('surfaces account exhaustion when no other account is configured', async () => {
    const h = harness();
    h.fallback.mockResolvedValue({ session: null, outcome: 'exhausted' });
    h.onResumableTurnError('s', { errorStatus: 429, message: budgetExceeded }, h.item);
    await h.run();
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.finalize).toHaveBeenCalledWith('s', 1, { surfaceBanner: true });
  });

  it('keeps ordinary sessions out of account-exhaustion recovery', () => {
    const h = harness(false);
    expect(h.isResumableTurnErrorCandidate(codexUsageLimit, h.item)).toBe(false);
    expect(h.onResumableTurnError('s', codexUsageLimit, h.item)).toBeNull();
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
    expect(bot.fallback).toHaveBeenCalledWith('s', 1, 1, true, expect.any(Function), false);
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
    expect(h.fallback).toHaveBeenCalledWith('s', 1, 1, false, expect.any(Function), false);
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

  it('skips candidates belonging to previously exhausted accounts across chained failures (A1 -> B1 -> A2 -> C1)', () => {
    const a1 = { harness: 'codex' as const, model: 'gpt-4o', providerId: 'account-a' };
    const b1 = { harness: 'claude' as const, model: 'sonnet-3-5', providerId: 'account-b' };
    const a2 = { harness: 'codex' as const, model: 'o1', providerId: 'account-a' };
    const c1 = { harness: 'codex' as const, model: 'gemini', providerId: 'account-c' };
    const chain = [a1, b1, a2, c1];

    // When A1 fails with account exhaustion, all candidates sharing account A are skipped:
    const exhaustedKeysA = chain
      .filter((candidate) => isSameAccountRoute(candidate, a1))
      .map(botModelRouteRuntimeKey);
    const visitedRoutes = [...exhaustedKeysA];

    // First recovery selects B1:
    const firstCandidate = nextBotModelRoute(chain, a1, visitedRoutes);
    expect(firstCandidate).toMatchObject(b1);

    // B1 is visited / executed:
    visitedRoutes.push(botModelRouteRuntimeKey(b1));

    // When B1 subsequently fails, recovery from B1 still remembers account A is exhausted and skips A2, selecting C1:
    const secondCandidate = nextBotModelRoute(chain, b1, visitedRoutes);
    expect(secondCandidate).toMatchObject(c1);
  });

  describe('Independent quota buckets preservation', () => {
    it('distinguishes account-level exhaustion from model/bucket-level quota limits', () => {
      expect(usageExhaustionScope({ codexErrorInfo: 'usageLimitExceeded' })).toBe('bucket');
      expect(usageExhaustionScope({ codexErrorInfo: 'sessionBudgetExceeded' })).toBe('account');
      expect(usageExhaustionScope({ sdkError: 'billing_error' })).toBe('account');
      expect(usageExhaustionScope({ errorStatus: 402 })).toBe('account');
      expect(usageExhaustionScope({ sdkError: 'rate_limit', usageResetAt: 1000 })).toBe('account');
      expect(usageExhaustionScope({ message: 'budget_exceeded' })).toBe('account');
      expect(usageExhaustionScope({ message: 'exceeded_budget' })).toBe('account');
      expect(usageExhaustionScope({ message: 'insufficient balance' })).toBe('account');
      expect(usageExhaustionScope({ message: 'insufficient funds' })).toBe('account');
      expect(usageExhaustionScope({ message: 'spend cap reached' })).toBe('account');
      expect(usageExhaustionScope({ message: '余额不足' })).toBe('account');
      expect(usageExhaustionScope({ message: 'quota exceeded' })).toBe('bucket');
      expect(usageExhaustionScope({ message: 'insufficient_quota' })).toBe('bucket');
      expect(usageExhaustionScope({ message: "You've hit your usage limit" })).toBe('bucket');
      expect(usageExhaustionScope({ message: "You've hit your session limit" })).toBe('account');
      expect(usageExhaustionScope({ sdkError: 'server_error' })).toBeNull();
    });

    it('identifies whether two Codex models belong to the same quota bucket', () => {
      // Static heuristic: Spark models have an independent promotion bucket from standard models
      expect(areCodexModelsInSameQuotaBucket('gpt-4o', 'gpt-5')).toBe(true);
      expect(areCodexModelsInSameQuotaBucket('gpt-5.3-codex', 'gpt-5.1-codex')).toBe(true);
      expect(areCodexModelsInSameQuotaBucket('gpt-5.3-codex', 'gpt-5.3-codex-spark')).toBe(false);
      expect(areCodexModelsInSameQuotaBucket('spark-mini', 'gpt-5.3-codex-spark')).toBe(true);

      // With authoritative app-server bucket snapshots:
      const buckets = {
        codex: { limitId: 'codex', limitName: 'Codex' },
        codex_bengalfox: { limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark' },
      };
      expect(areCodexModelsInSameQuotaBucket('gpt-5.3-codex', 'gpt-5.1-codex', buckets)).toBe(true);
      expect(areCodexModelsInSameQuotaBucket('gpt-5.3-codex', 'gpt-5.3-codex-spark', buckets)).toBe(false);

      // When the snapshot is incomplete (e.g. only generic 'codex' is cached because Spark has not run yet),
      // Spark candidate must NOT fall back to sharing the generic bucket:
      const onlyGenericBucket = {
        codex: { limitId: 'codex', limitName: 'Codex' },
      };
      expect(areCodexModelsInSameQuotaBucket('gpt-5.3-codex', 'gpt-5.3-codex-spark', onlyGenericBucket)).toBe(false);
      expect(areCodexModelsInSameQuotaBucket('gpt-5.3-codex', 'gpt-5.1-codex', onlyGenericBucket)).toBe(true);
    });

    it('preserves candidates in independent quota buckets when bucket quota is exhausted', () => {
      const current = { harness: 'codex', model: 'gpt-5.3-codex', providerId: 'account-a', agentDeviceId: null };
      const sameBucket = { harness: 'codex', model: 'gpt-5.1-codex', providerId: 'account-a', agentDeviceId: null };
      const sparkCandidate = { harness: 'codex', model: 'gpt-5.3-codex-spark', providerId: 'account-a', agentDeviceId: null };
      const diffAccount = { harness: 'codex', model: 'gpt-5.3-codex', providerId: 'account-b', agentDeviceId: null };

      // Bucket scope (e.g. usageLimitExceeded):
      // - Same bucket on same account is excluded
      expect(isRouteExhaustedForCandidate(sameBucket, current, 'bucket')).toBe(true);
      // - Spark on same account is preserved (independent bucket!)
      expect(isRouteExhaustedForCandidate(sparkCandidate, current, 'bucket')).toBe(false);
      // - Different account is preserved
      expect(isRouteExhaustedForCandidate(diffAccount, current, 'bucket')).toBe(false);

      // Account scope (e.g. sessionBudgetExceeded / 402):
      // - Every candidate on the same account is excluded
      expect(isRouteExhaustedForCandidate(sameBucket, current, 'account')).toBe(true);
      expect(isRouteExhaustedForCandidate(sparkCandidate, current, 'account')).toBe(true);
      // - Different account is still preserved
      expect(isRouteExhaustedForCandidate(diffAccount, current, 'account')).toBe(false);
    });

    it('falls back to Spark candidate on the same account when primary model hits usageLimitExceeded', () => {
      const standard = { harness: 'codex' as const, model: 'gpt-5.3-codex', providerId: 'account-a' };
      const spark = { harness: 'codex' as const, model: 'gpt-5.3-codex-spark', providerId: 'account-a' };
      const sonnet = { harness: 'claude' as const, model: 'sonnet-3-5', providerId: 'account-b' };
      const chain = [standard, spark, sonnet];

      // Standard hits usageLimitExceeded (scope: 'bucket') -> Spark is NOT skipped:
      const fallbackForBucket = nextBotModelRoute(
        chain,
        standard,
        [],
        (candidate) => !isRouteExhaustedForCandidate(candidate, standard, 'bucket'),
      );
      expect(fallbackForBucket).toMatchObject(spark);

      // Standard hits sessionBudgetExceeded / 402 (scope: 'account') -> entire account is skipped, falls back to Sonnet:
      const fallbackForAccount = nextBotModelRoute(
        chain,
        standard,
        [],
        (candidate) => !isRouteExhaustedForCandidate(candidate, standard, 'account'),
      );
      expect(fallbackForAccount).toMatchObject(sonnet);
    });

    it('preserves cross-harness bridge candidates on the same account during bucket exhaustion', () => {
      // Under ChatGPT subscriptions, native Codex uses app-server buckets, while Pi / Claude Code
      // bridges consume the WHAM webSnapshot pool (accountUsageLimit:44-63).
      const codexCurrent = { harness: 'codex' as const, model: 'gpt-5.3-codex', providerId: 'account-openai' };
      const piBridge = { harness: 'pi' as const, model: 'gpt-4o', providerId: 'account-openai' };
      const claudeBridge = { harness: 'claude' as const, model: 'claude-3-5-sonnet', providerId: 'account-openai' };
      const codexSameBucket = { harness: 'codex' as const, model: 'gpt-5.1-codex', providerId: 'account-openai' };

      // Bucket scope: cross-harness candidates remain eligible, same harness & bucket is excluded
      expect(isRouteExhaustedForCandidate(codexSameBucket, codexCurrent, 'bucket')).toBe(true);
      expect(isRouteExhaustedForCandidate(piBridge, codexCurrent, 'bucket')).toBe(false);
      expect(isRouteExhaustedForCandidate(claudeBridge, codexCurrent, 'bucket')).toBe(false);

      // Account scope: everything on the same account is excluded
      expect(isRouteExhaustedForCandidate(codexSameBucket, codexCurrent, 'account')).toBe(true);
      expect(isRouteExhaustedForCandidate(piBridge, codexCurrent, 'account')).toBe(true);
      expect(isRouteExhaustedForCandidate(claudeBridge, codexCurrent, 'account')).toBe(true);
    });
  });
});

describe('Live per-model quota for configured fallbacks', () => {
  const current = { harness: 'claude', model: 'claude-opus-5-5', providerId: 'anthropic', agentDeviceId: null };
  const sameProviderOtherModel = { harness: 'claude', model: 'claude-sonnet-5-5', providerId: 'anthropic', agentDeviceId: null };
  const otherProvider = { harness: 'pi', model: 'argon-4', providerId: 'google-antigravity', agentDeviceId: null };

  it('does not allow live quota to unblock an account-scope failure on the same provider', () => {
    // 402 / billing_error / account budget affects all models on the account:
    expect(isCandidateQuotaBlocked(sameProviderOtherModel, current, 'account', { limited: false })).toBe(true);
  });

  it('uses a same-provider model whose own quota is free when failure is bucket-scoped', () => {
    expect(isCandidateQuotaBlocked(sameProviderOtherModel, current, 'bucket', { limited: false })).toBe(false);
  });

  it('does not let fallback generic bucket block Spark candidate when bucket snapshot is incomplete', () => {
    const codexCurrent = { harness: 'codex', model: 'gpt-5.3-codex', providerId: 'openai', agentDeviceId: null };
    const sparkCandidate = { harness: 'codex', model: 'gpt-5.3-codex-spark', providerId: 'openai', agentDeviceId: null };
    const onlyGenericBuckets = { codex: { limitId: 'codex', limitName: 'Codex' } };
    // Even if readAccountUsageLimit fell back to the generic bucket and returned { limited: true }:
    expect(isCandidateQuotaBlocked(sparkCandidate, codexCurrent, 'bucket', { limited: true }, onlyGenericBuckets)).toBe(false);

    // But if dedicated Spark bucket snapshot is present and reports limited:
    const bucketsWithSpark = {
      codex: { limitId: 'codex', limitName: 'Codex' },
      codex_bengalfox: { limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark' },
    };
    expect(isCandidateQuotaBlocked(sparkCandidate, codexCurrent, 'bucket', { limited: true }, bucketsWithSpark)).toBe(true);

    // Cross-account Spark candidate: Account A's generic bucket snapshot must NOT waive Account B's own limited reading:
    const sparkCandidateAccountB = { harness: 'codex', model: 'gpt-5.3-codex-spark', providerId: 'openai-b', agentDeviceId: null };
    expect(isCandidateQuotaBlocked(sparkCandidateAccountB, codexCurrent, 'bucket', { limited: true }, onlyGenericBuckets)).toBe(true);

    // When candidateBuckets is explicitly provided for candidate account, it is respected:
    expect(isCandidateQuotaBlocked(sparkCandidate, codexCurrent, 'bucket', { limited: true }, onlyGenericBuckets, undefined, bucketsWithSpark)).toBe(true);
  });

  it('preserves usable model candidates when local multi-model provider hits quota exceeded on a specific model', () => {
    const argonCurrent = { harness: 'pi', model: 'argon-4', providerId: 'google-antigravity', agentDeviceId: null };
    const geminiCandidate = { harness: 'pi', model: 'gemini-2.5-pro', providerId: 'google-antigravity', agentDeviceId: null };
    const scope = usageExhaustionScope({ message: 'quota exceeded' });
    expect(scope).toBe('bucket');
    // Gemini candidate on the same provider has free quota:
    expect(isCandidateQuotaBlocked(geminiCandidate, argonCurrent, scope, { limited: false })).toBe(false);
  });

  it('resolves implicit Claude candidate to actual default provider instead of assuming anthropic', () => {
    const currentXd = { harness: 'claude', model: 'sonnet-3-5', providerId: 'xd', agentDeviceId: null };
    const implicitClaude = { harness: 'claude', model: 'sonnet-3-5', providerId: null, agentDeviceId: null };
    const explicitAnthropic = { harness: 'claude', model: 'sonnet-3-5', providerId: 'anthropic', agentDeviceId: null };

    // When default resolver indicates xd is the effective default:
    const resolveDefault = () => 'xd';
    // Implicit Claude matches xd:
    expect(isSameAccountRoute(implicitClaude, currentXd, resolveDefault)).toBe(true);
    // Explicit Anthropic does NOT match xd:
    expect(isSameAccountRoute(explicitAnthropic, currentXd, resolveDefault)).toBe(false);
  });

  it('skips a candidate whose own quota is limited, even on another provider', () => {
    expect(isCandidateQuotaBlocked(otherProvider, current, 'account', { limited: true })).toBe(true);
    expect(isCandidateQuotaBlocked(otherProvider, current, null, { limited: true })).toBe(true);
  });

  it('keeps the static same-account rule when no live quota is known', () => {
    expect(isCandidateQuotaBlocked(sameProviderOtherModel, current, 'account', undefined)).toBe(true);
    expect(isCandidateQuotaBlocked(sameProviderOtherModel, current, 'account', null)).toBe(true);
    expect(isCandidateQuotaBlocked(otherProvider, current, 'account', undefined)).toBe(false);
  });

  it('walks the chain to the first candidate whose quota is free on bucket-scope exhaustion', () => {
    const chain = [
      { ...current },
      { ...sameProviderOtherModel },
      { harness: 'claude', model: 'claude-haiku-5-5', providerId: 'anthropic', agentDeviceId: null },
    ] as BotModelRoute[];
    const live = new Map([
      [botModelRouteRuntimeKey(chain[1]), { limited: true }],
      [botModelRouteRuntimeKey(chain[2]), { limited: false }],
    ]);
    const next = nextBotModelRoute(chain, current as BotModelRoute, [],
      (c) => !isCandidateQuotaBlocked(c, current, 'bucket', live.get(botModelRouteRuntimeKey(c))));
    expect(next?.model).toBe('claude-haiku-5-5');
  });
});
