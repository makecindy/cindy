/**
 * Plugin module entry point — creates and caches a process-level singleton
 * PluginRegistry wired with the desktop host settings reader.
 */

import { PluginRegistry } from './plugin-registry.js';
import { SettingsReader } from './settings-reader.js';
import { createLogger } from '../../logger.js';
import { ownerScopedPath as ownerScopedUserDataPath } from '../../ownerContext.js';

let _registry: PluginRegistry | null = null;
let _registryOwnerPath: string | null = null;

export function createPluginRegistry(): PluginRegistry {
  const ownerPath = ownerScopedUserDataPath();
  if (!_registry || _registryOwnerPath !== ownerPath) {
    const logger = createLogger('plugin-registry');
    const settingsReader = new SettingsReader({ logger, userDataPath: ownerPath });
    _registry = new PluginRegistry({ settingsReader });
    _registryOwnerPath = ownerPath;
  }
  return _registry;
}

/** For reset / testing. */
export function resetPluginRegistry(): void {
  _registry = null;
  _registryOwnerPath = null;
}

export { PluginRegistry } from './plugin-registry.js';
export { SettingsReader } from './settings-reader.js';
export * from './types.js';
export {
  createBuiltinPlugins,
  BUILTIN_LIZI_MCP_IDS,
  pluginIdForProviderName,
} from './builtin-plugins.js';
export type { KnownProviderName } from './builtin-plugins.js';
