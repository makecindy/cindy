import { createSshMedia } from '@cindy/app-runtime/sshMedia';
import { createLogger } from '../logger.js';
import { fetchRemoteFileToCache } from './remote-file-cache.js';
import { getRemoteFileBrowser } from './remote-deps.js';
export type * from '@cindy/app-runtime/sshMedia';
export { toWorkdirRelPosix } from '@cindy/app-runtime/sshMedia';
export const {
  makeSshChunkExecutor,
  serveCachedFile,
  materializeSshRemoteMedia,
  serveSshRemoteMedia,
} = createSshMedia({
  logger: createLogger('file-browser/ssh-media'),
  fetchToCache: fetchRemoteFileToCache,
  request: (host, method, params) =>
    getRemoteFileBrowser().request(host, method, params as never) as never,
});
