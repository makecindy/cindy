import { resolveSafe, openBlobFile } from '../cindy-media/blobStore.desktop.js';
import { createPluginFileAccessCore } from './pluginFileAccessCore.js';
export function createPluginFileAccess(deps: Parameters<typeof createPluginFileAccessCore>[1]) {
  return createPluginFileAccessCore({ resolveSafe, openBlobFile }, deps);
}
