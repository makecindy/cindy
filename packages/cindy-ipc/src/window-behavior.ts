export const WINDOW_BEHAVIOR_CHANNELS = {
  GET_WINDOWS_CLOSE_BEHAVIOR: "window-behavior:get-windows-close-behavior",
  SET_SWALLOW_ACTIVATION_CLICK: "window-behavior:set-swallow-activation-click",
  SET_WINDOWS_CLOSE_BEHAVIOR: "window-behavior:set-windows-close-behavior",
  WINDOWS_CLOSE_BEHAVIOR_REQUESTED: "window-behavior:windows-close-behavior-requested",
  WINDOWS_CLOSE_BEHAVIOR_SHOWN: "window-behavior:windows-close-behavior-shown",
} as const;

export type WINDOW_BEHAVIORChannel = typeof WINDOW_BEHAVIOR_CHANNELS[keyof typeof WINDOW_BEHAVIOR_CHANNELS];
