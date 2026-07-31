export const GET_DEVICE_ID_CHANNELS = {
  GET_DEVICE_ID: "get-device-id",
} as const;

export type GET_DEVICE_IDChannel = typeof GET_DEVICE_ID_CHANNELS[keyof typeof GET_DEVICE_ID_CHANNELS];
