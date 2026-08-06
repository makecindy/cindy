export const APPEARANCE_SETTINGS_CHANNELS = {
  CHANGED: "appearance-settings:changed",
  GET: "appearance-settings:get",
  GET_SYNC: "appearance-settings:get-sync",
  RESET: "appearance-settings:reset",
  SET_PATCH: "appearance-settings:set-patch",
} as const;

export type APPEARANCE_SETTINGSChannel = typeof APPEARANCE_SETTINGS_CHANNELS[keyof typeof APPEARANCE_SETTINGS_CHANNELS];
