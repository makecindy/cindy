export const UPDATE_RELAUNCH_CHANNELS = {
  UPDATE_RELAUNCH: "update-relaunch",
  BLOCKING_ACTIVITY: "update-relaunch:blocking-activity",
} as const;

export type UPDATE_RELAUNCHChannel = typeof UPDATE_RELAUNCH_CHANNELS[keyof typeof UPDATE_RELAUNCH_CHANNELS];
