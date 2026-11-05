import type { PluginUiCapabilities, PluginUiInvocationResult, PluginUiInvokeInput, PluginUiView } from '@cindy/maker-shared';
import { pluginUiRecord, pluginUiText } from '@cindy/maker-shared/plugin-ui-host';
export type { PluginUiPluginMessage as GhostPipeNativeUiMessage, PluginUiHostMessage as GhostPipeNativeUiHostMessage } from '@cindy/maker-shared';

export const PLUGIN_UI_READ = 'ghosts:ui:read';
export const PLUGIN_UI_INVOKE = 'ghosts:ui:invoke';
export const PLUGIN_UI_CHOOSE_RENDERER = 'ghosts:ui:choose-renderer';
export const PLUGIN_UI_PAGE_OPEN = 'ghosts:ui:page-open';
export const PLUGIN_UI_PAGE_CLOSE = 'ghosts:ui:page-close';
export const PLUGIN_UI_RELEASE = 'ghosts:ui:release';
export const PLUGIN_UI_CHANGED = 'ghosts:ui:changed';
export const PLUGIN_UI_INSPECT = 'ghosts:ui:inspect';
export const PLUGIN_TAB_VIEW_HOST = 'ghosts:ui:tab-host';
export const PLUGIN_TAB_VIEW_NAVIGATE = 'ghosts:ui:tab-navigate';
export const PLUGIN_TAB_VIEW_REQUEST = 'ghosts:ui:tab-request';
export const PLUGIN_TAB_VIEW_OPENED = 'ghosts:ui:tab-opened';
export const PLUGIN_TAB_VIEW_MOUNT = 'ghosts:ui:tab-mount';
export const PLUGIN_TAB_VIEW_UPDATE = 'ghosts:ui:tab-update';
export const PLUGIN_TAB_VIEW_RELEASE = 'ghosts:ui:tab-release';
export const PLUGIN_TAB_VIEW_READ = 'ghosts:ui:tab-read';
export const PLUGIN_TAB_VIEW_CHANGED = 'ghosts:ui:tab-changed';
export const PLUGIN_TAB_VIEW_RECEIVED = 'ghosts:ui:tab-received';
export interface PluginTabViewMountRequest {
  tabId: string; instanceId: string; id: string; sessionId: string | null;
  params: import('@cindy/maker-shared').PluginUiValues; sequence: number; visible: boolean;
}
export interface PluginTabViewOpenRequest extends Omit<PluginTabViewMountRequest, 'tabId' | 'visible'> {
  requestId: string;
  ownerStamp?: import('./dataOwnerPush').DataOwnerPushStamp;
}
export interface PluginTabViewMountResult { token: string; snapshot: import('@cindy/maker-shared').PluginUiTabViewSnapshot; sequence: number }

export interface PluginUiReadRequest {
  sessionId: string;
  point: string;
  target?: { kind: string; id: string };
  subscriptionId?: string;
  capabilities: PluginUiCapabilities;
}
export interface PluginUiReadResult {
  views: PluginUiView[]; revision: string;
  renderer?: { candidates: Array<PluginUiRendererChoice & { pluginName: string }>;
    selected?: PluginUiRendererChoice; preference: 'automatic' | 'original' | 'selected' };
}
export type PluginUiRendererSource = { kind: 'plugin'; instanceId: string; name?: string } | { kind: 'tool'; name: string };
export interface PluginUiRendererTarget { point: 'message.body' | 'tool.body'; source: PluginUiRendererSource }
export interface PluginUiRendererChoice { instanceId: string; contributionId: string }
export interface PluginUiChooseRendererRequest { request: PluginUiReadRequest; choice: PluginUiRendererChoice | null }
export interface PluginUiInvokeRequest { sessionId: string; input: PluginUiInvokeInput }
export interface PluginUiPageOpenRequest { sessionId: string; viewId: string; revision: string }
export type PluginUiInvokeResult = PluginUiInvocationResult;
export interface PluginUiChanged { sessionId?: string }

/** Persisted identity only. Navigation parameters never enter tab state. */
export interface PluginTabViewState { instanceId: string; id: string; scope: 'global' | 'session' }
export function parsePluginTabViewState(value: unknown): PluginTabViewState | null {
  if (!pluginUiRecord(value) || !pluginUiText(value.instanceId) || !pluginUiText(value.id, 64) ||
      !/^[a-zA-Z0-9_-]+$/.test(value.id) || !['global', 'session'].includes(String(value.scope))) return null;
  return { instanceId: value.instanceId, id: value.id, scope: value.scope as PluginTabViewState['scope'] };
}

export function parsePluginUiReadRequest(value: unknown): PluginUiReadRequest | null {
  if (!pluginUiRecord(value) || !pluginUiText(value.point, 160) ||
      !pluginUiText(value.sessionId) ||
      !pluginUiRecord(value.capabilities) || value.capabilities.version !== 1) return null;
  const caps = value.capabilities;
  if (value.subscriptionId !== undefined && !pluginUiText(value.subscriptionId)) return null;
  for (const key of ['points', 'primitives', 'effects', 'pages']) {
    if (!Array.isArray(caps[key]) || caps[key].length > 64 || !caps[key].every(v => pluginUiText(v, 160))) return null;
  }
  const capabilities: PluginUiCapabilities = { version: 1, points: caps.points as string[],
    primitives: caps.primitives as string[], effects: caps.effects as string[], pages: caps.pages as string[],
    ...(caps.tabViews === true ? { tabViews: true } : {}) };
  let target: PluginUiReadRequest['target'];
  if (value.target !== undefined) {
    if (!pluginUiRecord(value.target) || !pluginUiText(value.target.kind, 160) || !pluginUiText(value.target.id)) return null;
    target = { kind: value.target.kind, id: value.target.id };
  }
  return { sessionId: value.sessionId, point: value.point, capabilities, ...(target ? { target } : {}),
    ...(value.subscriptionId ? { subscriptionId: value.subscriptionId as string } : {}) };
}
