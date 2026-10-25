import type { PluginTaskPreferences } from "@cindy/device-link";
import type { GhostManifest } from "./ghost";

/** Non-secret Host controls; the plugin's own fields remain in its settings page. */
export interface RemotePluginPreferenceSnapshot {
  revision: string;
  tasks?: PluginTaskPreferences;
  auxiliaryModelLabel?: string | null;
  sidebarVisible?: boolean;
}

export function pluginHasModelPreferences(manifest: GhostManifest): boolean {
  return Boolean(
    manifest.workspace ||
    manifest.agent?.tasks ||
    manifest.agent?.errand ||
    manifest.cindy?.text?.includes("oneshot"),
  );
}
