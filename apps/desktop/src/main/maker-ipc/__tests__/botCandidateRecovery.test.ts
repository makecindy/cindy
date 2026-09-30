import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { canResumeAfterRuntimeFallback, isBotCandidateUnavailable } from '../botCandidateRecovery';
import { isInterruptedTurnError, isAcceptedTurnContinuationOnlyReason } from '../interruptedTurnAutoResume';

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
    isInterruptedTurnError, isBotCandidateUnavailable, canResumeAfterRuntimeFallback,
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
