import type { AppServerConfig } from './connection.js';
import type { McpAppsHost, McpAppModelContext } from './host.js';
import { clearMcpAppDocuments, setMcpAppCallerCleanup } from './sandboxProtocol.js';

let host: McpAppsHost | undefined;
const configs = new Map<string, () => AppServerConfig>();
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
  configs.clear();
}
export function readAppServer(id: string): AppServerConfig | undefined {
  return configs.get(id)?.();
}
export function appServerIds(): string[] {
  return [...configs.keys()];
}
export function resetAppServers(): void {
  configs.clear();
  clearMcpAppDocuments();
  void host?.reset();
}

/** Keep the snapshot pending until the send or steer carrying it is accepted. */
export async function mcpAppModelContext(sessionId: string): Promise<McpAppModelContext> {
  return (
    (await host?.modelContext(sessionId)) ?? { text: '', async assertCurrent() {}, consume() {} }
  );
}
