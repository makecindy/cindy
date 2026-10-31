import { getDbClient, getCurrentDbClientUserId } from '../localDb/client/current.js';
import type { DbClient } from '../localDb/client/DbClient.js';
import { retainDbClient } from '../localDb/client/pendingOperations.js';
import { localDayKey } from '../localDb/dailySpend.js';
import { createLogger } from '../logger.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../device-link/broadcast-tap.js';
import { broadcastSessionSpend } from '../sessionSpendBroadcaster.js';
import { rebroadcastTodaySpend } from '../usageBroadcaster.js';
import { getGatewayMediaBillingCurrency } from './modelPricing.js';
import { parseGatewayMediaBillingHeader } from './gatewayMediaBillingHeader.js';
import { captureMediaUserTurn, refreshMediaUserTurnCost } from './mediaTurnCost.js';
import { enqueueDurableWrite } from '../messagePersistBroadcaster.js';
import { broadcastTurnCostPayload } from '../turnCostBroadcaster.js';
import { broadcastSchedulerChanged } from '../maker-ipc/schedule.js';
import {
  addRegionalMoney,
  legacyUsdMoney,
  type RegionalMoney,
} from '../../shared/regionalMoney.js';

const log = createLogger('gatewayMediaBilling');

export type GatewayMediaBillingRecorder = ((response: Response) => Promise<void>) & {
  finish(): void;
};

/** Capture the account, database and settlement currency before the paid dispatch. */
export async function prepareGatewayMediaBilling(input: {
  model: string;
  sessionId?: string;
  db?: DbClient;
}): Promise<GatewayMediaBillingRecorder> {
  const ownerScope = captureDataOwnerBroadcastScope();
  const dbOwnerId = getCurrentDbClientUserId();
  const providerName = getActiveCatalog().providers.find(provider => provider.id === 'xd')?.name;
  const db = input.db ?? (dbOwnerId ? getDbClient() : null);
  const currency = await getGatewayMediaBillingCurrency().catch(() => null);
  const userTurn =
    db && input.sessionId
      ? await enqueueDurableWrite('media-billing-target', () =>
          captureMediaUserTurn(db, input.sessionId!),
        )
      : null;
  if (!isDataOwnerBroadcastScopeCurrent(ownerScope) || getCurrentDbClientUserId() !== dbOwnerId) {
    throw new Error('Media billing account changed before dispatch');
  }
  const finish = db ? retainDbClient(db) : () => undefined;
  const record = async (response: Response): Promise<void> => {
    if (!response.ok) return;
    const value = response.headers.get('X-Nova-AIGateway-Billing');
    const billing = parseGatewayMediaBillingHeader(value);
    if (!billing) {
      if (value) log.warn('Ignoring invalid Gateway media billing header');
      return;
    }
    if (billing.cost === 0) return;
    if (!db || !currency) {
      log.warn('Media billing unavailable: account database or settlement currency missing');
      return;
    }
    try {
      const now = Date.now();
      // Called only for the original submit response; body reading may proceed in parallel.
      // Polling and recovery of persisted results never reapply this delta.
      const { session, turnCost } = await enqueueDurableWrite('media-billing', async () => {
        const session = await db.tx('usage.recordMediaSpend', {
          day: localDayKey(now),
          model: billing.model ?? input.model,
          ...(providerName ? { providerName } : {}),
          amount: billing.cost,
          currency,
          sessionId: input.sessionId,
          userClientId: userTurn?.clientId,
          now,
        });
        const turnCost =
          input.sessionId && userTurn
            ? await refreshMediaUserTurnCost(db, input.sessionId, userTurn.clientId).catch(
                (error) => {
                  log.warn('Failed to refresh media user-turn cost', String(error));
                  return null;
                },
              )
            : null;
        return { session, turnCost };
      });
      if (!isDataOwnerBroadcastScopeCurrent(ownerScope) || getCurrentDbClientUserId() !== dbOwnerId)
        return;
      if (turnCost) broadcastTurnCostPayload(turnCost, ownerScope);
      if (userTurn?.scheduleId) broadcastSchedulerChanged(userTurn.scheduleId);
      if (input.sessionId && session) {
        const current: RegionalMoney = {
          amount: session.amount,
          currency: session.currency,
          approximate: Boolean(session.approximate),
          kind: 'actual-cost',
        };
        const legacy = legacyUsdMoney(session.legacyUsd);
        const totalMoney =
          legacy.amount > 0 && legacy.currency === current.currency
            ? addRegionalMoney([legacy, current])
            : current;
        broadcastSessionSpend(
          {
            sessionId: input.sessionId,
            totalMoney,
            ...(totalMoney.currency === 'USD' ? { totalCostUsd: totalMoney.amount } : {}),
          },
          ownerScope,
        );
      }
      await rebroadcastTodaySpend(ownerScope);
    } catch (error) {
      // Never retry a paid request because local accounting failed.
      log.warn(
        'Failed to record Gateway media billing',
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  let recording: Promise<void> | undefined;
  return Object.assign(
    (response: Response) => recording ??= record(response).finally(finish),
    { finish },
  );
}
