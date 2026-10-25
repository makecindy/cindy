/**
 * 伙伴自主跟进的 IPC：工作台「一眼」（本机渲染层与已授权的远程控制端可读）与
 * 「自动跟进所有任务」设置（只限本机渲染层读写，不开放给远程）。
 */
import { eq } from 'drizzle-orm';
import { ipcMain } from 'electron';

import { BOT_AUTONOMY_IPC } from '../../shared/botAutonomy.js';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { getDbClient } from '../localDb/client/current.js';
import { isBotVisibleRemotely } from '../localDb/ipc/botRemoteVisibility.js';
import { botProfiles } from '../localDb/schema.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import {
  getBotAutonomyGlance,
  getBotAutonomySettingsView,
  resetBotAutonomySchedulerSettings,
  setBotAutonomySchedulerBotId,
} from './hub.js';

import {createBotAutonomyIpc} from '@cindy/app-runtime/botAutonomyIpc';
export const {registerBotAutonomyIpc}=createBotAutonomyIpc({ipcMain,isDeviceLinkInvoke:(...args)=>isDeviceLinkInvoke(...args),getDbClient:(...args)=>getDbClient(...args),assertTrustedAppRendererEvent:(...args)=>assertTrustedAppRendererEvent(...args),getBotAutonomyGlance:(...args)=>getBotAutonomyGlance(...args),getBotAutonomySettingsView:(...args)=>getBotAutonomySettingsView(...args),resetBotAutonomySchedulerSettings:(...args)=>resetBotAutonomySchedulerSettings(...args),setBotAutonomySchedulerBotId:(...args)=>setBotAutonomySchedulerBotId(...args)});
