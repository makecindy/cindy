import {activeOwnerScopeKey,isAppSessionBoundaryPending,ownerScopedUserDataPath} from '../appSessionState.js';
import {getDbClient} from '../localDb/client/current.js';
import {createLogger} from '../logger.js';
import {subscribeNewMakerDefaults} from '../maker-host/newMakerDefaultsCache.js';
import {prepareBotInvitationAvatar,finishBotInvitationAvatar} from './botInvitationAvatar.js';
import {requestAuxiliaryText} from '../maker-host/auxiliary-title-one-shot.js';
import {createMessage} from '../localDb/ipc/messages.js';
import {captureDataOwnerBroadcastScope} from '../device-link/broadcast-tap.js';
import {createBotInvitationService} from '@cindy/app-runtime/botInvitation';
export type {BotInvitationCallbacks,WelcomeDispatch} from '@cindy/app-runtime/botInvitation';
export const {setBotInvitationWelcomeDispatch,queueBotInvitation,parseOpeningReply}=createBotInvitationService({
  activeOwnerScopeKey,isAppSessionBoundaryPending,ownerScopedUserDataPath,getDbClient,
  logger:createLogger('botInvitation'),subscribeNewMakerDefaults,prepareBotInvitationAvatar,finishBotInvitationAvatar,
  requestAuxiliaryText,createMessage,captureDataOwnerBroadcastScope,
});
