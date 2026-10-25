import {BrowserWindow,ipcMain} from 'electron';
import {getDbClient} from '../client/current.js';
import {createProjectAliases} from '@cindy/app-runtime/projectAliases';
export const {listProjectAliases,upsertProjectAlias,deleteProjectAlias,registerProjectAliasesIpc}=createProjectAliases({getDbClient:()=>getDbClient(),ipcMain,
 broadcastProjectAliasesChanged:()=>{for(const w of BrowserWindow.getAllWindows())if(!w.isDestroyed())w.webContents.send('local-db:project-aliases:changed');},
});
