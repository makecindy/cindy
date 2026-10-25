import * as blobStore from '../cindy-media/blobStore.js';
import { ingestMedia } from '../cindy-media/ingest.js';
import * as ledger from '../cindy-media/ledger.js';
import { getDbClient } from '../localDb/client/current.js';
import { removeRemote } from '../device-link/mediaTransfer.js';
import { materializeRemoteAttachment, parseRemoteAttachmentRef } from '../device-link/remoteAttachment.js';
import { createBotGroupAttachmentRuntime } from '@cindy/app-runtime/botGroupAttachments';
export * from '@cindy/app-runtime/botGroupAttachments';
export const { createBotGroupAttachmentStore } = createBotGroupAttachmentRuntime({blobStore,ingestMedia,ledger,getDbClient,removeRemote,materializeRemoteAttachment,parseRemoteAttachmentRef});
