import {activeOwnerScopeKey, isAppSessionBoundaryPending} from '../../appSessionState.js';
import {desktopMakerLogger} from '../../maker-host/logger-adapter.js';
import {ownerScopedImUserDataPath} from '../ownerScopedStorage.js';
import {createBotImConnectionStore} from '@cindy/app-runtime/botImConnectionStore';
export {isBotImChannel,isBotImConnectionId,secretKeyPrefixFor} from '@cindy/app-runtime/botImConnectionStore';
export type {BotImTaskArchiveCleanup} from '@cindy/app-runtime/botImConnectionStore';
export const {listBotImConnections,readBotImConnection,listBotImConnectionsForBot,addBotImConnectionRecord,updateBotImConnectionRecord,archiveBotImTaskRow,setBotImConnectionGroupActivation,removeBotImConnectionRecord}=createBotImConnectionStore({filePath:()=>ownerScopedImUserDataPath('bot-im-connections.json'),scopeKey:activeOwnerScopeKey,isAppSessionBoundaryPending,log:desktopMakerLogger.child('bot-im-connection-store')});
