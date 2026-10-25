export type AgentIslandDisplaySelectionMode =
  | 'native-preferred-then-xdmaker-window'
  | 'xdmaker-window-then-native-preferred';

export type AgentIslandRenderMode = 'target-display' | 'all-displays';

/**
 * Internal Agent Island display policy knobs. These intentionally are not exposed
 * in Settings yet, but keeping them centralized makes the macOS placement rules
 * easy to tune after testing on real multi-display setups.
 */
export const AGENT_ISLAND_DISPLAY_CONFIG: {
  renderMode: AgentIslandRenderMode;
  selectionMode: AgentIslandDisplaySelectionMode;
  preferHardwareNotchFallback: boolean;
  preferInternalDisplayFallback: boolean;
  notifyOrcaWorkerSessions: boolean;
} = {
  renderMode: 'all-displays',
  selectionMode: 'native-preferred-then-xdmaker-window',
  preferHardwareNotchFallback: true,
  preferInternalDisplayFallback: true,
  notifyOrcaWorkerSessions: false,
};
