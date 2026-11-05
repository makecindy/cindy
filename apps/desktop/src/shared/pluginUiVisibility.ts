import type { PluginUiVisibilityElement, PluginUiVisibilityValues } from '@cindy/maker-shared/plugin-ui';

export const PLUGIN_UI_VISIBILITY_ELEMENTS: readonly PluginUiVisibilityElement[] = [
  'workspace', 'sidebar', 'header', 'messages', 'composer', 'tools', 'windowControls',
];
export const PLUGIN_UI_VISIBILITY_GET = 'ghosts:ui-visibility:get';
export const PLUGIN_UI_VISIBILITY_RELEASE = 'ghosts:ui-visibility:release';
export const PLUGIN_UI_VISIBILITY_APPLY = 'ghosts:ui-visibility:apply';
export const PLUGIN_UI_VISIBILITY_APPLIED = 'ghosts:ui-visibility:applied';
export interface PluginUiVisibilityApplication { requestId: string; values: PluginUiVisibilityValues }
