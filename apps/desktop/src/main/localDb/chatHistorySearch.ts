import {createChatHistorySearch} from '@cindy/app-runtime/chatHistorySearch';
import {getDbClient} from './client/current';
import {messageToCamel} from './mapper';
import {resolveStoredWorkingDirCandidates} from './workingDirHistoryFilter';
import {getEmbeddingService} from '../embedding-host';
import {createLogger} from '../logger';
import {CHAT_EMBED_MODEL_ID,CHAT_VEC_TABLE,isChatEmbeddingEnabled} from '../embedders/chat-history-embedder';
export type * from '@cindy/app-runtime/chatHistorySearch';
export const {searchChatHistoryHybrid}=createChatHistorySearch({getDbClient:()=>getDbClient(),messageToCamel:(...args)=>messageToCamel(...args),resolveStoredWorkingDirCandidates:(...args)=>resolveStoredWorkingDirCandidates(...args),getEmbeddingService:()=>getEmbeddingService(),createLogger,CHAT_EMBED_MODEL_ID,CHAT_VEC_TABLE,isChatEmbeddingEnabled:()=>isChatEmbeddingEnabled()});
