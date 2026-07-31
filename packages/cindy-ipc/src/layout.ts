export const LAYOUT_CHANNELS = {
  CHANGED: "layout:changed",
  GET: "layout:get",
  RESET: "layout:reset",
  SET: "layout:set",
} as const;

export type LAYOUTChannel = typeof LAYOUT_CHANNELS[keyof typeof LAYOUT_CHANNELS];
