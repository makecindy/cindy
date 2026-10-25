import { BrowserWindow } from 'electron';

import type { ModelMismatchInfo } from '../shared/modelMismatch.js';
import { patchMessageAgentMeta } from './localDb/ipc/messages.js';
import { enqueueDurableWrite } from './messagePersistBroadcaster.js';
import { createLogger } from './logger.js';
import * as broadcastTap from './device-link/broadcast-tap.js';

import {createModelMismatchBroadcaster} from '@cindy/app-runtime/modelMismatchBroadcaster';
export const {MESSAGE_MODEL_MISMATCH_CHANGED,recordModelMismatchOnMessage}=createModelMismatchBroadcaster({patchMessageAgentMeta:(...args)=>patchMessageAgentMeta(...args),enqueueDurableWrite:(...args)=>enqueueDurableWrite(...args),createLogger,broadcastTap,broadcastLocal(channel,payload,...stamp){for(const win of BrowserWindow.getAllWindows())if(!win.isDestroyed())win.webContents.send(channel,payload,...stamp);}});
export type {MessageModelMismatchPayload,ModelMismatchDeps} from '@cindy/app-runtime/modelMismatchBroadcaster';
