import { app } from 'electron';
import { createImageCacheStore } from './imageCacheStore.js';
export type { ImageCacheLifecycle, ImageCacheMeta, SweepDraftImagesResult } from './imageCacheStore.js';
export const { getCacheRoot, getSessionDir, copyFromPath, writeBuffer, writeBufferStable, toSessionImageCacheKey, collectSessionImageUrls, markFilesCommitted, sweepDraftImages, resolveSafe, resolveSessionImageLenient, readFile, readAsBase64, removeFile, removeSession } = createImageCacheStore(() => app.getPath('userData'));
