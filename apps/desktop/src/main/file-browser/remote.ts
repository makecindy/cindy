import {
  RemoteFileBrowserManager as SharedManager,
  type RemoteFsDeps as SharedDeps,
} from '@cindy/app-runtime/remoteFileBrowser';
import { createLogger } from '../logger.js';
export { throwRemoteFsIpcError } from '@cindy/app-runtime/remoteFileBrowser';
export type { RemoteFsHost, RemoteFsProbe } from '@cindy/app-runtime/remoteFileBrowser';
export type RemoteFsDeps = Omit<SharedDeps, 'logger'> & { logger?: SharedDeps['logger'] };
export class RemoteFileBrowserManager extends SharedManager {
  constructor(deps: RemoteFsDeps) {
    super({ ...deps, logger: deps.logger ?? createLogger('file-browser/remote') });
  }
}
