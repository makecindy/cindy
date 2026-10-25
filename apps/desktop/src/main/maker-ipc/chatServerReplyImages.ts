import { parseBlobUrl, resolveSafe } from '../cindy-media/blobStore.js';
import { sessionCanRead } from '../cindy-media/ledger.js';
import { materializeTaskImageTextResult } from '../cindy-media/taskImageDelivery.js';
import { getDbClient } from '../localDb/client/current.js';
import { createChatReplyImages } from '@cindy/app-runtime/chatServerReplyImages';
export const { prepareChatReplyImages } = createChatReplyImages({parseBlobUrl,resolveSafe,sessionCanRead,materializeTaskImageTextResult,getDbClient});
