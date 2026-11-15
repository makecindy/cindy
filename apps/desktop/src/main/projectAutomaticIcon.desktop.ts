import {
  configureProjectIconRuntime,
  resolveAutomaticProjectIcon,
} from './projectAutomaticIcon.js';
import { guardedOutboundFetch } from './maker-host/outbound-fetch.desktop.js';
configureProjectIconRuntime({
  fetch: guardedOutboundFetch,
  readRemote: async (host, workdir, relPath) =>
    (await import('./file-browser/remote-deps.js'))
      .getRemoteFileBrowser()
      .request(host, 'readFileChunk', {
        workdir,
        relPath,
        offset: 0,
        length: 1024 * 1024,
      }),
});
export { resolveAutomaticProjectIcon };
