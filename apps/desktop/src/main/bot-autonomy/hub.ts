/**
 * 伙伴自主跟进 · 轻量入口（hub）。
 *
 * 输入协调器（register）、伙伴 IPC（bots.ts）只经这里读写，不直接 import 带设备互联 / 通知 /
 * 灵动岛依赖的 service.ts；运行体由 service.ts 在例行任务引擎启动后挂进来。
 */
import type { BrowserWindow } from 'electron';
import type { RoutineEngine, RoutineRun } from '@cindy/maker-scheduler';

import {
  type BotAutonomySettingsView,
  type BotGlance,
  type BotAutonomyExecution,
} from '../../shared/botAutonomy.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import {
  readBotAutonomySettingsOverride,
  resetBotAutonomySettings,
  writeBotAutonomySchedulerBotId,
} from '../maker-host/bot-autonomy-settings-store.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { filterFollowUpEvents, resolveSchedulerBotId, type FollowUpSubject } from './follower.js';
import { readBotDirectory, readLocalSessionMetas, readTaskOwnership } from './hostData.js';
import type { BotAutonomyRuntime, GlanceOptions } from './runtime.js';
import { errorCode, type BotAutonomyInputProjection } from './taskWatch.js';

import {createBotAutonomyHub,type BotAutonomyHostDeps as SharedHostDeps} from '@cindy/app-runtime/botAutonomyHub';
export type BotAutonomyHostDeps=SharedHostDeps<BrowserWindow>;
export const {configureBotAutonomyHost,getBotAutonomyHostDeps,getActiveBotAutonomy,setActiveBotAutonomy,scopeIsCurrent,noteBotAutonomyInputProjection,getBotAutonomyGlance,getBotAutonomySettingsView,setBotAutonomySchedulerBotId,resetBotAutonomySchedulerSettings,currentFollowUpEvents}=createBotAutonomyHub<BrowserWindow>({activeOwnerScopeKey:(...args)=>activeOwnerScopeKey(...args),isAppSessionBoundaryPending:(...args)=>isAppSessionBoundaryPending(...args),ownerScopedUserDataPath:(...args)=>ownerScopedUserDataPath(...args),readBotAutonomySettingsOverride:(...args)=>readBotAutonomySettingsOverride(...args),resetBotAutonomySettings:(...args)=>resetBotAutonomySettings(...args),writeBotAutonomySchedulerBotId:(...args)=>writeBotAutonomySchedulerBotId(...args),readBotDirectory:(...args)=>readBotDirectory(...args),readLocalSessionMetas:(...args)=>readLocalSessionMetas(...args),readTaskOwnership:(...args)=>readTaskOwnership(...args),log:createLogger('bot-autonomy')});
