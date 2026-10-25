import { createChatAttachments } from '@cindy/app-runtime/chatAttachments';
import * as blobStore from './blobStore';
import * as ledger from './ledger';
import { getDbClient } from '../localDb/client/current';
import { createLogger } from '../logger';
export type * from '@cindy/app-runtime/chatAttachments';
export const { ingestChatImageBuffer, ingestChatImageFromPath, collectCindyMediaUrls, collectCindyMediaHashes, commitMessageMediaRefs, commitChatImageUrls } = createChatAttachments({ blobStore, ledger, getDbClient: () => getDbClient(), logger: createLogger('cindy-media/chat') });
