export const WINDOW_MAXIMIZE_CHANNELS = {
  WINDOW_MAXIMIZE: "window-maximize",
} as const;

export type WINDOW_MAXIMIZEChannel = typeof WINDOW_MAXIMIZE_CHANNELS[keyof typeof WINDOW_MAXIMIZE_CHANNELS];
