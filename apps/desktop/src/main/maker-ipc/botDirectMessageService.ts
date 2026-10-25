import { createBotDirectMessageRuntime } from '@cindy/app-runtime/botDirectMessageService';
import { getDbClient } from '../localDb/client/current.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { isCompanionShadowed } from '../companion-cloud/homes.js';
import { withBotProfileLocks } from './botProfileLock.js';
import { authorizeGroupTool, GroupToolAuthorizationError } from './botGroupToolAuthorization.js';
import { readForwardedRequestSource, matchesForwardedRequest } from '../../shared/forwardedRequest.js';
import { t } from '../i18n.js';
export type { BotDirectMessageResult, BotMessageTransport, BotDirectMessageServiceDeps, BotDirectMessageService } from '@cindy/app-runtime/botDirectMessageService';
export const { createBotDirectMessageService } = createBotDirectMessageRuntime({
  getDbClient, createMessage, isCompanionShadowed, withBotProfileLocks, authorizeGroupTool,
  readForwardedRequestSource, matchesForwardedRequest, t,
  groupAuthorizationError: () => new GroupToolAuthorizationError(),
});
