import { app } from 'electron';
import path from 'node:path';
import { getDbClient } from '../localDb/client/current.js';
import { resolveSafe } from '../cindy-media/blobStore.js';
import { createAgentIslandCompanionIdentity } from '@cindy/app-runtime/session-activity/companionIdentity';
export type { AgentIslandCompanionIdentity } from '@cindy/app-runtime/session-activity/companionIdentity';
export const { setCompanionAvatarResolver, readAgentIslandCompanion, companionSnapshotWithoutArtwork, companionAvatarHasArtwork, companionAvatarThumbnail } = createAgentIslandCompanionIdentity({ getDbClient, resolveSafe,
  resourcesDirectory: () => app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'),
});
