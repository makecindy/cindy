import {app} from 'electron';
import {createChatEmbeddingSettingsStore} from '@cindy/app-runtime/chatEmbeddingSettingsStore';
import {activeOwnerScopeKey,dataOwnerStorageKey,getActiveAppSession,isAppSessionBoundaryPending,ownerScopedUserDataPath} from '../appSessionState.js';
import {hasExclusiveSharedLegacyUserDataAccess} from '../ownerNamespaceMigration.js';
import {desktopMakerLogger} from './logger-adapter.js';
export type * from '@cindy/app-runtime/chatEmbeddingSettingsStore';
export const {resolveChatEmbeddingDefault,readChatEmbeddingSettings,readChatEmbeddingSettingsState,writeChatEmbeddingEnabled,resetChatEmbeddingSettings,__testing}=createChatEmbeddingSettingsStore({userDataDirectory:()=>app.getPath('userData'),createLogger: name=>desktopMakerLogger.child(name),activeOwnerScopeKey:()=>activeOwnerScopeKey(),dataOwnerStorageKey: id=>dataOwnerStorageKey(id),getActiveAppSession:()=>getActiveAppSession(),isAppSessionBoundaryPending:()=>isAppSessionBoundaryPending(),ownerScopedUserDataPath:(...parts)=>ownerScopedUserDataPath(...parts),hasExclusiveSharedLegacyUserDataAccess:()=>hasExclusiveSharedLegacyUserDataAccess()});
