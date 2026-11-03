import { pagePermissionGrants } from './pagePermissions.js';
import type { AppServerConfig } from './connection.js';
import type { McpAppsHost, McpAppModelContext } from './host.js';
import { clearMcpAppDocuments, setMcpAppCallerCleanup } from './sandboxProtocol.js';
import { createLogger } from '../logger.js';

let host: McpAppsHost | undefined;
const configs = new Map<string, () => AppServerConfig>();
const pluginConfigs = new Map<string, () => AppServerConfig>();
export function setMcpAppsHost(value: McpAppsHost): void {
  host = value;
  setMcpAppCallerCleanup((caller) => value.releaseCaller(caller));
}
export function getMcpAppsHost(): McpAppsHost {
  if (!host) throw new Error('MCP_APPS_NOT_READY');
  return host;
}
export function registerAppServer(id: string, read: () => AppServerConfig): void {
  configs.set(id, read);
}
export function clearAppServerConfigs(): void {
  pagePermissionGrants.clearServers(new Set(configs.keys()));
  configs.clear();
}
export function readAppServer(id: string): AppServerConfig | undefined {
  try { return configs.get(id)?.() ?? pluginConfigs.get(id)?.(); } catch { return undefined; }
}
export function appServerIds(): string[] {
  return [...configs.keys()];
}
export function replacePluginAppServers(next: Map<string, () => AppServerConfig>): void {
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
export async function revokePluginAppServers(): Promise<void> { await host?.revokePluginConnections(); }
export async function stopPluginAppInstance(instance: string): Promise<void> {
  await host?.revokePluginConnections(instance);
}

export function resetAppServers(): void {
  pagePermissionGrants.clearServers(new Set(configs.keys()));
  configs.clear();
  pagePermissionGrants.clearServers(new Set(pluginConfigs.keys()));
  pluginConfigs.clear();
  clearMcpAppDocuments();
  void host?.reset();
}

/** Keep the snapshot pending until the send or steer carrying it is accepted. */
export async function mcpAppModelContext(sessionId: string): Promise<McpAppModelContext> {
  return (
    (await host?.modelContext(sessionId)) ?? { text: '', async assertCurrent() {}, consume() {} }
  );
}
