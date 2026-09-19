import { REMOTE_RESOURCE_CHANGED_CHANNEL } from '@cindy/device-link';
import {
  tapWindowBroadcast,
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../device-link/broadcast-tap.js';
import { makeRemoteRef, MAKE_REMOTE_COLLECTION } from './remoteProjection.js';

/** Invalidate, never duplicate, the host-owned snapshot on remote controllers. */
export function broadcastMakeRemoteChanged(
  sessionId: string,
  scope = captureDataOwnerBroadcastScope(),
): void {
  if (!isDataOwnerBroadcastScopeCurrent(scope)) return;
  try {
    tapWindowBroadcast(
      REMOTE_RESOURCE_CHANGED_CHANNEL,
      {
        collectionId: MAKE_REMOTE_COLLECTION,
        resourceRefs: [makeRemoteRef(sessionId)],
      },
      scope.ownerStamp,
    );
  } catch {
    // A disconnected controller must not fail a persisted local operation.
  }
}
