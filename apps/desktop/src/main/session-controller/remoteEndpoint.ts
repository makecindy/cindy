import type { SessionControllerResult } from '@cindy/maker-shared/session-controller';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import { assertRemoteBotInvocationAllowed } from '../device-link/remoteBotSessionBoundary.js';
import { withSessionCaller } from './callerContext.js';
import { SessionAdmissionError } from './controller.js';
import { executeSessionCommand } from './commands.js';
import { sessionIntentFingerprint } from './idempotency.js';
import { parseSessionControlRequest } from './requestSchema.js';
import { remoteSessionFailure } from './router.js';
import type { RemoteSessionPrincipal } from './remoteTickets.js';
import { sessionAttestations } from './attestation.js';
import { assertModelSessionOperationAllowed } from './modelAccess.js';

export async function receiveSessionControl(value: unknown): Promise<SessionControllerResult<unknown>> {
  const context = getDeviceLinkInvokeContext();
  if (!context || context.sharedTask || !value || typeof value !== 'object') throw new SessionAdmissionError('NOT_AUTHORIZED', '需要同账号设备调用。');
  const envelope = value as { request?: unknown; token?: unknown; digest?: unknown };
  const request = parseSessionControlRequest(envelope.request);
  try {
    if (Object.keys(envelope).some(key => !['request', 'token', 'digest'].includes(key))
      || typeof envelope.token !== 'string' || typeof envelope.digest !== 'string'
      || sessionIntentFingerprint(request) !== envelope.digest) {
      throw new SessionAdmissionError('NOT_AUTHORIZED', '调用凭据与请求不匹配。');
    }
    const readSource = async () => {
      await context.revalidate?.();
      const { sendSessionAttestationFrame } = await import('../device-link/index.js');
      const principal = await sessionAttestations.request(context.controllerDeviceId, envelope.token as string, envelope.digest as string,
        frame => sendSessionAttestationFrame(context.controllerDeviceId, frame, () => context.assertCurrent?.()));
      context.assertCurrent?.();
      if (!principal || !['owner-turn', 'ordinary-session'].includes(principal.authority ?? '')
        || typeof principal.callerKey !== 'string' || typeof principal.sourceSessionId !== 'string') {
        throw new SessionAdmissionError('NOT_AUTHORIZED', '来源设备未提供有效调用身份。');
      }
      return principal as RemoteSessionPrincipal;
    };
    let checkingSource: Promise<RemoteSessionPrincipal> | null = null;
    const verifySource = () => {
      if (!checkingSource) checkingSource = readSource().finally(() => { checkingSource = null; });
      return checkingSource;
    };
    const initial = await verifySource();
    const callerKey = JSON.stringify([context.controllerDeviceId, initial.callerKey]);
    const result = await withSessionCaller({ source: 'session', assertCurrent: () => context.assertCurrent?.(),
      authorize: async admission => {
        assertModelSessionOperationAllowed(admission.operation, request);
        const current = await verifySource();
        if (current.callerKey !== initial.callerKey || current.authority !== initial.authority) {
          throw new SessionAdmissionError('NOT_AUTHORIZED', '调用来源已变化。');
        }
        for (const target of admission.targets) {
          if (request.target && target.sessionId !== request.target.sessionId) throw new SessionAdmissionError('NOT_AUTHORIZED', '目标不在本次请求范围内。');
          // The target independently enforces its protected Bot/Review visibility.
          try { await assertRemoteBotInvocationAllowed([target.sessionId], 'maker:get-context-usage'); }
          catch { throw new SessionAdmissionError('NOT_AUTHORIZED', '目标不在可访问范围内。'); }
        }
        context.assertCurrent?.();
      },
    }, () => executeSessionCommand(request, callerKey));
    return { ok: true, value: result };
  } catch (error) { return remoteSessionFailure(error, request); }
}
