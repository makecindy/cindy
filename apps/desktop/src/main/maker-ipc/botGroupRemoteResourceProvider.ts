import { getDbClient } from '../localDb/client/current.js';
import { remoteResourceRegistry } from '../device-link/remoteResourceRegistry.js';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../device-link/broadcast-tap.js';
import { createBotGroupRemoteResources } from '@cindy/app-runtime/botGroupRemoteResourceProvider';
export * from '@cindy/app-runtime/botGroupRemoteResourceProvider';
export const { botGroupMembersVisibleRemotely, registerBotGroupRemoteResourceProvider } = createBotGroupRemoteResources({getDbClient,remoteResourceRegistry,captureDataOwnerBroadcastScope,isDataOwnerBroadcastScopeCurrent});
