import { CINDY_MAKE_ENABLED, isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';
import type { DurableOutboxRecord } from './durableOutbox';
import type { OutboxSessionPolicy } from './durableOutboxDelivery';

type SessionSource = { id: string; source?: string | null };

export async function cindyMakeOutboxPolicy(record: DurableOutboxRecord, deps: {
  knownSession(): SessionSource | undefined;
  readSession(): Promise<SessionSource | null>;
  isCurrent(): boolean;
}): Promise<OutboxSessionPolicy> {
  if (CINDY_MAKE_ENABLED) return 'deliver';
  let session = deps.knownSession();
  if (session?.id !== record.item.sessionId || session.source === undefined) {
    try {
      session = await deps.readSession() ?? undefined;
    } catch {
      return 'wait';
    }
  }
  if (!deps.isCurrent() || session?.id !== record.item.sessionId) return 'wait';
  return isCindyMakeSource(session.source) ? 'discard' : 'deliver';
}
