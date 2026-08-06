export const RSB_NATIVE_POPUP_CHANNELS = {
  CLAIM: "rsb-native-popup:claim",
  CLOSE: "rsb-native-popup:close",
  COMMAND: "rsb-native-popup:command",
  EVENT: "rsb-native-popup:event",
  SET_BOUNDS: "rsb-native-popup:set-bounds",
} as const;

export type RSB_NATIVE_POPUPChannel = typeof RSB_NATIVE_POPUP_CHANNELS[keyof typeof RSB_NATIVE_POPUP_CHANNELS];
