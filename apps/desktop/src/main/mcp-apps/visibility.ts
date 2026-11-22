import type { BrowserWindow } from 'electron';
import { PLUGIN_UI_REGIONS, DEFAULT_PLUGIN_UI_REGIONS, type PluginUiRegion } from '../../shared/pluginUi.js';
import { getSafeDataOwnerPushStamp } from '../device-link/broadcast-tap.js';

type Lease = { instance: string; token: string };
type WindowState = { window: BrowserWindow; hidden: Map<PluginUiRegion, Lease>; dispose(): void };
const windows = new Map<number, WindowState>();

/** Transient window presentation; no timer, initial query or message-path subscription. */
export function readPluginUiRegions(window: BrowserWindow) {
  const hidden = windows.get(window.webContents.id)?.hidden;
  return Object.fromEntries(PLUGIN_UI_REGIONS.map(region => [region, !hidden?.has(region)])) as typeof DEFAULT_PLUGIN_UI_REGIONS;
}

export function setPluginUiRegions(window: BrowserWindow, instance: string, token: string, raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length ||
      Object.entries(raw).some(([key, value]) => !PLUGIN_UI_REGIONS.includes(key as PluginUiRegion) || typeof value !== 'boolean'))
    throw new Error('MCP_APP_INVALID_REQUEST');
  const id = window.webContents.id;
  let state = windows.get(id);
  if (!state) {
    const destroyed = () => windows.delete(id);
    state = { window, hidden: new Map(), dispose: () => window.webContents.removeListener('destroyed', destroyed) };
    window.webContents.once('destroyed', destroyed);
    windows.set(id, state);
  }
  for (const [key, value] of Object.entries(raw)) {
    if (value) state.hidden.delete(key as PluginUiRegion);
    else state.hidden.set(key as PluginUiRegion, { instance, token });
  }
  const values = readPluginUiRegions(window);
  if (!state.hidden.size) { state.dispose(); windows.delete(id); }
  if (process.platform === 'darwin') window.setWindowButtonVisibility?.(values.workspace && values.windowControls);
  return values;
}

/** Called only by existing install/owner/runtime lifecycle changes, never by chat messages. */
export function reconcilePluginUiRegions(valid: (instance: string, token: string) => boolean): void {
  for (const [id, state] of windows) {
    let changed = false;
    for (const [region, lease] of state.hidden) if (!valid(lease.instance, lease.token)) {
      state.hidden.delete(region); changed = true;
    }
    if (!changed) continue;
    const values = readPluginUiRegions(state.window);
    if (!state.hidden.size) { state.dispose(); windows.delete(id); }
    if (!state.window.isDestroyed() && !state.window.webContents.isDestroyed()) {
      if (process.platform === 'darwin') state.window.setWindowButtonVisibility?.(values.workspace && values.windowControls);
      state.window.webContents.send('plugin-ui:action', { kind: 'regions-sync', values, ownerStamp: getSafeDataOwnerPushStamp() });
    }
  }
}

export function releasePluginUiRegions(instance: string): void {
  reconcilePluginUiRegions(current => current !== instance);
}
