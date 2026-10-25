import {createAgentHandoffRuntime} from '@cindy/app-runtime/agentHandoffRuntime';
import {findForkParentSessionId,findPendingAgentHandoffSnapshot,findPendingForkOrigin,markLatestAgentHandoffConsumed} from '../localDb/ipc/messages.js';
import {createLogger} from '../logger.js';
export const {agentHandoffPending}=createAgentHandoffRuntime({
 findForkParentSessionId:(...args)=>findForkParentSessionId(...args),findPendingAgentHandoffSnapshot:(...args)=>findPendingAgentHandoffSnapshot(...args),
 findPendingForkOrigin:(...args)=>findPendingForkOrigin(...args),markLatestAgentHandoffConsumed:(...args)=>markLatestAgentHandoffConsumed(...args),createLogger,
});
