import {createRecentWorkdirs} from '@cindy/app-runtime/recentWorkdirs';
import {getDbClient} from '../client/current';
import {createLogger} from '../../logger';
import {ipcMain,BrowserWindow} from 'electron';
export const {normalizeRecentWorkdirPath, upsertRecentWorkdir, listRecentWorkdirs, registerRecentWorkdirsIpc, removeRecentWorkdir}=createRecentWorkdirs({getDbClient:()=>getDbClient(),logger:createLogger('recentWorkdirs'),ipc:{handle:(channel,handler)=>ipcMain.handle(channel,handler)},broadcastLocal(channel,payload,...stamp){for(const w of BrowserWindow.getAllWindows()){if(!w.isDestroyed())w.webContents.send(channel,payload,...stamp);}}});
