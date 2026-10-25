import { createSessionControlService as createService, rebuildSessionQueueItem as rebuildItem, type SessionControlServiceDeps } from '@cindy/app-runtime/sessionControlService';
import type { AgentInputQueuedMessage } from '@cindy/maker-shared/agent-input-queue';
import { formatForwardedRequest } from './forwardedRequest.js';
export type * from '@cindy/app-runtime/sessionControlService';
export { authorizeSessionQueueItem, authorizeSessionQueueReorder, sessionQueueOriginForDispatcher } from '@cindy/app-runtime/sessionControlService';
export function createSessionControlService(deps:SessionControlServiceDeps) { return createService({...deps,formatForwardedRequest}); }
export function rebuildSessionQueueItem(item:AgentInputQueuedMessage,message:string) { return rebuildItem(item,message,formatForwardedRequest); }
