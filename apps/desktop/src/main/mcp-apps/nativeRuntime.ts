import { webContents } from 'electron';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { sendToGhostLogic } from '../cindy-brain/runtime/electronSandboxAdapter.js';
import { readPluginHostUi } from '../mcp-integrations/plugin-app-registry.js';
import { NativePluginUiState } from './nativeState.js';
import { PLUGIN_UI_INTEREST_LIMIT, PLUGIN_UI_STATE_BATCH_LIMIT, type PluginUiInterest, type PluginUiTarget, type PluginUiControlState } from '../../shared/pluginUi.js';

/** Existing pipe downlink does not start a sleeping plugin. Ping restores current demand. */
export const nativePluginUi = new NativePluginUiState({
  owner: activeOwnerScopeKey,
  authority(interest) {
    const entry = readPluginHostUi(interest.instanceId);
    return entry?.owner === activeOwnerScopeKey() && entry.host.contributions?.some(item => item.id === interest.id && item.position !== 'message.body' && item.position !== 'tool.body') ? entry : undefined;
  },
  demand(instance, consumers) { sendToGhostLogic(instance, { type: 'ui-consumers', consumers }); },
  send(caller, epoch, updates) {
    const match = /^renderer:(\d+)$/.exec(caller);
    const window = match ? webContents.fromId(Number(match[1])) : undefined;
    if (!window || window.isDestroyed()) throw new Error('MCP_APP_VIEW_UNAVAILABLE');
    window.send('plugin-ui:state', { epoch, updates });
  },
});

export function parsePluginUiInterests(raw: unknown): PluginUiInterest[] {
  if (!Array.isArray(raw) || raw.length > PLUGIN_UI_INTEREST_LIMIT) throw new Error('MCP_APP_INVALID_REQUEST');
  return raw.map(value => {
    if (!value || typeof value !== 'object' || typeof value.instanceId !== 'string' || value.instanceId.length > 256 ||
      typeof value.id !== 'string' || value.id.length > 64 ||
      value.sessionId !== undefined && value.sessionId !== null && (typeof value.sessionId !== 'string' || value.sessionId.length > 256) ||
      value.clientId !== undefined && (typeof value.clientId !== 'string' || value.clientId.length > 256)) throw new Error('MCP_APP_INVALID_REQUEST');
    return { instanceId: value.instanceId, id: value.id, sessionId: value.sessionId ?? null,
      ...(value.clientId ? { clientId: value.clientId } : {}) };
  });
}

export function publishPluginUiControl(instance: string, raw: unknown) {
  if (!raw || typeof raw !== 'object' || !('updates' in raw) || !Array.isArray(raw.updates) || raw.updates.length > PLUGIN_UI_STATE_BATCH_LIMIT)
    throw new Error('MCP_APP_INVALID_REQUEST');
  const updates = raw.updates.map(value => {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || value.target !== undefined &&
      (!value.target || typeof value.target !== 'object' || Array.isArray(value.target))) throw new Error('MCP_APP_INVALID_REQUEST');
    const interest = parsePluginUiInterests([{ instanceId: instance, id: value.id,
      sessionId: value.target?.sessionId, clientId: value.target?.clientId }])[0];
    const target: PluginUiTarget | undefined = value.target === undefined ? undefined : {
      sessionId: interest.sessionId, ...(interest.clientId ? { clientId: interest.clientId } : {}),
    };
    return { id: value.id, target, state: value.state as PluginUiControlState };
  });
  return { ok: true, observed: updates.map(input => nativePluginUi.publish(instance, input.id, input.target, () => input.state)) };
}
