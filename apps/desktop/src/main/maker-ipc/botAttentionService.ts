import { createBotAttentionService } from '@cindy/app-runtime/botAttentionService';
import { getDbClient } from '../localDb/client/current.js';
import { broadcastBotRemoteResourceChanged } from './botRemoteResourceInvalidation.js';
export type { BotAttentionWriteResult } from '@cindy/app-runtime/botAttentionService';
export const { noteBotAttention, clearBotAttention } = createBotAttentionService(getDbClient, broadcastBotRemoteResourceChanged);
