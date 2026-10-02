import { randomUUID } from 'node:crypto';
import type { SessionControlRequest, SessionControllerSnapshot, SessionTarget } from '@cindy/maker-shared/session-controller';
import { createSessionSubscription, type SessionSubscriptionUpdate } from './subscription.js';
import { observeSessionSignals } from './signals.js';
import { requireSessionCaller, withSessionCaller } from './callerContext.js';
import { createSessionRouter } from './router.js';
import { executeSessionCommand } from './commands.js';
import { localSessionHost } from './localHost.js';
import { SessionAdmissionError } from './controller.js';
import type { RemoteSessionTicketOwner } from './remoteTickets.js';
import { hasSubscriptionReference, recordSubscribe, recordUnsubscribe } from '../device-link/subscriptionRefcount.js';

/** Main subscription port. Existing device-link topics handle reconnect replay;
 * received payloads are invalidations, followed by a fresh authorized snapshot.
 * This never starts a monitoring job or a separate connection/recovery loop. */
export async function watchSessionController(target: SessionTarget, callerKey: string,
  owner: RemoteSessionTicketOwner, emit: (update: SessionSubscriptionUpdate) => void) {
  const policy = requireSessionCaller();
  const remote = target.deviceId !== localSessionHost.deviceId();
  const transport = await import('../device-link/index.js');
  const router = createSessionRouter({ deviceId: localSessionHost.deviceId, remoteInvoke: transport.remoteInvoke,
    local: request => withSessionCaller(policy, () => executeSessionCommand(request, callerKey)) });
  const request = (): SessionControlRequest => ({ version: 1, requestId: randomUUID(), deviceId: target.deviceId,
    target, command: { operation: 'inspect', args: {} } });
  const reference = Symbol('SessionController subscription');
  const topics = [`session:${target.sessionId}`, 'sessions'];
  let subscribed = false;
  const authorize = async () => {
    owner.assertCurrent();
    if (remote && subscribed && !hasSubscriptionReference(reference, target.deviceId, topics[0])) {
      throw new SessionAdmissionError('CONTROL_DISABLED', '订阅已被关闭。');
    }
    if (remote) await owner.authorizeRemote(request());
    else await policy.authorize({ operation: 'inspect', deviceId: target.deviceId, targets: [target] });
    owner.assertCurrent();
  };
  await authorize();
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    if (remote) {
      const zeroed = recordUnsubscribe(reference, target.deviceId, topics);
      if (zeroed.length) await transport.remoteUnsubscribe(target.deviceId, zeroed);
    }
  };
  try {
    if (remote) {
      const forwarded = recordSubscribe(reference, target.deviceId, topics);
      subscribed = true;
      const result = await transport.remoteSubscribe(target.deviceId, forwarded);
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    }
    await authorize();
    const subscription = createSessionSubscription({ target, authorize, emit,
      onClose: () => { void release().catch(() => undefined); },
      listen: invalidate => observeSessionSignals(event => {
        if (event.deviceId ? event.deviceId !== target.deviceId : remote && !event.channel.startsWith('device-link:')) return;
        if (event.sessionId && event.sessionId !== target.sessionId) return;
        invalidate(event.kind, event.inputId);
      }),
      read: async () => {
        const result = await router(request(), owner);
        if (!result.ok) throw new SessionAdmissionError(result.errorCode, result.message);
        return result.value as SessionControllerSnapshot;
      },
    });
    return { ready: subscription.ready, resync: subscription.resync,
      close: async () => { subscription.close(); await release(); } };
  } catch (error) { await release().catch(() => undefined); throw error; }
}
