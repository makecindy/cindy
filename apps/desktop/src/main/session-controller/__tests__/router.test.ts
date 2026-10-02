import { describe, expect, it, vi } from 'vitest';
import type { SessionControlRequest } from '@cindy/maker-shared/session-controller';
import { createSessionRouter, SESSION_CONTROL_CHANNEL } from '../router.js';
import { createRemoteSessionTickets, remoteSessionTickets, type RemoteSessionTicketOwner } from '../remoteTickets.js';
import { SessionAdmissionError } from '../controller.js';
import { parseSessionControlRequest } from '../requestSchema.js';

const request: SessionControlRequest = { version: 1, requestId: 'rpc-1', deviceId: 'device-b', target: { deviceId: 'device-b', sessionId: 'same-id' },
  command: { operation: 'send', args: { businessKey: 'business-1', message: 'hello' } } };
function owner(): RemoteSessionTicketOwner {
  return { assertCurrent: () => {}, authorizeRemote: async () => ({ sourceSessionId: 'source', callerKey: 'source', authority: 'owner-turn' }) };
}

describe('Session target routing and host attestations', () => {
  it('executes only on the declared device and verifies the issuing host', async () => {
    const local = vi.fn();
    const remoteInvoke = vi.fn(async (deviceId, channel, args) => {
      expect(deviceId).toBe('device-b'); expect(channel).toBe(SESSION_CONTROL_CHANNEL);
      const { token, digest, request: received } = args[0];
      expect(received).toEqual(request);
      expect(await remoteSessionTickets.attest(deviceId, token, digest)).toMatchObject({ authority: 'owner-turn' });
      await expect(remoteSessionTickets.attest('device-c', token, digest)).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
      return { ok: true as const, result: { ok: true, value: { phase: 'queued' } } };
    });
    const router = createSessionRouter({ deviceId: () => 'device-a', local, remoteInvoke });
    expect(await router(request, owner())).toEqual({ ok: true, value: { phase: 'queued' } });
    expect(local).not.toHaveBeenCalled();
    const envelope = remoteInvoke.mock.calls[0][2][0];
    await expect(remoteSessionTickets.attest('device-b', envelope.token, envelope.digest)).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });
  it('reports unknown write outcomes with the original business key without retry or local fallback', async () => {
    const local = vi.fn(); const remoteInvoke = vi.fn(async () => { throw Object.assign(new Error('timeout after commit'), { code: 'TIMEOUT' }); });
    const router = createSessionRouter({ deviceId: () => 'device-a', local, remoteInvoke });
    expect(await router(request, owner())).toMatchObject({ ok: false, errorCode: 'UNKNOWN_OUTCOME', idempotencyKey: 'business-1', requestId: 'rpc-1' });
    expect(remoteInvoke).toHaveBeenCalledOnce(); expect(local).not.toHaveBeenCalled();
  });
  it('rejects a revoked source and JSON identity claims, even with a valid paired device', async () => {
    const tickets = createRemoteSessionTickets();
    const authority = owner();
    const ticket = await tickets.issue(request, authority);
    authority.authorizeRemote = async () => { throw new SessionAdmissionError('NOT_AUTHORIZED', 'old generation'); };
    await expect(tickets.attest('device-b', ticket.token, ticket.digest)).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    expect(() => parseSessionControlRequest({ ...request, caller: { owner: true } })).toThrow();
    ticket.release();
  });
  it('distinguishes unsupported hosts and mismatched devices', async () => {
    const remoteInvoke = vi.fn(async () => ({ ok: false as const, error: { code: 'CHANNEL_NOT_ALLOWED' as const, message: 'old host' } }));
    const router = createSessionRouter({ deviceId: () => 'device-a', local: vi.fn(), remoteInvoke });
    expect(await router(request, owner())).toMatchObject({ errorCode: 'UNSUPPORTED_CAPABILITY' });
    expect(await router({ ...request, target: { deviceId: 'device-c', sessionId: 'same-id' } }, owner())).toMatchObject({ errorCode: 'INVALID_ARGS' });
    expect(remoteInvoke).toHaveBeenCalledOnce();
  });
});
