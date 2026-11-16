import { describe, expect, it } from 'vitest';
import { parseRemoteUtilityRequest, parseRemoteUtilityResponse } from '../remoteUtilityText.js';

// Unit: new wire entry points have no existing coverage; reject unserializable options,
// oversize UTF-8 input and forged diagnostics while preserving real HTTP failures.
const route = { providerId: 'openai', agentKind: 'codex', model: 'test' };
const run = { version: 1, op: 'run', hostEpoch: 'epoch', requestId: 'one', route, prompt: 'hello', options: {} };
describe('remote utility wire contract', () => {
  it('accepts existing one-shot token budget and rejects functions and unknown fields', () => {
    expect(parseRemoteUtilityRequest({ ...run, options: { maxTokens: 81920 } })).toMatchObject({ options: { maxTokens: 81920 } });
    expect(() => parseRemoteUtilityRequest({ ...run, options: { beforeDispatch: () => true } })).toThrow();
    expect(() => parseRemoteUtilityRequest({ ...run, options: { maxTokens: 81921 } })).toThrow();
  });
  it('rejects input exceeding the UTF-8 byte budget without truncation', () => {
    expect(() => parseRemoteUtilityRequest({ ...run, prompt: '界'.repeat(22_000) })).toThrow();
  });
  it('preserves structured HTTP failures while rejecting untrusted diagnostics', () => {
    const result = { ok: false, reason: 'all_candidates_failed', attempts: [{ providerId: 'openai', model: 'test', transport: 'codex-responses', status: 'failed', reason: 'http_error', httpStatus: 429 }] };
    const response = { version: 1, op: 'run', ok: true, requestId: 'one', result };
    expect(parseRemoteUtilityResponse(response)).toEqual(response);
    expect(() => parseRemoteUtilityResponse({ ...response, result: { ...result, attempts: [{ ...result.attempts[0], message: 'secret' }] } })).toThrow();
  });
  it('returns large allowed lists intact and rejects excessive lists explicitly', () => {
    const allowedRoutes = Array.from({ length: 600 }, (_, i) => ({ ...route, model: `model-${i}` }));
    expect(parseRemoteUtilityResponse({ version: 1, op: 'caps', ok: true, hostEpoch: 'epoch', allowedRoutes })).toMatchObject({ allowedRoutes });
    expect(() => parseRemoteUtilityResponse({ version: 1, op: 'caps', ok: true, hostEpoch: 'epoch', allowedRoutes: Array.from({ length: 4097 }, () => route) })).toThrow();
  });
});
