import { createLogger } from '../../logger';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { createInboundFileStaging } from '@cindy/im-runtime/inboundFileStaging';
export { STAGING_MAX_AGE_MS } from '@cindy/im-runtime/inboundFileStaging';
export const {
  stageInboundFile,
  inboundFileStaging,
  adoptStagedInboundFiles,
  imAttachmentsRoot,
  removeImSessionAttachmentDirs,
  resetInboundFileStagingForTests,
  sanitizeInboundFileName,
} = createInboundFileStaging({ createLogger, ownerScopedImUserDataPath });
