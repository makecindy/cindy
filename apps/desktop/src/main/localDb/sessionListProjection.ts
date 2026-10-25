import {createSessionListProjection} from '@cindy/runtime-db/sessionListProjection';
export type * from '@cindy/runtime-db/sessionListProjection';
import {getDbClient} from './client/current.js';
export const {serializeSessionListProjectionBackfill, persistSessionListPreview, invalidateSessionListMessageCount, invalidateSessionListPreview, persistSessionListMessageCount, persistSessionListProjectionBatch}=createSessionListProjection(getDbClient);
export * from '@cindy/runtime-db/sessionListProjection.sql';
