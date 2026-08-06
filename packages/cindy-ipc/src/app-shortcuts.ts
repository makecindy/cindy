export const APP_SHORTCUTS_CHANNELS = {
  CHANGED: "app-shortcuts:changed",
  CLEAR_OVERRIDE: "app-shortcuts:clear-override",
  GET: "app-shortcuts:get",
  RESET_ALL: "app-shortcuts:reset-all",
  SET_OVERRIDE: "app-shortcuts:set-override",
  SET_RECORDING: "app-shortcuts:set-recording",
} as const;

export type APP_SHORTCUTSChannel = typeof APP_SHORTCUTS_CHANNELS[keyof typeof APP_SHORTCUTS_CHANNELS];
