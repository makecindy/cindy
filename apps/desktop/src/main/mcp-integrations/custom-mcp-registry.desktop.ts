import { listCustomMcpServers } from '../maker-host/custom-mcp-store.desktop.js';
import { readCustomMcpToken } from '../secrets/providerSecretStore.js';
import { createAppServerProxy } from '../mcp-apps/serverProxy.desktop.js';
import { registerAppServer, resetAppServers, clearAppServerConfigs } from '../mcp-apps/runtime.js';
import { createCustomMcpRegistry } from './custom-mcp-registry.js';
export const { registerCustomMcpArrays, resetCustomMcpRegistry, getBuiltinMcpServerNames, listRegistrableCustomMcpServers, refreshCustomMcpProviders, __resetCustomMcpRegistryForTest } = createCustomMcpRegistry({
  listCustomMcpServers, readCustomMcpToken, createAppServerProxy, registerAppServer, resetAppServers, clearAppServerConfigs,
});
