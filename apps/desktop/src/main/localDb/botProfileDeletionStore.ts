import { createBotProfileDeletionStore } from '@cindy/app-runtime/botProfileDeletionStore';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { getDbClient } from './client/current.js';
export const { commitBotProfileDeletion } = createBotProfileDeletionStore({
 getDbClient: () => getDbClient(), activeOwnerScopeKey: () => activeOwnerScopeKey(),
 isAppSessionBoundaryPending: () => isAppSessionBoundaryPending(), ownerScopedUserDataPath: () => ownerScopedUserDataPath(),
});
