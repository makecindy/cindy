import { describe, expect, it } from 'vitest';
import { makeBindStart, makeBindState, makeBindUpdate, parseHookMessage, serializeHookMessage } from '../index';

describe('device Slack communications (append-only)', () => {
  it('round-trips legacy binding and communications-only authorization', () => {
    const row = { teamId: 'T1', teamName: null, slackUserId: 'U1', slackUserName: null, enabled: false };
    for (const frame of [
      makeBindStart({}),
      makeBindStart({ teamId: 'T1', purpose: 'communications' }),
      makeBindUpdate({ state: 'pending', purpose: 'communications', authorizeUrl: 'https://example.test/oauth', slackUserId: null, slackUserName: null, message: null }),
      makeBindState({ bindings: [] }),
      makeBindState({ bindings: [], communications: [row] }),
    ]) expect(parseHookMessage(serializeHookMessage(frame))).toMatchObject({ ok: true, message: frame });
  });
  it.each([null, {}, [{ enabled: true }], [{ teamId: 'T1', teamName: null, slackUserId: 'U1', slackUserName: null, enabled: 'true' }]])('rejects malformed communications %j', (communications) => {
    const frame = makeBindState({ bindings: [] });
    expect(parseHookMessage({ ...frame, payload: { ...frame.payload, communications } }).ok).toBe(false);
  });
  it('rejects an unknown authorization purpose instead of treating it as Bot takeover', () => {
    const frame = makeBindStart({});
    expect(parseHookMessage({ ...frame, payload: { purpose: 'unknown' } }).ok).toBe(false);
  });
});
