import { createBotImLaneRuntime } from '@cindy/app-runtime/botImLaneRuntime';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../appSessionState.js';
import { getDbClient } from '../../localDb/client/current';
import { createLogger } from '../../logger';
import { readBotImConnection } from './botImConnectionStore';
import * as connectionStore from './botImConnectionStore';
export type { BotImLaneRuntimeDeps, BotImLaneLink, BotImLaneActivity, BotImLaneStore, BotImLaneListOptions } from '@cindy/app-runtime/botImLaneRuntime';
export const { configureBotImLaneRuntime, parseLaneRouteKey, listBotImConnectionLanes, resetBotImConnectionLane, archiveBotImConnectionLane, __testing }=createBotImLaneRuntime({
  getDbClient,
  readBotImConnection,
  listBotImConnections: connectionStore.listBotImConnections,
  // Resolve through the module namespace at call time so the desktop IPC path and
  // tests observe the same store implementation (including injected failures).
  archiveBotImTaskRow: (...args) => connectionStore.archiveBotImTaskRow(...args),
  scopeKey: activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  log:createLogger('im:bot-lanes'),
});
