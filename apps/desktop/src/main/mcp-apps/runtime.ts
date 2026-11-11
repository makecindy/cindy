import { clearMcpAppDocuments, setMcpAppCallerCleanup } from './sandboxProtocol.js';
import { createMcpAppsRuntime } from './runtimeCore.js';
export const { setMcpAppsHost, getMcpAppsHost, registerAppServer, clearAppServerConfigs, readAppServer, appServerIds, replacePluginAppServers, revokePluginAppServers, stopPluginAppInstance, resetAppServers, mcpAppModelContext } = createMcpAppsRuntime({ clearMcpAppDocuments, setMcpAppCallerCleanup });
