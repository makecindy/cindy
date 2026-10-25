/** Desktop adapter for the shared, host-scoped content-addressed byte store. */
import { app } from 'electron';
import { createBlobStore } from '@cindy/media-core';
export type { BlobScope, WrittenBlob, BlobSource, BlobFileEntry, BlobDirListing } from '@cindy/media-core';
const store = createBlobStore(() => app.getPath('userData'));
export const { getBlobsRoot, blobUrl, extForMime, supportedMime, mimeForExt, writeBlob, resolveSafe, resolveHashRef, parseBlobUrl, readFile, parseClientWallpaperUrl, readClientWallpaperFile, openClientWallpaperVideo, listBlobFiles, deleteBlobFile, listStaleTmpFiles, cleanupTmpFiles } = store;
