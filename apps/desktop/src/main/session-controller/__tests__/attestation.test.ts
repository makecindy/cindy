import { describe, expect, it, vi } from 'vitest';
import { createSessionAttestations } from '../attestation.js';
import { createRemoteSessionTickets } from '../remoteTickets.js';
import type { SessionControlRequest } from '@cindy/maker-shared/session-controller';

const request: SessionControlRequest = { version: 1, deviceId: 'target', requestId: 'rpc', target: { deviceId: 'target', sessionId: 's' },
  command: { operation: 'inspect', args: {} } };
const principal = { sourceSessionId: 'caller', callerKey: 'caller', authority: 'owner-turn' as const };

describe('attestation over the existing return lane', () => {
  it('revalidates the source for each challenge without a reverse invoke or link-open', async () => {
    const source = createRemoteSessionTickets(), target = createSessionAttestations();
    const authorize = vi.fn(async () => principal);
    const ticket = await source.issue(request, { assertCurrent() {}, authorizeRemote: authorize });
    const exchange = () => target.request('source', ticket.token, ticket.digest, frame => {
      if (frame.kind !== 'challenge') throw Error('expected challenge');
      void source.attest('target', frame.token, frame.digest).then(p => {
        source.assertCurrent('target', frame.token, frame.digest);
        target.answer('source', { kind: 'answer', challenge: frame.challenge, principal: p });
      });
    });
    expect(await exchange()).toEqual(principal);
    expect(await exchange()).toEqual(principal);
    expect(authorize).toHaveBeenCalledTimes(3);
    ticket.release();
    expect(() => source.assertCurrent('target', ticket.token, ticket.digest)).toThrow();
  });
  it('ignores other devices, invented identities and old responses', async () => {
    const target = createSessionAttestations(); let settled = false;
    let challenge = '';
    const promise = target.request('source', 'token', 'digest', f => { challenge = f.challenge; }).then(v => { settled = true; return v; });
    target.answer('other', { kind: 'answer', challenge, principal });
    target.answer('source', { kind: 'answer', challenge, principal: { owner: true } });
    await Promise.resolve(); expect(settled).toBe(false);
    target.answer('source', { kind: 'answer', challenge, principal });
    expect(await promise).toEqual(principal);
    target.answer('source', { kind: 'answer', challenge, principal: null });
  });
  it('expires lost challenges without executing a control or keeping a grant', async () => {
    vi.useFakeTimers();
    try {
      const target = createSessionAttestations(50);
      const result = expect(target.request('source', 'token', 'digest', () => {})).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
      await vi.advanceTimersByTimeAsync(50); await result;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
