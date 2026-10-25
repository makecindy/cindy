import { createMediaLedger } from '@cindy/runtime-db/mediaLedger';
import { getDbClient } from '../localDb/client/current';
export type * from '@cindy/runtime-db/mediaLedger';
export const { withSessionMediaRefLock, relocateGhostMediaRefs, sessionCanRead, recordBlob, pinBlob, addRef, removeRefById, getIntegrationCacheHash, hasRef, hasGhostToolGrant, removeSessionRefs, removeSessionRefsIfDeleted, removeRefsExceptHash, removeRefs, removeSessionAttachmentRefIfUnreferencedByLiveMessage, ghostCanRead, ghostDepositUsageBytes, removeGhostDepositRef, hasNonCacheBlob, getBlobInfo, listZeroRefBlobs, getStorageStats, getIntegrationCacheBytes, listCacheBlobsByLru, deleteZeroRefBlobRecord, deleteCacheBlobRecord, listAllBlobRecords, listGhostGallery, touchBlob } = createMediaLedger(getDbClient);
