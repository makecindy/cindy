import { usePluginPreviewActive } from './pluginPreviewTabs';
import { usePreviewCastingActive } from './previewCasting';

/**
 * The right sidebar (and so every webview guest in it) must stay mounted while a
 * tab is being cast or a plugin-preview tab is alive — even on a non-chat route or
 * under the Settings takeover. Neither present = the layout behaves as before.
 */
export function usePreviewKeepAliveActive(): boolean {
  const casting = usePreviewCastingActive();
  const pluginPreview = usePluginPreviewActive();
  return casting || pluginPreview;
}
