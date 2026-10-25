import * as blobStore from './blobStore';
import * as ledger from './ledger';
import { ingestMedia } from './ingest';
import { createLogger } from '../logger';
import { createIntegrationCache } from '@cindy/media-core/integration-cache';
export { integrationCacheKey, normalizeIntegrationMime } from '@cindy/media-core/integration-cache';
export type { IntegrationCacheHit, IntegrationCacheWrite } from '@cindy/media-core/integration-cache';
export const { integrationCacheGet, integrationCachePut, supportedMime } = createIntegrationCache<ledger.LedgerDb>({
  blobStore, ledger, ingestMedia, log: createLogger('cindy-media/integration-cache'),
});
