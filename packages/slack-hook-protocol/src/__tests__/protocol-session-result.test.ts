import { describe, expect, it } from 'vitest';
import { makeTurnEnd, parseHookMessage, serializeHookMessage } from '../index';

describe('background turn.end compatibility', () => {
  const payload = { requestId: 'result', externalKey: 'slack:dm:T:U:g0', sessionId: 'session',
    status: 'ok' as const, finalText: 'result', errorMessage: null, usage: { durationMs: 1 } };
  it('keeps ordinary frames unchanged and round-trips background results', () => {
    for (const value of [payload, { ...payload, background: true as const }]) {
      const frame = makeTurnEnd(value);
      expect(parseHookMessage(serializeHookMessage(frame))).toEqual({ ok: true, message: frame });
    }
  });
  it.each([false, 'true', 1])('rejects invalid background flag %s', (background) => {
    const frame = makeTurnEnd(payload);
    expect(parseHookMessage({ ...frame, payload: { ...payload, background } }).ok).toBe(false);
  });
  it('rejects a background result claiming an inbound client-final delivery', () => {
    const frame = makeTurnEnd(payload);
    expect(parseHookMessage({ ...frame, payload: { ...payload, background: true, clientFinal: { delivered: true } } }).ok).toBe(false);
  });
});
