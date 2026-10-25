import { app } from 'electron';
import { createAttachmentNormalizer } from '@cindy/app-runtime/normalizeAttachments';
import * as imageCacheStore from '../imageCacheStore.js';
import * as cindyMediaBlobStore from '../cindy-media/blobStore.js';
import * as cindyMediaLedger from '../cindy-media/ledger.js';
import { ingestMedia } from '../cindy-media/ingest.js';
import { createLogger } from '../logger.js';
import { materializeRemoteAttachment } from '../device-link/remoteAttachment.js';
import { removeRemote } from '../device-link/mediaTransfer.js';
export type * from '@cindy/app-runtime/normalizeAttachments';
export const { configureTempAttachmentOwner, writeTempFile, normalizeUserMessage, materializeQueuedOssAttachmentsDeferred, collectQueuedAttachmentRefs, materializeDirectSendOssAttachments, cleanupSessionTempAttachments, cleanupOrphanedTempAttachments } = createAttachmentNormalizer({
 temporaryDirectory: () => app.getPath('temp'), logger: createLogger('maker-ipc/normalize'),
 imageCacheStore: { resolveSafe: (...args) => imageCacheStore.resolveSafe(...args), copyFromPath: (...args) => imageCacheStore.copyFromPath(...args), removeFile: (...args) => imageCacheStore.removeFile(...args) },
 cindyMediaBlobStore: { resolveSafe: (...args) => cindyMediaBlobStore.resolveSafe(...args), deleteBlobFile: (...args) => cindyMediaBlobStore.deleteBlobFile(...args), mimeForExt: (...args) => cindyMediaBlobStore.mimeForExt(...args), supportedMime: (...args) => cindyMediaBlobStore.supportedMime(...args) },
 cindyMediaLedger: { removeRefById: (...args) => cindyMediaLedger.removeRefById(...args), deleteZeroRefBlobRecord: (...args) => cindyMediaLedger.deleteZeroRefBlobRecord(...args) },
 ingestMedia: (...args) => ingestMedia(...args), materializeRemoteAttachment: (...args) => materializeRemoteAttachment(...args),
 removeRemote: (...args) => removeRemote(...args),
});
