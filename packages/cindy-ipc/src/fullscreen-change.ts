export const FULLSCREEN_CHANGE_CHANNELS = {
  FULLSCREEN_CHANGE: "fullscreen-change",
} as const;

export type FULLSCREEN_CHANGEChannel = typeof FULLSCREEN_CHANGE_CHANNELS[keyof typeof FULLSCREEN_CHANGE_CHANNELS];
