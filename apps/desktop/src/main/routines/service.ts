import { REMOTE_RESOURCE_CHANGED_CHANNEL } from '@cindy/device-link';
import { tapWindowBroadcast, getSafeDataOwnerPushStamp } from '../device-link/broadcast-tap.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow, ipcMain } from 'electron';
import {
  RoutineEngine,
  rewriteRoutinePluginSource,
  type Routine,
  type RoutineRun,
  type RoutineInput,
  type Schedule,
  type ScheduleStorage,
  type Scheduler,
} from '@cindy/maker-scheduler';
import {
  activeOwnerScopeKey,
  getActiveAppSession,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { createLogger } from '../logger.js';
import { RoutineFileStore } from './store.js';
import { assertPreRunHookCommandSyntax } from '../scheduler-host/pre-run-hook.js';
import { buildRoutineSchedule, createCompanionRoutineTransfer } from '@cindy/companion-core/routines';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { botProfiles } from '../localDb/schema.js';
import { isCompanionShadowed } from '../companion-cloud/homes.js';
import { currentFollowUpEvents } from '../bot-autonomy/hub.js';
import { BUILTIN_FOLLOW_UP_ROUTINE_PREFIX, BUILTIN_TODO_CHECK_ROUTINE_PREFIX } from '../../shared/botAutonomy.js';
import { TODO_CHECK_PROMPT_VERSION, buildTodoCheckRoutineInput, builtinTodoCheckRoutineId } from '../bot-autonomy/todoCheckRoutine.js';

import {createRoutineService} from '@cindy/app-runtime/routineService';
export type {RoutineHostDeps,RoutineEngineLifecycleListener,CompanionRoutineValue} from '@cindy/app-runtime/routineService';
export const {onRoutineEngineLifecycle,configureRoutineHost,getRoutineEngine,stopRoutines,updateBotRoutineLifecycle,registerRoutinesIpc,routineTools,disconnectRoutineSource,relocateRoutinePluginSource,listCompanionRoutines,importCompanionRoutines}=createRoutineService({createStore:directory=>new RoutineFileStore(directory),activeOwnerScopeKey:(...args)=>activeOwnerScopeKey(...args),getActiveAppSession:(...args)=>getActiveAppSession(...args),isAppSessionBoundaryPending:(...args)=>isAppSessionBoundaryPending(...args),ownerScopedUserDataPath:(...args)=>ownerScopedUserDataPath(...args),assertTrustedAppRendererEvent:(...args)=>assertTrustedAppRendererEvent(...args),getCurrentDbClientSnapshot:(...args)=>getCurrentDbClientSnapshot(...args),isCompanionShadowed:(...args)=>isCompanionShadowed(...args),currentFollowUpEvents:(...args)=>currentFollowUpEvents(...args),tapWindowBroadcast:(...args)=>tapWindowBroadcast(...args),getSafeDataOwnerPushStamp:(...args)=>getSafeDataOwnerPushStamp(...args),isPackaged:()=>app.isPackaged,broadcastLocal:channel=>{for(const window of BrowserWindow.getAllWindows())if(!window.isDestroyed())window.webContents.send(channel);},ipcMain,log:createLogger('routines')});
