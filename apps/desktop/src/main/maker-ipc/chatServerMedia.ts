import { net } from 'electron';
import * as blobStore from '../cindy-media/blobStore.js';
import { ingestMedia } from '../cindy-media/ingest.js';
import { getDbClient } from '../localDb/client/current.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { createChatMediaRuntime } from '@cindy/app-runtime/chatServerMedia';
export const { createChatMedia } = createChatMediaRuntime({fetch:(...args)=>net.fetch(...args),blobStore,ingestMedia,getDbClient,ownerScopedUserDataPath});
