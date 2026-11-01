import { net } from 'electron';
import * as blobStore from '../cindy-media/blobStore.js';
import { ingestMedia } from '../cindy-media/ingest.js';
import { getDbClient } from '../localDb/client/current.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { createChatMediaRuntime } from '@cindy/app-runtime/chatServerMedia';
export const { createChatMedia } = createChatMediaRuntime({fetch:(url,init)=>net.fetch(url instanceof URL ? url.toString() : url,init),blobStore,ingestMedia,getDbClient,ownerScopedUserDataPath});
export type { ChatUploadAttachment } from '@cindy/companion-core/chatMedia';
