import { ipcMain } from 'electron';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer';
import { getDbClient } from '../client/current';
import { activeDataOwnerId, ownerGeneration, isOwnerBoundaryPending } from '../../ownerContext';
import { listInstalledGhostsAsync } from '../../cindy-brain';
import { getApprovedGhostHostUi } from '../../../shared/ghost';
import { executeMessageAnnotationRequest } from '../messageAnnotationStore';
import { readQueuedMessageAnnotationIds } from '../messageAnnotationQueue';

export function registerMessageAnnotationsIpc(): void {
  ipcMain.handle('local-db:message-annotations', async (event, request: unknown) => {
    assertTrustedAppRendererEvent(event);
    const owner = activeDataOwnerId(), generation = ownerGeneration(), db = getDbClient();
    const assertCurrent = () => {
      if (!owner || isOwnerBoundaryPending() || owner !== activeDataOwnerId() || generation !== ownerGeneration()) {
        throw new Error('[ANNOTATION_OWNER_CHANGED] Account changed; reopen this task');
      }
    };
    return executeMessageAnnotationRequest(request, {
      db, assertCurrent,
      queuedIds: readQueuedMessageAnnotationIds,
      canCreate: async () => (await listInstalledGhostsAsync()).some(ghost => getApprovedGhostHostUi(ghost)?.capabilities?.includes('annotations')),
    });
  });
}
