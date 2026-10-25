import path from 'node:path';
import { eq } from 'drizzle-orm';
import {
  TodoError,
  todoActionText,
  preflightTodoEvents,
  type TodoPatch,
  type TeammateTodo,
} from '@cindy/maker-shared/teammate-todo';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { getDbClient } from '../localDb/client/current.js';
import { saveCancelledInputDelivery } from '../localDb/agentInputQueueSnapshots.js';
import { botProfiles } from '../localDb/schema.js';
import { botProfileDir } from './botProfileFolder.js';
import { broadcastBotWorkbenchChanged, readLegacyWorkbenchJudgments } from './botWorkbenchService.js';
import { broadcastBotRemoteResourceChanged } from './botRemoteResourceInvalidation.js';
import { resolveWorkbenchCaller } from './botWorkbenchTools.js';
import { createBotTodoStore, type TodoIngestInput, type TodoIngestResult } from './botTodoStore.js';

import {createBotTodoAccess} from '@cindy/app-runtime/botTodoAccess';
export type {BotTodoAccess,TodoDispatchResult,TodoDispatchInput} from '@cindy/app-runtime/botTodoAccess';
export const {configureBotTodoDispatch,companionTodoStore,todoAccess,settleBotTodoForSession,todoForCaller}=createBotTodoAccess({activeOwnerScopeKey:(...args)=>activeOwnerScopeKey(...args),isAppSessionBoundaryPending:(...args)=>isAppSessionBoundaryPending(...args),ownerScopedUserDataPath:(...args)=>ownerScopedUserDataPath(...args),getDbClient:(...args)=>getDbClient(...args),readLegacyWorkbenchJudgments:(...args)=>readLegacyWorkbenchJudgments(...args),broadcastBotWorkbenchChanged:(...args)=>broadcastBotWorkbenchChanged(...args),broadcastBotRemoteResourceChanged:(...args)=>broadcastBotRemoteResourceChanged(...args),saveCancelledInputDelivery:(...args)=>saveCancelledInputDelivery(...args),resolveWorkbenchCaller:(...args)=>resolveWorkbenchCaller(...args)});
