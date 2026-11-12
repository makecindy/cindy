import * as blobStore from './blobStore.desktop';
import { createChatAttachments } from './chatAttachmentsCore';
export type { IngestedChatImage } from './chatAttachmentsCore';

export const {
  ingestChatImageBuffer,
  ingestChatImageFromPath,
  collectCindyMediaUrls,
  collectCindyMediaHashes,
  commitMessageMediaRefs,
  commitChatImageUrls,
} = createChatAttachments({ blobStore });
