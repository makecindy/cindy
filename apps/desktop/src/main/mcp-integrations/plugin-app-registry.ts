import { replacePluginAppServers } from '../mcp-apps/runtime.js';
import { createPluginAppRegistry } from './pluginAppRegistryCore.js';
export { pluginAppServerId } from './pluginAppIdentity.js';
export const { setPluginPageToolRunner, refreshPluginApps } = createPluginAppRegistry(replacePluginAppServers);
