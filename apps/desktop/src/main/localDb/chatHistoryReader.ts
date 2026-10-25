import {createChatHistoryReader} from '@cindy/app-runtime/chatHistoryReader';
import {getDbClient} from './client/current';
import {messageToCamel} from './mapper';
import * as workingDirs from './workingDirHistoryFilter';
export type * from '@cindy/app-runtime/chatHistoryReader';
export const {listWorkdirsForHistory,listSessionsForHistory,getMessagesForHistory}=createChatHistoryReader({getDbClient:()=>getDbClient(),messageToCamel:(...args)=>messageToCamel(...args),...workingDirs});
