import { GhostSubscriptionGateway as SharedGhostSubscriptionGateway, type GhostSubscriptionGatewayDeps as SharedDeps } from '@cindy/app-runtime/subscriptionGateway';
import { eq } from 'drizzle-orm';
import { getDbClient } from '../localDb/client/current.js';
import * as localDbSchema from '../localDb/schema.js';
export * from '@cindy/app-runtime/subscriptionGateway';
export type GhostSubscriptionGatewayDeps = Omit<SharedDeps, 'resolveMessageHookContext'> & Partial<Pick<SharedDeps, 'resolveMessageHookContext'>>;
type MessageHookContext = Awaited<ReturnType<SharedDeps['resolveMessageHookContext']>>;
async function readMessageHookContext(sessionId: string): Promise<MessageHookContext> {
  const rows = await getDbClient()
    .drizzle.select({
      model: localDbSchema.sessions.model,
    })
    .from(localDbSchema.sessions)
    .where(eq(localDbSchema.sessions.id, sessionId))
    .limit(1);
  const row = rows[0];
  if (!row) return {};
  return { model: row.model ?? undefined };
}

export class GhostSubscriptionGateway extends SharedGhostSubscriptionGateway {
  constructor(deps: GhostSubscriptionGatewayDeps) {
    super({ ...deps, resolveMessageHookContext: deps.resolveMessageHookContext ?? readMessageHookContext });
  }
}
