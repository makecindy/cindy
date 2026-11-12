import { REMOTE_RESOURCE_CHANGED_CHANNEL, type RemoteResourceChangedPayload } from '@cindy/device-link';

import { getSafeDataOwnerPushStamp, tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import { createLogger } from '../logger.js';
import {
  BOT_GROUP_REMOTE_COLLECTION_ID,
  BOT_GROUP_REMOTE_RESOURCE_KIND,
} from '../../shared/botGroupChat.js';

const log = createLogger('maker-ipc:bot-group-remote-resource');

/**
 * Tell controllers that a group projection must be re-read. Every group change touches the
 * collection row (preview, running state), so the payload names the collection and the group.
 * Only the device-link tap needs it: local windows already listen to `maker:bot-group:changed`.
 */
export function broadcastBotGroupRemoteResourceChanged(groupId: string): void {
  const payload: RemoteResourceChangedPayload = {
    collectionId: BOT_GROUP_REMOTE_COLLECTION_ID,
    resourceRefs: [{ collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, kind: BOT_GROUP_REMOTE_RESOURCE_KIND, id: groupId }],
  };
  try {
    tapWindowBroadcast(REMOTE_RESOURCE_CHANGED_CHANNEL, payload, getSafeDataOwnerPushStamp());
  } catch (error) {
    log.warn('remote group invalidation broadcast failed', { error: error instanceof Error ? error.message : String(error) });
  }
}
