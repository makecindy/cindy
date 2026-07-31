export const WINDOW_MINIMIZE_CHANNELS = {
  WINDOW_MINIMIZE: "window-minimize",
} as const;

export type WINDOW_MINIMIZEChannel = typeof WINDOW_MINIMIZE_CHANNELS[keyof typeof WINDOW_MINIMIZE_CHANNELS];
