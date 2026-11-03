import { describe, it, expect } from 'vitest';
import { NodeAuthorizationClient } from '../nodeAuthorizationClient.js';
import { NodeRequestScopes } from '../nodeRequestScope.js';
import { parseGhostNodeChildToHostMessage } from '../../../shared/ghost.js';

function harness() {
  const scopes = new NodeRequestScopes(),
    sent: Record<string, unknown>[] = [];
  const client = new NodeAuthorizationClient(scopes, (raw) =>
    sent.push(raw as Record<string, unknown>),
  );
  let authorize!: NonNullable<ReturnType<NodeAuthorizationClient['bind']>>;
  scopes.feed('{"id":"1","cindy":{"cancelWithCall":true}}', () => {
    authorize = client.bind()!;
  });
  return { scopes, sent, client, authorize };
}
describe('generic private Node authorization', () => {
  it('binds the originating RPC and accepts a user code without exposing it through stdout', async () => {
    const h = harness();
    const request = {
      kind: 'device' as const,
      url: 'https://provider.example/activate',
      userCode: '123456789',
    };
    const waiting = h.authorize(request);
    expect(h.sent[0]).toEqual({ type: 'plugin-authorize', reqId: 'auth1', rpcId: '1', request });
    expect(parseGhostNodeChildToHostMessage(h.sent[0])).toEqual(h.sent[0]);
    h.client.reply({ reqId: 'auth1', ok: true, result: { kind: 'opened' } });
    await expect(waiting).resolves.toEqual({ kind: 'opened' });
    await expect(h.authorize(request)).rejects.toThrow();
  });
  it('rejects late callback and a callback injected into a device request', async () => {
    const h = harness();
    const waiting = h.authorize({ kind: 'device', url: 'https://provider.example/activate' });
    h.client.reply({
      reqId: 'auth1',
      ok: true,
      result: { kind: 'callback', state: 's'.repeat(43), code: 'synthetic' },
    });
    await expect(waiting).rejects.toThrow();
    const late = harness();
    const pending = late.authorize({ kind: 'browser', url: 'https://provider.example/qr' });
    late.scopes.finish('1');
    late.client.reply({ reqId: 'auth1', ok: true, result: { kind: 'opened' } });
    await expect(pending).rejects.toThrow();
  });
  it('denies background calls, forged task IDs, URLs and commands in the control frame', () => {
    const h = harness();
    expect(h.client.bind()).toBeUndefined();
    const valid = {
      type: 'plugin-authorize',
      reqId: 'a',
      rpcId: '1',
      request: { kind: 'browser', url: 'https://provider.example' },
    };
    for (const raw of [
      { ...valid, sessionId: 'forged' },
      { ...valid, rpcId: 'call-a' },
      { ...valid, request: { ...valid.request, command: 'anything' } },
      { ...valid, request: { kind: 'browser', url: 'http://provider.example' } },
    ])
      expect(parseGhostNodeChildToHostMessage(raw)).toBeNull();
  });
  it('cancels pending work when its RPC ends', async () => {
    const h = harness(),
      waiting = h.authorize({ kind: 'browser', url: 'https://provider.example/qr' });
    h.client.finish('1');
    await expect(waiting).rejects.toThrow();
    h.client.reply({ reqId: 'auth1', ok: true, result: { kind: 'opened' } });
  });
});
