import { describe, expect, it, vi } from 'vitest';
import { botGroupRuntimeFailureCode, readBotGroupRuntimeFailureDetail, settleUndispatchedBotGroupTurn } from '../botGroupRuntimeFailure.js';

describe('group runtime failure diagnostics', () => {
  it.each([
    ['NO_MODEL', 'MODEL_UNAVAILABLE'],
    ['Selected model is at capacity. Please try a different model.', 'UPSTREAM_OVERLOADED'],
    ['overloaded_error', 'UPSTREAM_OVERLOADED'],
    ['the private queue is overloaded', 'RUNTIME_ERROR'],
    ['[PI_IMAGE_INPUT_UNSUPPORTED] private model details', 'IMAGE_INPUT_UNSUPPORTED'],
    ['[MODEL_NOT_FOUND] private route', 'MODEL_UNAVAILABLE'],
    ['[INVALID_TOKEN] private token', 'AUTH_REQUIRED'],
    ['[RATE_LIMIT_EXCEEDED] private response', 'RATE_LIMITED'],
    ['[INSUFFICIENT_BALANCE] private account', 'QUOTA_EXCEEDED'],
    ['ECONNRESET private endpoint', 'NETWORK_ERROR'],
    ['RUNTIME_TIMEOUT', 'RUNTIME_TIMEOUT'],
    ['pi rpc timeout after 30000ms: prompt', 'RUNTIME_TIMEOUT'],
    ['pi rpc timeout after 30000ms: set_model', 'RUNTIME_ERROR'],
    ['Request rejected (429): ExceededBudget private account', 'QUOTA_EXCEEDED'],
    ['budget_exceeded private account', 'QUOTA_EXCEEDED'],
    ['quota exceeded private account', 'QUOTA_EXCEEDED'],
    ['unknown private prompt, path and credentials', 'RUNTIME_ERROR'],
  ])('classifies %s without returning the diagnostic text', (error, code) => {
    expect(botGroupRuntimeFailureCode(new Error(error))).toBe(code);
  });

  it.each([
    [{ message: '[PI_IMAGE_INPUT_UNSUPPORTED] private model details' }, 'IMAGE_INPUT_UNSUPPORTED'],
    [{ code: 'INVALID_TOKEN', message: 'private response' }, 'AUTH_REQUIRED'],
    [{ reason: 'rate_limit_error', message: 'private response' }, 'RATE_LIMITED'],
    [{ code: 'ECONNRESET', message: 'private endpoint' }, 'NETWORK_ERROR'],
    [{ message: 'Authorization: [REDACTED]', errorStatus: 429, usageLimit: true }, 'QUOTA_EXCEEDED'],
    [{ sdkError: 'billing_error' }, 'QUOTA_EXCEEDED'],
    [{ reason: 'provider_quota_limit' }, 'QUOTA_EXCEEDED'],
    [{ errorStatus: 402 }, 'QUOTA_EXCEEDED'],
    [{ errorStatus: 401 }, 'AUTH_REQUIRED'],
    [{ errorStatus: 403 }, 'AUTH_REQUIRED'],
    [{ sdkError: 'authentication_failed' }, 'AUTH_REQUIRED'],
    [{ reason: 'provider_auth_or_access' }, 'AUTH_REQUIRED'],
    [{ sdkError: 'rate_limit', errorStatus: 429, usageLimit: true }, 'RATE_LIMITED'],
    [{ reason: 'provider_rate_limit', usageLimit: true }, 'RATE_LIMITED'],
    [{ errorStatus: 429, usageLimit: false }, 'RATE_LIMITED'],
    [{ message: 'Too many requests', errorStatus: 429, usageLimit: true }, 'RATE_LIMITED'],
    [{ sdkError: 'rate_limit', message: 'ExceededBudget', errorStatus: 429, usageLimit: true }, 'QUOTA_EXCEEDED'],
    [{ sdkError: 'model_not_found' }, 'MODEL_UNAVAILABLE'],
    [{ code: 'NO_MODEL', message: 'private preparation details' }, 'MODEL_UNAVAILABLE'],
    [{ codexErrorInfo: 'serverOverloaded', message: '[REDACTED]' }, 'UPSTREAM_OVERLOADED'],
    [{ reason: 'upstream-overload', message: '[REDACTED]' }, 'UPSTREAM_OVERLOADED'],
    [{ errorStatus: 529, message: '[REDACTED]' }, 'UPSTREAM_OVERLOADED'],
    [{ modelAccessDenied: true, errorStatus: 403 }, 'MODEL_UNAVAILABLE'],
    [{ sdkError: 'user_model_access_denied' }, 'MODEL_UNAVAILABLE'],
    [{ codexErrorInfo: 'usageLimitExceeded', message: '[REDACTED]' }, 'QUOTA_EXCEEDED'],
    [{ codexErrorInfo: 'sessionBudgetExceeded', message: '[REDACTED]' }, 'QUOTA_EXCEEDED'],
    [{ codexErrorInfo: 'unauthorized', message: '[REDACTED]' }, 'AUTH_REQUIRED'],
    [{ codexErrorInfo: 'usageLimitExceeded', errorStatus: 401, sdkError: 'rate_limit' }, 'QUOTA_EXCEEDED'],
    [{ codexErrorInfo: 'unauthorized', sdkError: 'billing_error' }, 'AUTH_REQUIRED'],
    [{ codexErrorInfo: 'httpConnectionFailed', message: '[REDACTED]' }, 'NETWORK_ERROR'],
    [{ codexErrorInfo: 'responseStreamConnectionFailed' }, 'NETWORK_ERROR'],
    [{ codexErrorInfo: 'responseStreamDisconnected' }, 'NETWORK_ERROR'],
    [{ codexErrorInfo: 'httpConnectionFailed', errorStatus: 401 }, 'AUTH_REQUIRED'],
    [{ codexErrorInfo: 'unknown private diagnostic' }, 'RUNTIME_ERROR'],
    [{ reason: 'turn_no_event_timeout', message: '[REDACTED]' }, 'RUNTIME_TIMEOUT'],
    [{ reason: 'bridge_turn_no_event_timeout' }, 'RUNTIME_TIMEOUT'],
    [{ reason: 'upstream_response_idle_timeout', message: '[REDACTED]' }, 'RUNTIME_TIMEOUT'],
    [{ reason: 'bridge_upstream_response_idle_timeout' }, 'RUNTIME_TIMEOUT'],
    [{ reason: 'pi-prompt-timeout', message: '[REDACTED]' }, 'RUNTIME_TIMEOUT'],
    [{ sdkError: 'pi rpc timeout after 60000ms: prompt' }, 'RUNTIME_TIMEOUT'],
    [{ code: 'unknown', message: 'private prompt' }, 'RUNTIME_ERROR'],
  ])('classifies structured terminal diagnostics %j', (error, code) => {
    expect(botGroupRuntimeFailureCode(error)).toBe(code);
  });

  it('accepts only exact public codes from stored failure details', () => {
    expect(readBotGroupRuntimeFailureDetail('cindy-runtime-error:IMAGE_INPUT_UNSUPPORTED')).toBe('IMAGE_INPUT_UNSUPPORTED');
    for (const value of ['raw private error', 'cindy-runtime-error:secret-token', 'cindy-runtime-error:AUTH_REQUIRED private data', null]) {
      expect(readBotGroupRuntimeFailureDetail(value)).toBeUndefined();
    }
  });

  it('settles the exact failed input and leaves explicit cancellation to Stop', async () => {
    const service = { settleLaneTurn: vi.fn(async () => true) };
    expect(await settleUndispatchedBotGroupTurn(service, 'lane', 'failed-input', 'failed', '[PI_IMAGE_INPUT_UNSUPPORTED] private details')).toBe(true);
    expect(service.settleLaneTurn).toHaveBeenCalledExactlyOnceWith({ sessionId: 'lane', activeInputClientId: 'failed-input', outcome: 'error', resultText: '', failureCode: 'IMAGE_INPUT_UNSUPPORTED', undispatched: true });
    expect(await settleUndispatchedBotGroupTurn(service, 'lane', 'stopped-input', 'cancelled', 'private details')).toBe(false);
    expect(service.settleLaneTurn).toHaveBeenCalledTimes(1);
  });

  it('uses the same Pi prompt timeout signal for an undispatched input without exposing diagnostics', async () => {
    const service = { settleLaneTurn: vi.fn(async () => true) };
    await settleUndispatchedBotGroupTurn(service, 'lane', 'input', 'failed', 'pi rpc timeout after 30000ms: prompt /private/path');
    expect(service.settleLaneTurn).toHaveBeenCalledExactlyOnceWith({ sessionId: 'lane', activeInputClientId: 'input',
      outcome: 'error', resultText: '', failureCode: 'RUNTIME_TIMEOUT', undispatched: true });
  });
});
