import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { CODEX_RESET_CREDIT_RESUME_REASON } from '@cindy/maker-shared/synthetic-trigger';
import { isCodexUsageLimitSignal } from '../../usage/codexResetCreditAutoUse';
import { canResumeAfterRuntimeFallback, isBotCandidateUnavailable } from '../botCandidateRecovery';
import { isInterruptedTurnError, isAcceptedTurnContinuationOnlyReason } from '../interruptedTurnAutoResume';

const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');

/** Execute the production registration callbacks without starting Electron or touching accounts. */
function harness(bot = true, codex: {
  agentKind?: string;
  remoteHostId?: string | null;
  providerId?: string | null;
  autoUse?: boolean;
} = {}) {
  const item = { clientId: 'input', createOpts: {} };
  const hints = source.slice(source.indexOf('  const botFallbackInputs ='), source.indexOf('  const sendToAgentAccepted:'));
  const resetCredit = source.slice(
    source.indexOf('  // 账号配额耗尽 → 用一次重置 → 续跑'),
    source.indexOf('  const inputCoordinator: AgentInputCoordinator = new AgentInputCoordinator({'),
  );
  const callbacks = source.slice(source.indexOf('    isResumableTurnErrorCandidate: canRecoverTurn,'), source.indexOf('    steerToAgent: (sessionId, message, sendOpts) =>'));
  let current = true;
  let scheduled: (() => Promise<void>) | undefined;
  const resume = vi.fn(async () => 'resumed');
  const fallback = vi.fn(async () => ({ session: null, outcome: 'switched' }));
  const finalize = vi.fn();
  const guard = vi.fn(() => ({ action: 'resume', attempt: 1, maxAttempts: 5,
    episodeAttempt: 1, maxEpisodeAttempts: 10, sessionTotal: 1, attemptToken: 1, delayMs: 1000 }));
  const noteResumeSendFailed = vi.fn();
  const spendReset = vi.fn(async () => ({ kind: 'reset' }));
  const mayUseReset = vi.fn(() => codex.autoUse ?? false);
  const deps = {
    isCodexUsageLimitSignal, CODEX_RESET_CREDIT_RESUME_REASON,
    maker: {
      getSession: () => ({ agentKind: codex.agentKind ?? 'codex', remoteHostId: codex.remoteHostId ?? null }),
    },
    getSessionProvider: () => codex.providerId ?? null,
    isOpenAiSubscriptionProviderId: (id: string) => id === 'openai' || id === 'chatgpt-work',
    mayUseCodexResetCreditForUsageLimit: mayUseReset,
    spendCodexResetCreditForWeeklyLimit: spendReset,
    isInterruptedTurnError, isBotCandidateUnavailable, canResumeAfterRuntimeFallback,
    isAcceptedTurnContinuationOnlyReason,
    inputCoordinator: { isExecutionPaused: () => false, autoRetryLastError: resume },
    interruptedTurnAutoResumeGuard: { onInterruptedTurn: guard, noteResumeSendFailed },
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
  const js = transpileModule(`${hints}\n${resetCredit}\nreturn { callbacks: { ${callbacks} }, botFallbackInputs };`, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  const runtime = new Function(...Object.keys(deps), js)(...Object.values(deps));
  if (bot) runtime.botFallbackInputs.add(item.createOpts);
  return { item, ...runtime.callbacks, resume, fallback, finalize, guard, spendReset, mayUseReset,
    noteResumeSendFailed, scheduled: () => scheduled !== undefined,
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
    { message: 'invalid encrypted content' }, { message: 'thread not found' },
  ])('does not reinterpret control or input failures %j', (signals) => {
    expect(isBotCandidateUnavailable(signals)).toBe(false);
  });

  // Gateway budget exhaustion is account-level: no candidate on the same account can
  // recover it, so the shared deterministic-exhaustion signal wins over the 429 (#5266).
  const budgetExceeded = '429: {"message":"ExceededBudget: User=[REDACTED] over budget. Spend=0.0, Budget=0.0","type":"budget_exceeded","code":"429"}';
  it.each([
    { errorStatus: 429, message: budgetExceeded },
    { reason: 'turn-failed', errorStatus: 429, message: budgetExceeded },
    { sdkError: 'rate_limit', message: 'Request failed: budget_exceeded' },
    { errorStatus: 429, message: 'You exceeded your current quota, please check your plan and billing details.' },
    { message: 'insufficient_quota' },
  ])('keeps the account budget exhaustion with the user instead of switching candidates %j', (signals) => {
    expect(isBotCandidateUnavailable(signals)).toBe(false);
  });

  it.each([
    { errorStatus: 429, message: 'Too Many Requests' },
    { errorStatus: 429, message: 'rate limit exceeded, retry after 3s' },
    { sdkError: 'rate_limit', message: 'SDK error: rate_limit' },
  ])('still switches candidates for transient rate limiting %j', (signals) => {
    expect(isBotCandidateUnavailable(signals)).toBe(true);
  });

  it('does not schedule Bot fallback or auto-resume for a gateway budget exhaustion', () => {
    const h = harness();
    const signals = { errorStatus: 429, message: budgetExceeded };
    expect(h.isResumableTurnErrorCandidate(signals, h.item)).toBe(false);
    expect(h.onResumableTurnError('s', signals, h.item)).toBeNull();
    expect(h.guard).not.toHaveBeenCalled();
    expect(h.fallback).not.toHaveBeenCalled();
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
});

describe('Codex reset auto-use on a usage limit', () => {
  const usageLimit = {
    errorStatus: 429,
    codexErrorInfo: 'usageLimitExceeded' as const,
    message: "You've hit your usage limit. Upgrade to Pro or try again in 3 days.",
  };

  it('takes over a Codex usage-limit error, spends a reset, then continues the task', async () => {
    const h = harness(false, { autoUse: true });
    expect(h.isResumableTurnErrorCandidate(usageLimit, h.item, 's')).toBe(true);
    // Without the session the account cannot be resolved, so nothing is held back.
    expect(h.isResumableTurnErrorCandidate(usageLimit, h.item)).toBe(false);
    expect(h.onResumableTurnError('s', usageLimit, h.item)).toEqual({
      error: usageLimit.message,
      reason: CODEX_RESET_CREDIT_RESUME_REASON,
      attempt: 1,
      maxAttempts: 5,
      sessionTotal: 1,
    });
    expect(h.resume).not.toHaveBeenCalled();
    await h.run();
    expect(h.spendReset).toHaveBeenCalledWith('openai');
    expect(h.resume).toHaveBeenCalledWith('s', 1);
    expect(h.fallback).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
  });

  it('continues without spending again when another task just restored the account', async () => {
    const h = harness(false, { autoUse: true, providerId: 'chatgpt-work' });
    h.spendReset.mockResolvedValue({ kind: 'restored' });
    h.onResumableTurnError('s', usageLimit, h.item);
    await h.run();
    expect(h.spendReset).toHaveBeenCalledWith('chatgpt-work');
    expect(h.resume).toHaveBeenCalledWith('s', 1);
  });

  it.each([
    { kind: 'skipped', why: 'already-used' },
    { kind: 'skipped', why: 'not-used-up' },
    { kind: 'failed', outcome: 'noCredit' },
  ])('gives the usage-limit error back when no reset was used (%j)', async (result) => {
    const h = harness(false, { autoUse: true });
    h.spendReset.mockResolvedValue(result as never);
    h.onResumableTurnError('s', usageLimit, h.item);
    await h.run();
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.noteResumeSendFailed).toHaveBeenCalledWith('s', 1);
    expect(h.finalize).toHaveBeenCalledWith('s', 1, { surfaceBanner: true });
  });

  it('does not continue after Stop or a newer user turn', async () => {
    const h = harness(false, { autoUse: true });
    h.spendReset.mockImplementation(async () => { h.cancel(); return { kind: 'reset' }; });
    h.onResumableTurnError('s', usageLimit, h.item);
    await h.run();
    expect(h.resume).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
  });

  it.each([
    ['auto-use is off', { autoUse: false }],
    ['the task runs on an SSH host', { autoUse: true, remoteHostId: 'host-1' }],
    ['the task is not Codex', { autoUse: true, agentKind: 'claude-code' }],
    ['the task uses another provider', { autoUse: true, providerId: 'xd' }],
  ])('leaves the error to the user when %s', (_label, codex) => {
    const h = harness(false, codex);
    expect(h.isResumableTurnErrorCandidate(usageLimit, h.item, 's')).toBe(false);
    expect(h.onResumableTurnError('s', usageLimit, h.item)).toBeNull();
    expect(h.guard).not.toHaveBeenCalled();
    expect(h.spendReset).not.toHaveBeenCalled();
  });

  it('ignores errors that are not an account usage limit', () => {
    const h = harness(false, { autoUse: true });
    const transient = { errorStatus: 429, message: 'Too Many Requests' };
    expect(h.isResumableTurnErrorCandidate(transient, h.item, 's')).toBe(false);
    expect(h.onResumableTurnError('s', transient, h.item)).toBeNull();
    expect(h.spendReset).not.toHaveBeenCalled();
  });

  it('still spends the reset when automatic continuation is not granted', () => {
    const h = harness(false, { autoUse: true });
    h.guard.mockReturnValue({ action: 'skip', why: 'disabled' } as never);
    expect(h.onResumableTurnError('s', usageLimit, h.item)).toBeNull();
    expect(h.spendReset).toHaveBeenCalledWith('openai');
    expect(h.scheduled()).toBe(false);
  });
});
