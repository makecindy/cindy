// register.ts and bootstrap-electron.ts read these bindings during module
// initialization. Keep this assembly's dependencies free of back-imports to
// either entry (and maker-host/index.ts) so the single instance is ready first.
import { app } from 'electron';
import * as imageCacheStore from '../imageCacheStore.desktop.js';
import * as cindyMediaBlobStore from '../cindy-media/blobStore.desktop.js';
import * as cindyMediaLedger from '../cindy-media/ledger.js';
import { ingestMedia } from '../cindy-media/ingest.js';
import { isRemoteAttachmentRef, parseRemoteAttachmentRef, materializeRemoteAttachment } from '../device-link/remoteAttachment.js';
import { removeRemote } from '../device-link/mediaTransfer.desktop.js';
import { createAttachmentNormalizer } from './normalizeAttachments.js';
export type { MaterializedAttachmentPart } from './normalizeAttachments.js';

export const {
  configureTempAttachmentOwner, tempAttachmentRootPath, writeTempFile, normalizeUserMessage,
  materializeQueuedOssAttachmentsDeferred, collectQueuedAttachmentRefs, materializeDirectSendOssAttachments,
  cleanupSessionTempAttachments, cleanupOrphanedTempAttachments,
} = createAttachmentNormalizer({
  getTempDir: () => app.getPath('temp'),
  imageCacheStore: {
    resolveSafe: (...args) => imageCacheStore.resolveSafe(...args),
    copyFromPath: (...args) => imageCacheStore.copyFromPath(...args),
    removeFile: (...args) => imageCacheStore.removeFile(...args),
  },
  cindyMediaBlobStore: {
    resolveSafe: (...args) => cindyMediaBlobStore.resolveSafe(...args),
    deleteBlobFile: (...args) => cindyMediaBlobStore.deleteBlobFile(...args),
    mimeForExt: (...args) => cindyMediaBlobStore.mimeForExt(...args),
    supportedMime: (...args) => cindyMediaBlobStore.supportedMime(...args),
  },
  cindyMediaLedger: {
    removeRefById: (...args) => cindyMediaLedger.removeRefById(...args),
    deleteZeroRefBlobRecord: (...args) => cindyMediaLedger.deleteZeroRefBlobRecord(...args),
  },
  ingestMedia: (...args) => ingestMedia(...args),
  isRemoteAttachmentRef: (value): value is string => isRemoteAttachmentRef(value),
  parseRemoteAttachmentRef: (...args) => parseRemoteAttachmentRef(...args),
  materializeRemoteAttachment: (...args) => materializeRemoteAttachment(...args),
  removeRemote: (...args) => removeRemote(...args),
});
