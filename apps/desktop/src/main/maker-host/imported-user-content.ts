import { createImportedUserContent } from '@cindy/app-runtime/importedUserContent';
import * as imageCacheStore from '../imageCacheStore.js';
import { createLogger } from '../logger.js';
export type * from '@cindy/app-runtime/importedUserContent';
export const { importedUserContent, stripCompleteIdeOpenedFileBlocks, parseImageDataUrl, normalizeImageMime, cacheImportedBase64Image } = createImportedUserContent({ imageCacheStore, logger: createLogger('imported-user-content') });
