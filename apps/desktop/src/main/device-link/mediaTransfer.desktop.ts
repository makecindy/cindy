import { net } from 'electron';
import { requireAppCapability } from '../appCapabilities.js';
import { deviceLinkApiFetch, officialDeviceLinkApiFetch } from './deviceLinkApi.desktop.js';
import { createMediaTransfer } from './mediaTransfer.js';

export { mimeOf, MAX_MEDIA_BYTES, AttachmentIntegrityError } from './mediaTransfer.js';
export type { UploadResult, DownloadResult } from './mediaTransfer.js';

// All desktop consumers share the same retry preference map. Read dependencies
// at call time so startup cycles and test spies retain their original timing.
export const {
  uploadLocalFile, uploadBuffer, downloadToBuffer, openMediaStream,
  downloadToFile, removeRemote, __testing,
} = createMediaTransfer({
  fetch: (url, init) => net.fetch(url, init),
  uploadFetch: (url, init) => globalThis.fetch(url, init),
  deviceLinkApiFetch: (...args) => deviceLinkApiFetch(...args),
  officialDeviceLinkApiFetch: (...args) => officialDeviceLinkApiFetch(...args),
  requireAppCapability: (...args) => requireAppCapability(...args),
});
