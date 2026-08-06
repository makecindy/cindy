export const WINDOW_CLOSE_SELF_CHANNELS = {
  WINDOW_CLOSE_SELF: "window-close-self",
} as const;

export type WINDOW_CLOSE_SELFChannel = typeof WINDOW_CLOSE_SELF_CHANNELS[keyof typeof WINDOW_CLOSE_SELF_CHANNELS];
