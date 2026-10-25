import {registerBotLifecycleActionHandler} from '@cindy/app-runtime/botLifecycleHandlers';
import {createBotLifecycleRuntime,type BotLifecycleServiceDeps} from '@cindy/app-runtime/botLifecycleService';
import { randomUUID } from 'node:crypto';

import { app, BrowserWindow, ipcMain } from 'electron';
import { eq } from 'drizzle-orm';
import type { Maker } from '@cindy/maker-core';

import type {
  BotLifecycleActionRequest,
  BotLifecycleActionResult,
} from '../../shared/botLifecycle.js';
import { getDbClient } from '../localDb/client/current.js';
import { deleteBotProfileAndDetachSessionsInDb } from '../localDb/ipc/sessions.js';
import {
  botLifecycleEvents,
  botProfiles,
  botSessionLinks,
} from '../localDb/schema.js';
import { removeBotProfileFolder } from './botProfileFolder.js';
import { withBotProfileLocks } from './botProfileLock.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { BotDelegationService } from './botDelegationService.js';
import { resolveBotCanonicalSession } from './botCanonicalSessionRegistry.js';
import { broadcastBotRemoteResourceChanged } from './botRemoteResourceInvalidation.js';
import { signalBotAutonomyBotsChanged } from '../bot-autonomy/botsChangedSignal.js';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';

const log = createLogger('maker-ipc:bot-lifecycle');

function broadcastBotLifecycleChanged(payload: {
  botId: string;
  action: BotLifecycleActionRequest['action'];
}): void {
  // 伙伴自主跟进：暂停 / 恢复 / 归档后立即重算跟进者。
  signalBotAutonomyBotsChanged();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(MAKER_PUSH.BOT_LIFECYCLE_CHANGED, payload);
    } catch (error) {
      log.warn('Bot lifecycle broadcast failed', { error: String(error) });
    }
  }
}

export type {BotLifecycleServiceDeps} from '@cindy/app-runtime/botLifecycleService';
export const {createBotLifecycleService}=createBotLifecycleRuntime({withBotProfileLocks,getDbClient,activeOwnerScopeKey,isAppSessionBoundaryPending,ownerScopedUserDataPath,legacyUserDataPath:()=>app.getPath('userData'),logger:log,deleteBotProfileAndDetachSessionsInDb,resolveBotCanonicalSession,broadcastBotRemoteResourceChanged,broadcastBotLifecycleChanged});

let registeredLifecycleService: ReturnType<typeof createBotLifecycleService> | null = null;
/** Remote settings use the same coordinator and preserve task history/worktrees. */
export function runRegisteredBotLifecycleAction(request: BotLifecycleActionRequest, beforeRun: () => Promise<void>) {
  if (!registeredLifecycleService) throwIpcError('PRECONDITION_FAILED', 'Lifecycle unavailable');
  return registeredLifecycleService.run(request, beforeRun);
}

export function registerBotLifecycleHandlers(deps: BotLifecycleServiceDeps): void {
  const service = createBotLifecycleService(deps);
  registeredLifecycleService = service;
  registerBotLifecycleActionHandler({ipcMain,assertTrustedAppRendererEvent,service});
}
