import { createPrRefsStore } from '@cindy/runtime-db/prRefsStore';
import { getDbClient, getCurrentDbClientUserId } from '../localDb/client/current';
import { createLogger } from '../logger.js';
export type * from '@cindy/runtime-db/prRefsStore';
export const { setPrRefsChangedListener, recordPrRefsForMessage, recordPrRefsForImportedMessages, ensurePrRefsBackfill, recomputePrRefsForSession, listAllPrRefs, listPrRefs } = createPrRefsStore({ getDbClient: () => getDbClient(), getCurrentDbClientUserId: () => getCurrentDbClientUserId(), logger: createLogger('git-context/pr-refs') });
