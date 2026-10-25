import { app } from 'electron';
import { createLegacyImageCache } from '@cindy/media-core/legacy-image-cache';
export type { ImageCacheLifecycle, ImageCacheMeta, SweepDraftImagesResult } from '@cindy/media-core/legacy-image-cache';
export const { getCacheRoot, getSessionDir, copyFromPath, writeBuffer, writeBufferStable, toSessionImageCacheKey, collectSessionImageUrls, markFilesCommitted, sweepDraftImages, resolveSafe, resolveSessionImageLenient, readFile, readAsBase64, removeFile, removeSession } = createLegacyImageCache(() => app.getPath('userData'));
