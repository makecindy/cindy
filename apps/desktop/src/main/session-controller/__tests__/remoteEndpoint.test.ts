import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionControlRequest } from '@cindy/maker-shared/session-controller';
import { createSessionController, sessionOperation, SessionAdmissionError } from '../controller.js';
import { requireSessionCaller } from '../callerContext.js';
import { receiveSessionControl } from '../remoteEndpoint.js';
import { createSessionRouter } from '../router.js';
import { remoteSessionTickets } from '../remoteTickets.js';
import { sessionAttestations } from '../attestation.js';

const h = vi.hoisted(() => ({
  targetOwner: {}, control: true, sourceCurrent: true, protected: false, shared: false,
  write: vi.fn(), beforeWrite: vi.fn(async () => {}), frames: 0,
}));
vi.mock('../../device-link/invoke-context.js', () => ({ getDeviceLinkInvokeContext: () => ({
  controllerDeviceId: 'source', sharedTask: h.shared ? {} : undefined,
  assertCurrent() { if (!h.control) throw Object.assign(new Error('disabled'), { code: 'CONTROL_DISABLED' }); },
  async revalidate() { if (!h.control) throw Object.assign(new Error('disabled'), { code: 'CONTROL_DISABLED' }); },
}) }));
vi.mock('../../device-link/remoteBotSessionBoundary.js', () => ({ assertRemoteBotInvocationAllowed: async () => {
  if (h.protected) throw new Error('protected bot');
} }));
vi.mock('../../device-link/index.js', () => ({ sendSessionAttestationFrame: (_peer: string, frame: { kind: string; token: string; digest: string; challenge: string }, check: () => void) => {
  check(); h.frames++;
  void remoteSessionTickets.attest('target', frame.token, frame.digest).then(principal => {
    remoteSessionTickets.assertCurrent('target', frame.token, frame.digest);
    sessionAttestations.answer('source', { kind: 'answer', challenge: frame.challenge, principal });
  }).catch(() => sessionAttestations.answer('source', { kind: 'answer', challenge: frame.challenge, principal: null }));
} }));
// The business store is isolated; routing, attestation, target policy and core
// admission/late commit fencing are the production implementation.
vi.mock('../commands.js', () => ({ executeSessionCommand: async (request: SessionControlRequest) => {
  const controller = createSessionController({ deviceId: () => 'target', owner: () => h.targetOwner, execution: () => null }, {
    write: sessionOperation({ operation: request.command.operation, targets: () => [request.target!.sessionId], execute: async scope => {
      await h.beforeWrite(); await scope.authorize(); scope.assertCurrent(); h.write(); return { phase: 'queued' };
    } }),
  });
  return controller.invoke(controller.issueCaller(requireSessionCaller()), 'write');
} }));
const request: SessionControlRequest = { version: 1, requestId: 'rpc', deviceId: 'target', target: { deviceId: 'target', sessionId: 'task' },
  command: { operation: 'send', args: { businessKey: 'once', message: 'work' } } };
function fixture() {
  const local = vi.fn();
  const remoteInvoke = vi.fn(async (_device, _channel, args) => ({ ok: true as const, result: await receiveSessionControl(args[0]) }));
  const router = createSessionRouter({ deviceId: () => 'source', local, remoteInvoke });
  return { local, remoteInvoke, run: () => router(request, {
    assertCurrent() { if (!h.sourceCurrent) throw new SessionAdmissionError('NOT_AUTHORIZED', 'source turn replaced'); },
    authorizeRemote: async () => ({ sourceSessionId: 'caller', callerKey: 'caller', authority: 'owner-turn' }),
  }) };
}
beforeEach(() => { vi.clearAllMocks(); h.control = true; h.sourceCurrent = true; h.protected = false; h.shared = false; h.frames = 0; h.beforeWrite.mockResolvedValue(undefined); });
describe('same-account remote Session command integration', () => {
  it('uses one forward invoke with return-lane challenges and the common native admission', async () => {
    const f = fixture(); expect(await f.run()).toEqual({ ok: true, value: { phase: 'queued' } });
    expect(f.remoteInvoke).toHaveBeenCalledOnce(); expect(f.local).not.toHaveBeenCalled();
    expect(h.frames).toBeGreaterThanOrEqual(3); expect(h.write).toHaveBeenCalledOnce();
  });
  it.each(['control', 'source', 'protected', 'guest'])('rejects %s changes without a native write or local fallback', async kind => {
    if (kind === 'guest') h.shared = true;
    else h.beforeWrite.mockImplementationOnce(async () => {
      if (kind === 'control') h.control = false;
      else if (kind === 'source') h.sourceCurrent = false;
      else h.protected = true;
    });
    const f = fixture();
    expect(await f.run()).toMatchObject({ ok: false, errorCode: kind === 'control' ? 'CONTROL_DISABLED' : 'NOT_AUTHORIZED' });
    expect(h.write).not.toHaveBeenCalled(); expect(f.local).not.toHaveBeenCalled(); expect(f.remoteInvoke).toHaveBeenCalledOnce();
  });
});
