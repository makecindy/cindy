export const GHOST_PANEL_WINDOW_CHANNELS = {
  GET_STATE_SYNC: "ghost-panel-window:get-state-sync",
} as const;

export type GHOST_PANEL_WINDOWChannel = typeof GHOST_PANEL_WINDOW_CHANNELS[keyof typeof GHOST_PANEL_WINDOW_CHANNELS];
