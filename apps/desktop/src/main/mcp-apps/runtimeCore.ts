import { pagePermissionGrants } from './pagePermissions.js';
import type { AppServerConfig } from './connection.js';
import type { McpAppsHost, McpAppModelContext } from './host.js';
import { createLogger } from '../logger.js';

/** A launcher owns one registry and its view resources. */
export function createMcpAppsRuntime(ports: {
  clearMcpAppDocuments?(): void;
  setMcpAppCallerCleanup?(callback: (caller: string) => Promise<void>): void;
} = {}) {
let host: McpAppsHost | undefined;
const configs = new Map<string, () => AppServerConfig>();
const pluginConfigs = new Map<string, () => AppServerConfig>();
function setMcpAppsHost(value: McpAppsHost): void {
  host = value;
  ports.setMcpAppCallerCleanup?.((caller) => value.releaseCaller(caller));
}
function getMcpAppsHost(): McpAppsHost {
  if (!host) throw new Error('MCP_APPS_NOT_READY');
  return host;
}
function registerAppServer(id: string, read: () => AppServerConfig): void {
  configs.set(id, read);
}
function clearAppServerConfigs(): void {
  pagePermissionGrants.clearServers(new Set(configs.keys()));
  configs.clear();
}
function readAppServer(id: string): AppServerConfig | undefined {
  try { return configs.get(id)?.() ?? pluginConfigs.get(id)?.(); } catch { return undefined; }
}
function appServerIds(): string[] {
  return [...configs.keys()];
}
function replacePluginAppServers(next: Map<string, () => AppServerConfig>): void {
  const revoked = new Set<string>();
  for (const [id, read] of pluginConfigs) {
    try {
      const before = read().plugin; const after = next.get(id)?.().plugin;
      if (!before || !after || before.revision !== after.revision || before.packageSha256 !== after.packageSha256 || before.directory !== after.directory) revoked.add(id);
    } catch { revoked.add(id); }
  }
  pagePermissionGrants.clearServers(revoked);
  pluginConfigs.clear();
  for (const [id, read] of next) pluginConfigs.set(id, read);
  void host?.revokePluginServers(revoked).catch(() => createLogger('plugin-ui').warn('plugin page revocation failed'));
}
async function revokePluginAppServers(): Promise<void> { await host?.revokePluginConnections(); }
async function stopPluginAppInstance(instance: string): Promise<void> {
  await host?.revokePluginConnections(instance);
}

function resetAppServers(): void {
  pagePermissionGrants.clearServers(new Set(configs.keys()));
  configs.clear();
  pagePermissionGrants.clearServers(new Set(pluginConfigs.keys()));
  pluginConfigs.clear();
  ports.clearMcpAppDocuments?.();
  void host?.reset();
}

/** Keep the snapshot pending until the send or steer carrying it is accepted. */
async function mcpAppModelContext(sessionId: string): Promise<McpAppModelContext> {
  return (
    (await host?.modelContext(sessionId)) ?? { text: '', async assertCurrent() {}, consume() {} }
  );
}

return { setMcpAppsHost, getMcpAppsHost, registerAppServer, clearAppServerConfigs, readAppServer, appServerIds, replacePluginAppServers, revokePluginAppServers, stopPluginAppInstance, resetAppServers, mcpAppModelContext };
}
