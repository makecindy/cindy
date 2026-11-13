/** Native placement data only; complex pages continue to use the MCP Apps SDK. */
export interface PluginUiTarget { sessionId?: string | null; clientId?: string }
export interface PluginUiInterest extends PluginUiTarget { instanceId: string; id: string }
export interface PluginUiControlState { title?: string; value?: string; disabled?: boolean; visible?: boolean }
export interface PluginUiStateChange { key: string; revision: number; state: PluginUiControlState }
export interface PluginUiAttachmentResult {
  handled: boolean;
  text?: string;
  files?: { name: string; path: string; size: number; mimeType: string; url?: string }[];
}
export const PLUGIN_UI_INTEREST_LIMIT = 512;
export const PLUGIN_UI_STATE_BATCH_LIMIT = 512;
export const PLUGIN_UI_REGIONS = ['workspace', 'sidebar', 'header', 'messages', 'composer', 'tools', 'windowControls'] as const;
export type PluginUiRegion = typeof PLUGIN_UI_REGIONS[number];
export type PluginUiRegions = Record<PluginUiRegion, boolean>;
export const DEFAULT_PLUGIN_UI_REGIONS: PluginUiRegions = { workspace: true, sidebar: true, header: true, messages: true,
  composer: true, tools: true, windowControls: true };
export const pluginUiInterestKey = (entry: PluginUiInterest) =>
  JSON.stringify([entry.instanceId, entry.id, entry.sessionId ?? null, entry.clientId ?? null]);
