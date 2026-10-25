import { registerRoutineRemoteResources as registerShared } from '@cindy/companion-core/routineResources';
import { getBotRoutineRemoteResource, invokeBotRoutineRemoteAction } from './companionResource.js';
import type { createBotRemoteSettingsResource } from '../localDb/ipc/botRemoteSettingsResource.js';
import { remoteResourceRegistry } from '../device-link/remoteResourceRegistry.js';
import { listBotRemoteResourceSources } from '../localDb/ipc/bots.js';
import { getRoutineEngine, routineTools } from './service.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
let registered = false;
export function registerRoutineRemoteResources(management?: ReturnType<typeof createBotRemoteSettingsResource>): void {
  if (registered) return;
  registered = true;
  registerShared({registry:remoteResourceRegistry,tools:routineTools,getEngine:getRoutineEngine,
    listBots:listBotRemoteResourceSources,scope:activeOwnerScopeKey,boundaryPending:isAppSessionBoundaryPending,
    management,getCompanionResource:getBotRoutineRemoteResource,invokeCompanionAction:invokeBotRoutineRemoteAction});
}
