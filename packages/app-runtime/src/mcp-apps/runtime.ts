import type { AppServerConfig } from './connection.js';
import type { McpAppsHost, McpAppModelContext } from './host.js';


export function createMcpAppsRuntime(view?: {clearDocuments?():void;setCallerCleanup?(cleanup:(caller:string)=>unknown):void}) {
const clearMcpAppDocuments=()=>view?.clearDocuments?.();
const setMcpAppCallerCleanup=(cleanup:(caller:string)=>unknown)=>view?.setCallerCleanup?.(cleanup);


let host: McpAppsHost | undefined;
const configs = new Map<string, () => AppServerConfig>();
function setMcpAppsHost(value: McpAppsHost): void {
  host = value;
  setMcpAppCallerCleanup((caller) => value.releaseCaller(caller));
}
function getMcpAppsHost(): McpAppsHost {
  if (!host) throw new Error('MCP_APPS_NOT_READY');
  return host;
}
function registerAppServer(id: string, read: () => AppServerConfig): void {
  configs.set(id, read);
}
function clearAppServerConfigs(): void {
  configs.clear();
}
function readAppServer(id: string): AppServerConfig | undefined {
  return configs.get(id)?.();
}
function appServerIds(): string[] {
  return [...configs.keys()];
}
function resetAppServers(): void {
  configs.clear();
  clearMcpAppDocuments();
  void host?.reset();
}

/** Keep the snapshot pending until the send or steer carrying it is accepted. */
async function mcpAppModelContext(sessionId: string): Promise<McpAppModelContext> {
  return (
    (await host?.modelContext(sessionId)) ?? { text: '', async assertCurrent() {}, consume() {} }
  );
}
return {
  setMcpAppsHost,
  getMcpAppsHost,
  registerAppServer,
  clearAppServerConfigs,
  readAppServer,
  appServerIds,
  resetAppServers,
  mcpAppModelContext
};
}
