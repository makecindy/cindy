import { createMediaIngest } from '@cindy/app-runtime/mediaIngest';
import * as blobStore from './blobStore';
import * as ledger from './ledger';
import { withMediaRefCompensation } from './refCompensationJournal';
import { createLogger } from '../logger';
export type * from '@cindy/app-runtime/mediaIngest';
export const { ingestMedia, supportedMime, ingestClientWallpaper } = createMediaIngest({ blobStore, ledger, withMediaRefCompensation, logger: createLogger('cindy-media-ingest') });
