import { app } from 'electron';
import { activeOwnerScopeKey, dataOwnerStorageKey } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { createRemoteFileCache } from '@cindy/app-runtime/remoteFileCache';
export type * from '@cindy/app-runtime/remoteFileCache';
export const {
  readVersionedRemoteFile,
  removeVersionedRemoteFile,
  writeVersionedRemoteFile,
  getRemoteFileCacheRoot,
  getChatAttachmentOwnerCacheRoot,
  getChatAttachmentCacheRoot,
  cleanupOwnedUnpersistedStagedChatAttachments,
  findStaleCached,
  isInsideCacheDir,
  putCachedContent,
  fetchRemoteFileToCache,
  stageLocalFileToCache,
  sweepCacheOnStartup,
  __cacheTesting,
} = createRemoteFileCache({
  userDataDirectory: () => app.getPath('userData'),
  activeOwnerScopeKey: () => activeOwnerScopeKey(),
  dataOwnerStorageKey,
  logger: createLogger('file-browser/remote-cache'),
});
