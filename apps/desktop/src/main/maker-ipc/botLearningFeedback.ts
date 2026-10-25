import { createLogger } from '../logger.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getDbClient } from '../localDb/client/current.js';
import {
  broadcastMessageAgentMetaUpdate,
  patchMessageAgentMetaWithResult,
} from '../localDb/ipc/messages.js';
import { enqueueDurableWrite } from '../messagePersistBroadcaster.js';
import { botLearningTracker } from './botLearningTracker.js';
import {createBotLearningFeedback} from '@cindy/app-runtime/botLearningFeedback';
export type * from '@cindy/app-runtime/botLearningFeedback';
export const {learningTurnIdentity,learningReceiptPublisher,observeBotLearningTurn}=createBotLearningFeedback({
createLogger: (...args) => createLogger(...args),
activeOwnerScopeKey: (...args) => activeOwnerScopeKey(...args),
isAppSessionBoundaryPending: (...args) => isAppSessionBoundaryPending(...args),
getDbClient: (...args) => getDbClient(...args),
broadcastMessageAgentMetaUpdate: (...args) => broadcastMessageAgentMetaUpdate(...args),
patchMessageAgentMetaWithResult: (...args) => patchMessageAgentMetaWithResult(...args),
enqueueDurableWrite: (...args) => enqueueDurableWrite(...args),
get botLearningTracker() { return botLearningTracker; }
});
