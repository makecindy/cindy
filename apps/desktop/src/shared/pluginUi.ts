/** Native placement data only; complex pages continue to use the MCP Apps SDK. */
export interface PluginUiTarget { sessionId?: string | null; clientId?: string }
export interface PluginUiInterest extends PluginUiTarget { instanceId: string; id: string }
export interface PluginUiControlState { title?: string; value?: string; disabled?: boolean; visible?: boolean }
export interface PluginUiStateChange { key: string; revision: number; state: PluginUiControlState }
export const pluginUiInterestKey = (entry: PluginUiInterest) =>
  JSON.stringify([entry.instanceId, entry.id, entry.sessionId ?? null, entry.clientId ?? null]);
