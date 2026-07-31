export const DESKTOP_CHANNELS = {
  CC_PREFS_CHANGED: "desktop:cc-prefs-changed",
} as const;

export type DESKTOPChannel = typeof DESKTOP_CHANNELS[keyof typeof DESKTOP_CHANNELS];
