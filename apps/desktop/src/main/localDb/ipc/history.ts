import {ipcMain} from 'electron';
import {eq} from 'drizzle-orm';
import {DL_HISTORY_MESSAGES_CHANNEL} from '@cindy/device-link';
import {createRemoteHistoryMessagesHandler,type RemoteHistoryIpcDeps} from '@cindy/app-runtime/remoteHistoryMessages';
import {getDbClient} from '../client/current';
import {sessions} from '../schema';
import {getMessagesForHistory} from '../chatHistoryReader';
import {readLatestSessionTerminal} from '../sessionTerminal';
export * from '@cindy/app-runtime/remoteHistoryMessages';
const defaultDeps:RemoteHistoryIpcDeps={
 sessionExists:async sessionId=>(await getDbClient().drizzle.select({id:sessions.id}).from(sessions).where(eq(sessions.id,sessionId)).limit(1)).length>0,
 getMessages:(...args)=>getMessagesForHistory(...args),readTerminal:(...args)=>readLatestSessionTerminal(...args),
};
export function registerRemoteHistoryIpc(deps:RemoteHistoryIpcDeps=defaultDeps):void {
 const handle=createRemoteHistoryMessagesHandler(deps);
 ipcMain.handle(DL_HISTORY_MESSAGES_CHANNEL,async(_event,value:unknown)=>handle(value));
}
