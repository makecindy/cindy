import { createImBotBindingRuntime } from '@cindy/app-runtime/imBotBindingRuntime';
import { getDbClient } from '../../localDb/client/current';
import { archiveBotChannelLanes, ensureBotChannelLaneSession, findBotChannelLaneSession } from '../../localDb/ipc/bots';
import { resolveBotCanonicalSession } from '../../maker-ipc/botCanonicalSessionRegistry';
import { prepareBotSessionForImSend, tryGetBotDelegationService } from '../../maker-ipc/register';
export const {createImCompanionRouteDeps}=createImBotBindingRuntime({getDbClient,archiveBotChannelLanes,ensureBotChannelLaneSession,
  findBotChannelLaneSession,resolveBotCanonicalSession,prepareBotSessionForImSend,tryGetBotDelegationService});
