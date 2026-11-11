import { useSyncExternalStore } from 'react';
import { DEFAULT_PLUGIN_UI_REGIONS, PLUGIN_UI_REGIONS, type PluginUiRegions } from '../../shared/pluginUi';
import { setPanelKindParked } from '@/panels/registry';

let current = DEFAULT_PLUGIN_UI_REGIONS;
const listeners = new Set<() => void>();
export const subscribePluginUiRegions = (changed: () => void) => { listeners.add(changed); return () => { listeners.delete(changed); }; };
export const getPluginUiRegions = () => current;
export const usePluginUiRegions = () => useSyncExternalStore(subscribePluginUiRegions, getPluginUiRegions, getPluginUiRegions);

/** Renderer projection of Main's window presentation; does not persist layout or preferences. */
export function applyPluginUiRegions(values: PluginUiRegions): void {
  if (PLUGIN_UI_REGIONS.every(key => values[key] === current[key])) return;
  current = values;
  setPanelKindParked('right-tabs', !values.workspace || !values.tools);
  const hidden = PLUGIN_UI_REGIONS.filter(key => !values[key]);
  if (hidden.length) document.documentElement.dataset.pluginUiHidden = hidden.join(' ');
  else delete document.documentElement.dataset.pluginUiHidden;
  for (const changed of listeners) changed();
}

export function isPluginUiElementVisible(element: Element): boolean {
  if (!current.workspace && !element.closest('[data-plugin-ui-keep-visible]')) return false;
  for (const region of PLUGIN_UI_REGIONS) {
    if (region === 'workspace' || current[region]) continue;
    const selector = region === 'composer' ? '[data-chat-input-root]' : `[data-plugin-ui-element="${region}"]`;
    if (element.closest(selector)) return false;
  }
  return true;
}
