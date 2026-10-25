import { createLogger } from '../logger';
import { createOrcaIndexCleanup } from '@cindy/runtime-db/orcaStaleIndexCleanup';
export const { hasStaleOrcaLeadIndex, cleanupStaleOrcaLeadIndex } = createOrcaIndexCleanup(createLogger('orca-stale-index-cleanup'));
