export const THEME_CHANNELS = {
  APPLY_VIBRANCY: "theme:apply-vibrancy",
} as const;

export type THEMEChannel = typeof THEME_CHANNELS[keyof typeof THEME_CHANNELS];
