export const CLIENT_ENDPOINTS_CHANNELS = {
  GET_SYNC: "client-endpoints:get-sync",
} as const;

export type CLIENT_ENDPOINTSChannel = typeof CLIENT_ENDPOINTS_CHANNELS[keyof typeof CLIENT_ENDPOINTS_CHANNELS];
