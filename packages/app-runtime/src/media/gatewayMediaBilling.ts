import type {DbClient} from '@cindy/runtime-db';
import {retainDbClient} from '@cindy/runtime-db/client/pendingOperations';
import type {DbLogger} from '@cindy/runtime-db/logging';
import type {RegionalMoney, createRegionalMoney} from '@cindy/maker-shared/regional-money';
import type {OwnerBroadcastTap} from '../ownerBroadcast.js';
import type {createSessionSpendBroadcaster} from '../sessionSpendBroadcaster.js';
import type {createUsageBroadcaster} from '../usageBroadcaster.js';
import type {createGatewayModelPricing} from '../modelPricing.js';
import type {createTurnCostBroadcaster} from '../turnCostBroadcaster.js';
import type {createDailySpend} from '../dailySpend.js';
import type {createMediaTurnCost} from './mediaTurnCost.js';
import {parseGatewayMediaBillingHeader} from './gatewayMediaBillingHeader.js';
export interface GatewayMediaBillingHost extends
 Pick<OwnerBroadcastTap,'captureDataOwnerBroadcastScope'|'isDataOwnerBroadcastScopeCurrent'>,
 Pick<ReturnType<typeof createSessionSpendBroadcaster>,'broadcastSessionSpend'>,
 Pick<ReturnType<typeof createUsageBroadcaster>,'rebroadcastTodaySpend'>,
 Pick<ReturnType<typeof createGatewayModelPricing>,'getGatewayMediaBillingCurrency'>,
 Pick<ReturnType<typeof createTurnCostBroadcaster>,'broadcastTurnCostPayload'>,
 Pick<ReturnType<typeof createDailySpend>,'localDayKey'>,
 ReturnType<typeof createMediaTurnCost>,
 Pick<ReturnType<typeof createRegionalMoney>,'addRegionalMoney'|'legacyUsdMoney'> {
 getDbClient():DbClient; getCurrentDbClientUserId():string|null; logger:DbLogger;
 enqueueDurableWrite<T>(label:string,write:()=>Promise<T>):Promise<T>;
 broadcastSchedulerChanged(id:string):void;
}
export type GatewayMediaBillingRecorder = ((response: Response) => Promise<void>) & {
  finish(): void;
};


export function createGatewayMediaBilling(host:GatewayMediaBillingHost) {
const {getDbClient,getCurrentDbClientUserId,localDayKey,captureDataOwnerBroadcastScope,isDataOwnerBroadcastScopeCurrent,broadcastSessionSpend,rebroadcastTodaySpend,getGatewayMediaBillingCurrency,captureMediaUserTurn,refreshMediaUserTurnCost,enqueueDurableWrite,broadcastTurnCostPayload,broadcastSchedulerChanged,addRegionalMoney,legacyUsdMoney}=host;
const log=host.logger;
/** Capture the account, database and settlement currency before the paid dispatch. */
async function prepareGatewayMediaBilling(input: {
  model: string;
  sessionId?: string;
  db?: DbClient;
}): Promise<GatewayMediaBillingRecorder> {
  const ownerScope = captureDataOwnerBroadcastScope();
  const dbOwnerId = getCurrentDbClientUserId();
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

return {prepareGatewayMediaBilling};
}
