import * as blobStore from './blobStore';
import {ingestMedia} from './ingest';
import {createGeneratedMedia} from '@cindy/app-runtime/generatedMedia';
export type * from '@cindy/app-runtime/generatedMedia';
export const {createBlobImageStorage,normalizeGeneratedVideoMime,createBlobVideoStorage,MAX_GENERATED_IMAGE_BYTES,generatedImageBytes,readGeneratedImageFile,safeGeneratedImageFilename,materializeGeneratedImage}=createGeneratedMedia({blobStore,ingestMedia});
