export const GET_FULLSCREEN_STATE_CHANNELS = {
  GET_FULLSCREEN_STATE: "get-fullscreen-state",
} as const;

export type GET_FULLSCREEN_STATEChannel = typeof GET_FULLSCREEN_STATE_CHANNELS[keyof typeof GET_FULLSCREEN_STATE_CHANNELS];
