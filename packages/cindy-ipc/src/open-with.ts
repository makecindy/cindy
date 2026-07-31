export const OPEN_WITH_CHANNELS = {
  LIST: "open-with:list",
  OPEN: "open-with:open",
} as const;

export type OPEN_WITHChannel = typeof OPEN_WITH_CHANNELS[keyof typeof OPEN_WITH_CHANNELS];
