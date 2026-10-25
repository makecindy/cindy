import { readForwardedRequestSource } from '../../../shared/forwardedRequest.js';
import { createHash } from 'node:crypto';
import { botTodoRemoteProjection } from './botTodoRemoteProjection.js';
import { todoAccess } from '../../maker-ipc/botTodoAccess.js';
import { queryTodoItems, type TodoListQuery, type TodoPatch } from '@cindy/maker-shared/teammate-todo';
import { and, desc, inArray, isNull } from 'drizzle-orm';
import { getDbClient } from '../client/current.js';
import { botSessionLinks } from '../schema.js';
import type { BotRemoteResourceSource } from './bots.js';
import { getAgentIslandService } from '../../agent-island/service.js';
import { scheduleBotRemoteResourceChangedForSession } from '../../maker-ipc/botRemoteResourceInvalidation.js';
import { getWorkingStatusCopy } from '../../maker-ipc/workingStatus.js';
import { WORKING_PHASES } from '../../../shared/workingStatus.js';
import { resolveSystemLocale } from '../../../shared/locale.js';
import type { botRemoteManagement } from './botRemoteManagement.js';
import { editorCopy } from './botRemoteEditors.js';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../../device-link/broadcast-tap.js';
import {
  getBotRemoteResourceSource,
  listBotRemoteResourceSources,
} from './bots.js';
import { RemoteResourceRegistryError, remoteResourceRegistry } from '../../device-link/remoteResourceRegistry.js';
import { routineTools } from '../../routines/service.js';
import { broadcastBotRemoteResourceChanged } from '../../maker-ipc/botRemoteResourceInvalidation.js';
import { getBotRemoteMessageService } from '../../maker-ipc/botRemoteMessageReceiver.js';
import {
  BOT_REMOTE_RESOURCE_KIND,
  TEAMMATES_REMOTE_COLLECTION_ID,
  TEAMMATES_TITLE,
  botRemoteCollectionItemFromSource,
  botRemoteResourceFromSource,
  visibleBotRemoteResourceSources,
} from './botRemoteResourceProjection.js';

import {createBotRemoteResourceProvider} from '@cindy/app-runtime/botRemoteResourceProvider';
export const {registerBotRemoteResourceProvider}=createBotRemoteResourceProvider({getDbClient:(...args)=>getDbClient(...args),getAgentIslandService:(...args)=>getAgentIslandService(...args),scheduleBotRemoteResourceChangedForSession:(...args)=>scheduleBotRemoteResourceChangedForSession(...args),getWorkingStatusCopy:(...args)=>getWorkingStatusCopy(...args),captureDataOwnerBroadcastScope:(...args)=>captureDataOwnerBroadcastScope(...args),isDataOwnerBroadcastScopeCurrent:(...args)=>isDataOwnerBroadcastScopeCurrent(...args),getBotRemoteResourceSource:(...args)=>getBotRemoteResourceSource(...args),listBotRemoteResourceSources:(...args)=>listBotRemoteResourceSources(...args),broadcastBotRemoteResourceChanged:(...args)=>broadcastBotRemoteResourceChanged(...args),getBotRemoteMessageService:(...args)=>getBotRemoteMessageService(...args),todoAccess:(...args)=>todoAccess(...args),remoteResourceRegistry,routineTools:{todoCheckEnabled:(...args)=>routineTools.todoCheckEnabled(...args),setTodoCheck:(...args)=>routineTools.setTodoCheck(...args)}});
