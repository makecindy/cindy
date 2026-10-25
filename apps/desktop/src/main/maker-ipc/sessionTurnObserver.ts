import { publishChannelTurn, publishProviderInitiatedTurn } from './channelTurnSignal';
import { ensureManagedOllamaReadyForSession } from '../local-model-runtime/preflight.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { getSessionProvider } from '../maker-host/session-provider-store.js';
import { verdictForModelRoute } from '../maker-host/model-route-guard-live.js';

import {createSessionTurnObserver} from '@cindy/app-runtime/sessionTurnObserver';
export type * from '@cindy/app-runtime/sessionTurnObserver';
export const {installSessionTurnObserver}=createSessionTurnObserver({
 publishChannelTurn,publishProviderInitiatedTurn,ensureManagedOllamaReadyForSession,throwIpcError,getSessionProvider,verdictForModelRoute,
});
