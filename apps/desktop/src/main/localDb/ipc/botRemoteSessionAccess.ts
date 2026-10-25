import {getDbClient} from '../client/current.js';
import {captureDataOwnerBroadcastScope,isDataOwnerBroadcastScopeCurrent} from '../../device-link/broadcast-tap.js';
import {createBotRemoteSessionAccess} from '@cindy/app-runtime/botRemoteSessionAccess';
export const {readRemoteBotSessionAccessBatch,readRemoteBotSessionAccess}=createBotRemoteSessionAccess({getDbClient:()=>getDbClient(),captureDataOwnerBroadcastScope:()=>captureDataOwnerBroadcastScope(),isDataOwnerBroadcastScopeCurrent:(...args)=>isDataOwnerBroadcastScopeCurrent(...args)});
