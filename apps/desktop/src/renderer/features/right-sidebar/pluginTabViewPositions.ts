import type { PluginUiValues } from '@cindy/maker-shared/plugin-ui';

/** Current tab-owner memory only; never serialized with native tab state. */
export const pluginTabViewPositions = new Map<string, { params: PluginUiValues; sequence: number; generation?: string }>();

/** Called only after the original tab store confirms a close. */
export function clearPluginTabViewPosition(tabId: string): void {
  const position = pluginTabViewPositions.get(tabId);
  pluginTabViewPositions.delete(tabId);
  if (position?.generation) void window.electronAPI?.ghosts?.ui?.tabViews?.release(position.generation, false).catch(() => {});
}
