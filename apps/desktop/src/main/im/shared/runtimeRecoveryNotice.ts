import type { Session } from '@cindy/maker-core';
import { t } from '../../i18n';

// One actual channel owner per runtime. A product terminal does not unsubscribe:
// retirement can fail afterwards. Runtime termination/replacement releases it.
const owners = new WeakMap<Session, { cleanup(): void; generations: Set<number> }>();

/** Only Host continuation dispatch may extend the existing logical channel turn. */
export function advanceRuntimeRecoveryNotice(session: Session): void {
  owners.get(session)?.generations.add(session.getTurnGeneration());
}

export function bindRuntimeRecoveryNotice(
  session: Session,
  deliver: (text: string) => Promise<unknown>,
  log: { warn(message: string): void },
): void {
  if (session.agentKind !== 'pi') return;
  owners.get(session)?.cleanup();
  const generations = new Set([session.getTurnGeneration()]);
  const cleanup = (): void => {
    offEvent();
    offStatus();
    if (owners.get(session)?.cleanup === cleanup) owners.delete(session);
  };
  const offEvent = session.onRuntimeRecovery((event) => {
    if (!event.runtimeRecovery || event.sessionInstanceId !== session.instanceId
      || !generations.has(event.sessionTurnGeneration ?? -1) || event.type !== 'text') return;
    cleanup(); // Claim once before invoking any asynchronous channel operation.
    try {
      // No model consumes this post-terminal notice. Keep the machine receipt
      // on the internal event; never expose its JSON/protocol enum to the channel.
      void deliver(t('settings.piPackages.failure.runtimeRetirementFailed')).then((result) => {
        if (result === false) log.warn('runtime recovery channel notice was not delivered');
      }).catch(() => log.warn('runtime recovery channel notice delivery failed'));
    } catch {
      log.warn('runtime recovery channel notice delivery failed');
    }
  });
  const offStatus = session.onStatusChange((status) => {
    if (status === 'closed' || status === 'error') cleanup();
  });
  owners.set(session, { cleanup, generations });
}
