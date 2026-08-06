export const UPDATE_STATUS_CHANNELS = {
  UPDATE_STATUS: "update-status",
} as const;

export type UPDATE_STATUSChannel = typeof UPDATE_STATUS_CHANNELS[keyof typeof UPDATE_STATUS_CHANNELS];
