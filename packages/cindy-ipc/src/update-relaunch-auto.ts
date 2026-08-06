export const UPDATE_RELAUNCH_AUTO_CHANNELS = {
  UPDATE_RELAUNCH_AUTO: "update-relaunch-auto",
} as const;

export type UPDATE_RELAUNCH_AUTOChannel = typeof UPDATE_RELAUNCH_AUTO_CHANNELS[keyof typeof UPDATE_RELAUNCH_AUTO_CHANNELS];
