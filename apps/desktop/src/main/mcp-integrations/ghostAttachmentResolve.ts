import * as blobs from '../cindy-media/blobStore.desktop.js';
import * as images from '../imageCacheStore.desktop.js';
import { createGhostAttachmentResolver } from './ghostAttachmentResolveCore.js';
export const resolveGhostAttachmentUrl = createGhostAttachmentResolver(blobs, images);
