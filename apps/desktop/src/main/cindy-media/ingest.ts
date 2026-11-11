import * as blobStore from './blobStore.desktop';
import { withMediaRefCompensation } from './refCompensationJournal.desktop';
import { createMediaIngest } from './ingestCore';
export type { IngestRef, IngestMediaParams, IngestedMedia } from './ingestCore';

export const {
  ingestMedia,
  supportedMime,
  ingestClientWallpaper,
} = createMediaIngest({ blobStore, withMediaRefCompensation });
