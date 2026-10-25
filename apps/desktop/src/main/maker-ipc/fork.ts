import {ipcMain} from 'electron';
import {createLogger} from '../logger.js';
import {createSideChat,listSideChats,forkSessionAtMessage,forkSessionStripEncrypted} from '../maker-orchestration/fork.js';
import {emitSessionCreated} from '../localDb/ipc/sessionCreatedBroadcast.js';
import {assertTrustedAppRendererEvent} from '../security/trustedAppRenderer.js';
import {getDeviceLinkInvokeContext} from '../device-link/invoke-context.js';
import {createSessionForkIpc} from '@cindy/app-runtime/sessionForkIpc';
export const {registerMakerForkIpc}=createSessionForkIpc<Electron.IpcMainInvokeEvent>({ipcMain,logger:createLogger('maker-ipc/fork'),createSideChat,listSideChats,forkSessionAtMessage,forkSessionStripEncrypted,emitSessionCreated,assertTrustedAppRendererEvent,getDeviceLinkInvokeContext});
