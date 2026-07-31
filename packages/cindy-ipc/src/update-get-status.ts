export const UPDATE_GET_STATUS_CHANNELS = {
  UPDATE_GET_STATUS: "update-get-status",
} as const;

export type UPDATE_GET_STATUSChannel = typeof UPDATE_GET_STATUS_CHANNELS[keyof typeof UPDATE_GET_STATUS_CHANNELS];
