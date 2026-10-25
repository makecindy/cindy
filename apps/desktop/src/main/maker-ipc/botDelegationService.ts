import {createBotDelegationRuntime} from '@cindy/app-runtime/botDelegationService';
export {discardDelegationQueuedInputs} from '@cindy/app-runtime/botDelegationService';
export type * from '@cindy/app-runtime/botDelegationService';
import {app} from 'electron';
import {getDbClient} from '../localDb/client/current.js';
import {createLogger} from '../logger.js';
import {t} from '../i18n.js';
import {signalBotAutonomyBotsChanged} from '../bot-autonomy/botsChangedSignal.js';
import {ownerScopedUserDataPath} from '../appSessionState.js';
import {formatForwardedRequest,captureAgentRequest} from './forwardedRequest.js';
import {authorizeGroupTool} from './botGroupToolAuthorization.js';
import {openSession} from '../localDb/sessionOpening.js';
import {setWorktreePathInDb} from '../localDb/ipc/sessions.js';
import {createMessage} from '../localDb/ipc/messages.js';
import {sessionCreateToRow} from '../localDb/mapper.js';
import {createBotCanonicalSession} from '../localDb/ipc/bots.js';
import {resolveBotCanonicalSession} from './botCanonicalSessionRegistry.js';
import {registerBotDelegationParentCancellation} from './botDelegationLifecycle.js';
import {validateTaskModel,resolveTaskModelSelection} from './appDefaultModelControl.js';
export const {createBotDelegationService,hasExplicitSessionTaskModel}=createBotDelegationRuntime({
 getDbClient:()=>getDbClient(),logger:createLogger('bot-delegation'),t:key=>t(key),signalBotAutonomyBotsChanged,
 ownerScopedUserDataPath,legacyUserDataPath:()=>app.getPath('userData'),authorizeGroupTool,
 formatForwardedRequest,captureAgentRequest,
 openSession:(...args)=>openSession(...args),setWorktreePathInDb:(...args)=>setWorktreePathInDb(...args),
 createMessage:(...args)=>createMessage(...args),sessionCreateToRow:(...args)=>sessionCreateToRow(...args),
 createBotCanonicalSession:(...args)=>createBotCanonicalSession(...args),resolveBotCanonicalSession:(...args)=>resolveBotCanonicalSession(...args),
 registerBotDelegationParentCancellation,validateTaskModel:(...args)=>validateTaskModel(...args),resolveTaskModelSelection:(...args)=>resolveTaskModelSelection(...args),
});
