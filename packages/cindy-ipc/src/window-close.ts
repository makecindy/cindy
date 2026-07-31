export const WINDOW_CLOSE_CHANNELS = {
  WINDOW_CLOSE: "window-close",
} as const;

export type WINDOW_CLOSEChannel = typeof WINDOW_CLOSE_CHANNELS[keyof typeof WINDOW_CLOSE_CHANNELS];
