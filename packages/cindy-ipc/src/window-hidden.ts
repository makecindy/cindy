export const WINDOW_HIDDEN_CHANNELS = {
  CHANGE: "window-hidden-change",
} as const;

export type WINDOW_HIDDENChannel = typeof WINDOW_HIDDEN_CHANNELS[keyof typeof WINDOW_HIDDEN_CHANNELS];
