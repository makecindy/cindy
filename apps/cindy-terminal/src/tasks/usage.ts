import {createMediaTurnCost} from '@cindy/app-runtime/media/mediaTurnCost';
import {createGatewayMediaBilling} from '@cindy/app-runtime/media/gatewayMediaBilling';
import {createTerminalAccountUsage} from '../models/usage.js';
import {createModelMismatchBroadcaster} from '@cindy/app-runtime/modelMismatchBroadcaster';
import { createDailySpend } from '@cindy/app-runtime/dailySpend';
import { createDailyModelUsage } from '@cindy/app-runtime/dailyModelUsage';
import { createDailySessionUsage } from '@cindy/app-runtime/dailySessionUsage';
import { createScheduleRunCostLedger } from '@cindy/app-runtime/runCostLedger';
import { createTurnCostCalculator } from '@cindy/app-runtime/turnCostCalculator';
import { createTurnCostBroadcaster } from '@cindy/app-runtime/turnCostBroadcaster';
import { createSessionSpendBroadcaster } from '@cindy/app-runtime/sessionSpendBroadcaster';
import { createUsageBroadcaster } from '@cindy/app-runtime/usageBroadcaster';
import { getModelPriceQuote } from '@cindy/model-providers/modelPriceQuote';
import { createTerminalPricing } from '../models/pricing.js';
import type { DbLogger } from '@cindy/runtime-db/logging';
import type { NodeDatabase } from '../database.js';
import type { TerminalConversations } from './conversations.js';
import type { TerminalModelConfig } from '../models/config.js';
import * as usageKeys from '@cindy/app-runtime/usageModelKey';

export async function openTerminalUsage(options: {
  database: NodeDatabase;
  conversations: TerminalConversations;
  models: TerminalModelConfig;
  profileDir: string;
  region: 'cn' | 'global';
  logger: DbLogger;
  assertCurrent(): void;
  emit(channel: string, payload: unknown): void;
}) {
  const { database, conversations } = options;
  const getDbClient = () => { options.assertCurrent(); return database.getDbClient(); };
  const getCurrentDbClientUserId = () => { options.assertCurrent(); return database.getCurrentDbClientUserId(); };
  const createLogger = () => options.logger;
  const pricing = createTerminalPricing({ ...options, getOwnerId: getCurrentDbClientUserId });
  await pricing.prewarmModelPricing();
  options.assertCurrent();
  const base = { ...conversations.money, ...conversations.usage, ...pricing, getDbClient, createLogger };
  const dailySpend = createDailySpend(base);
  const dailyModel = createDailyModelUsage({ ...base, localDayKey: dailySpend.localDayKey });
  const dailySession = createDailySessionUsage({ getDbClient, localDayKey: dailySpend.localDayKey });
  const scheduler = createScheduleRunCostLedger(base);
  const transport = { broadcastLocal: conversations.broadcastLocal, broadcastTap: conversations.broadcastTap };
  const cost = createTurnCostBroadcaster({ ...base, ...conversations.messages, ...conversations.persistence, ...scheduler, ...transport });
  const spend = createSessionSpendBroadcaster({ ...base, ...transport });
  // Usage's original local and tap deliveries overlap. All Node subscribers
  // share one host publish boundary, so local delivery publishes once and the
  // secondary desktop device-link tap has no additional recipients here.
  const usage = createUsageBroadcaster({ ...dailySpend, ...dailyModel, ...dailySession, ...pricing,
    getDbClient, getCurrentDbClientUserId, createLogger,
    isDataOwnerBroadcastScopeCurrent: conversations.broadcastTap.isDataOwnerBroadcastScopeCurrent,
    broadcastLocal: (channel, payload) => { options.assertCurrent(); options.emit(channel, payload); },
    tapWindowBroadcast() {},
  });
  const mediaBilling=createGatewayMediaBilling({...base,...cost,...spend,...usage,...dailySpend,...conversations.persistence,...conversations.broadcastTap,...createMediaTurnCost({...conversations.money,...conversations.messages}),getCurrentDbClientUserId,logger:options.logger,broadcastSchedulerChanged:id=>options.emit('maker:schedule:event',{type:'changed',scheduleId:id})});
  const accounts = createTerminalAccountUsage({ ...options, pricing, usage });
  return { ...mediaBilling, ...base, ...cost, ...spend, ...usage, ...usageKeys, ...accounts, accounts,
    ...createModelMismatchBroadcaster({ ...conversations.messages, ...conversations.persistence, createLogger, ...transport }),
    ...createTurnCostCalculator(base), getModelPriceQuote, pricing, dailySpend, dailyModel, dailySession };
}
export type TerminalUsage = Awaited<ReturnType<typeof openTerminalUsage>>;
