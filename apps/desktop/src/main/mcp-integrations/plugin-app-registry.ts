import { replacePluginAppServers } from '../mcp-apps/runtime.js';
import { createPluginAppRegistry } from './pluginAppRegistryCore.js';
import { reconcilePluginUiRegions } from '../mcp-apps/visibility.js';
import { reconcilePluginAppearanceSources } from '../mcp-apps/appearance.js';
export { pluginAppServerId } from './pluginAppIdentity.js';
const registry = createPluginAppRegistry(replacePluginAppServers);
export const { setPluginPageToolRunner, readPluginHostUi, listPluginHostUi } = registry;
export function refreshPluginApps(...args: Parameters<typeof registry.refreshPluginApps>): void {
  registry.refreshPluginApps(...args);
  void reconcilePluginAppearanceSources(readPluginHostUi, args[1].available).catch(() => {});
  reconcilePluginUiRegions((instance, token) => {
    const entry = readPluginHostUi(instance);
    return !!entry && `${entry.owner}:${entry.fingerprint}` === token && entry.host.capabilities?.includes('visibility') === true;
  });
}
