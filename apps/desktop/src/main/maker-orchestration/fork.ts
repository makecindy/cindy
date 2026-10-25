import {createSessionFork} from '@cindy/app-runtime/sessionFork';
import {remoteBackgroundInvoke} from '../device-link/index.js';
import {getDbClient} from '../localDb/client/current';
import {sessionToCamel} from '../localDb/mapper';
import {commitContextRebuild,createMessage} from '../localDb/ipc/messages.js';
import {getMaker} from '../maker-host/index.js';
import {inferProviderIdForModel} from '../maker-host/provider-route.js';
export type {ForkErrorCode,CodexNativeBoundaryRow} from '@cindy/app-runtime/sessionFork';
export const {listSideChats,createSideChat,resolveCodexTurnAnchor,resolveCodexForkEventTimestamp,isCodexNativeThreadStart,forkSessionAtMessage,forkSessionStripEncrypted}=createSessionFork({getDbClient,sessionToCamel,commitContextRebuild,createMessage,inferProviderIdForModel,remoteBackgroundInvoke,
forkSdkSession:(_source,kind,options)=>getMaker().forkSdkSession(kind,options)});
