import { BrowserWindow } from 'electron';
import { createBotRemoteResourceInvalidation } from '@cindy/app-runtime/botRemoteResourceInvalidation';
import { getSafeDataOwnerPushStamp, tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import { createLogger } from '../logger.js';
import { getDbClient } from '../localDb/client/current.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { readTaskResponsibilities } from './botTaskResponsibility.js';
const log=createLogger('maker-ipc:bot-remote-resource');
export const { onBotRemoteResourceChanged, broadcastBotRemoteResourceChanged, scheduleBotRemoteResourceChangedForSession, scheduleBotRemoteResourceChangedForDelegation, scheduleBotRemoteResourceChangedForFollowedSession } = createBotRemoteResourceInvalidation({
  getDbClient,activeOwnerScopeKey,isAppSessionBoundaryPending,getSafeDataOwnerPushStamp,tapWindowBroadcast,log,
  ownerScopedUserDataPath,readTaskResponsibilities,
  broadcastLocal(channel,payload){
    for(const win of BrowserWindow.getAllWindows()){
      if(win.isDestroyed())continue;
      try{win.webContents.send(channel,payload);}
      catch(error){log.warn('remote teammate window invalidation failed',{error:String(error)});}
    }
  },
});
