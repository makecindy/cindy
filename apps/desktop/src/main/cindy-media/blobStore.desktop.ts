import { app } from 'electron';
import { createBlobStore } from './blobStore';
export type { BlobScope, WrittenBlob, BlobSource, BlobFileEntry, BlobDirListing } from './blobStore';

export const {
  getBlobsRoot,
  blobUrl,
  extForMime,
  supportedMime,
  mimeForExt,
  writeBlob,
  resolveSafe,
  resolveHashRef,
  parseBlobUrl,
  readFile,
  parseClientWallpaperUrl,
  readClientWallpaperFile,
  openClientWallpaperVideo,
  openBlobFile,
  listBlobFiles,
  deleteBlobFile,
  listStaleTmpFiles,
  cleanupTmpFiles,
} = createBlobStore({ getUserDataDir: () => app.getPath('userData') });
