import { describe, expect, it, vi } from 'vitest';
import { botGroupRuntimeFailureCode, readBotGroupRuntimeFailureDetail, settleUndispatchedBotGroupTurn } from '../botGroupRuntimeFailure.js';

describe('group runtime failure diagnostics', () => {
  it.each([
    ['[PI_IMAGE_INPUT_UNSUPPORTED] private model details', 'IMAGE_INPUT_UNSUPPORTED'],
    ['[MODEL_NOT_FOUND] private route', 'MODEL_UNAVAILABLE'],
    ['[INVALID_TOKEN] private token', 'AUTH_REQUIRED'],
    ['[RATE_LIMIT_EXCEEDED] private response', 'RATE_LIMITED'],
    ['[INSUFFICIENT_BALANCE] private account', 'QUOTA_EXCEEDED'],
    ['ECONNRESET private endpoint', 'NETWORK_ERROR'],
    ['RUNTIME_TIMEOUT', 'RUNTIME_TIMEOUT'],
    ['unknown private prompt, path and credentials', 'RUNTIME_ERROR'],
  ])('classifies %s without returning the diagnostic text', (error, code) => {
    expect(botGroupRuntimeFailureCode(new Error(error))).toBe(code);
  });

  it.each([
    [{ message: '[PI_IMAGE_INPUT_UNSUPPORTED] private model details' }, 'IMAGE_INPUT_UNSUPPORTED'],
    [{ code: 'INVALID_TOKEN', message: 'private response' }, 'AUTH_REQUIRED'],
    [{ reason: 'rate_limit_error', message: 'private response' }, 'RATE_LIMITED'],
    [{ code: 'ECONNRESET', message: 'private endpoint' }, 'NETWORK_ERROR'],
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
});
