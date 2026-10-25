import {createChatHistoryEmbedder} from '@cindy/app-runtime/chatHistoryEmbedder';
export type * from '@cindy/app-runtime/chatHistoryEmbedder';
export const {CHAT_EMBED_MODEL_ID, CHAT_VEC_TABLE, CHAT_EMBED_DIM, setupChatHistoryEmbedder, setChatEmbeddingEnabled, isChatEmbeddingEnabled, onMessageCreated, resetCacheForNewDb} = createChatHistoryEmbedder();
