import {ipcMain,BrowserWindow} from 'electron';
import {createGoalIpc} from '@cindy/app-runtime/goal/ipc';
import {createLogger} from '../logger.js';
import {getGoalController} from '../goal-host/index.js';
import {tapWindowBroadcast} from '../device-link/broadcast-tap.js';
const runtime=createGoalIpc({ipc:ipcMain,createLogger,getGoalController:()=>getGoalController(),tapWindowBroadcast:(...args)=>tapWindowBroadcast(...args),broadcastLocal(channel,payload){
 for(const win of BrowserWindow.getAllWindows()){if(win.isDestroyed())continue;try{win.webContents.send(channel,payload);}catch(e){createLogger('maker-ipc:goal').warn(`broadcast goal status failed: ${String(e)}`);}}
}});
export const {broadcastGoalStatus,registerGoalHandlers}=runtime;
