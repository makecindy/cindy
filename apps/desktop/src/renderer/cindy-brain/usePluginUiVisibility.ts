import { useEffect, useSyncExternalStore } from 'react';
import type { PluginUiVisibilityValues } from '@cindy/maker-shared/plugin-ui';
import { PLUGIN_UI_VISIBILITY_ELEMENTS } from '../../shared/pluginUiVisibility';

const defaults: PluginUiVisibilityValues = { workspace: true, sidebar: true, header: true, messages: true, composer: true, tools: true, windowControls: true };
let current = defaults;
const listeners = new Set<() => void>();
function update(values: PluginUiVisibilityValues) {
  // Workspace is the parent switch; the Main-owned choices remain unchanged.
  current = values.workspace ? values : { workspace: false, sidebar: false, header: false,
    messages: false, composer: false, tools: false, windowControls: false };
  document.documentElement.dataset.pluginUiHidden = PLUGIN_UI_VISIBILITY_ELEMENTS.filter(key => !current[key]).join(' ');
  listeners.forEach(listener => listener());
}
export function usePluginUiVisibilityValues(): PluginUiVisibilityValues {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => current, () => defaults);
}
/** One owner per Desktop window; Main remains the source of transient values. */
export function usePluginUiVisibilityOwner(): PluginUiVisibilityValues {
  const values = usePluginUiVisibilityValues();
  useEffect(() => {
    const bridge = window.electronAPI?.pluginUiVisibility;
    if (!bridge) return;
    let live = true, generation = 0;
    const stop = bridge.onApply(request => {
      const revision = ++generation;
      update(request.values);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (live && revision === generation) void bridge.applied(request.requestId).catch(() => {});
      }));
    });
    const initial = generation;
    void bridge.get().then(snapshot => { if (live && generation === initial) update(snapshot); }).catch(() => {});
    return () => { live = false; generation++; stop(); void bridge.release().catch(() => {}); update(defaults); delete document.documentElement.dataset.pluginUiHidden; };
  }, []);
  return values;
}
