import { configureProjectDirectoryProbe } from './projectDirectoryValidation.js';
import { getRemoteFileBrowser } from './file-browser/remote-deps.js';

configureProjectDirectoryProbe(async (host, directory) => {
  const stat = await getRemoteFileBrowser().request(host, 'stat', {
    workdir: directory,
    relPath: '.',
  });
  return stat.type === 'directory';
});
