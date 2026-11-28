import { captureMediaRefCompensationScope } from './refCompensationJournal.desktop';
import { blobUrl, extForMime, parseBlobUrl, resolveSafe } from './blobStore.desktop';
import { ingestMedia } from './ingest';
import { createGeneratedImageStorage } from './generatedImageStorageCore';
export {
  generatedImageErrorCode,
  type GeneratedImageInvoke,
  type GeneratedImageStorageScope,
} from './generatedImageStorageCore';

// The desktop's media store, read at call time (generatedImageStorageCore.ts).
export const {
  captureGeneratedImageStorage,
  readGeneratedImageEpoch,
  releaseGeneratedImageUpstream,
  prepareGeneratedImageTransport,
  handleGeneratedImageArtifacts,
} = createGeneratedImageStorage({
  captureMediaRefCompensationScope: () => captureMediaRefCompensationScope(),
  parseBlobUrl: (url) => parseBlobUrl(url),
  resolveSafe: (url) => resolveSafe(url),
  extForMime: (mimeType) => extForMime(mimeType),
  blobUrl: (hash, ext) => blobUrl(hash, ext),
  ingestMedia: (params, db) => ingestMedia(params, db),
});
