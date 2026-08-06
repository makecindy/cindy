export const FILE_CHANNELS = {
  THUMBNAIL: "file:thumbnail",
} as const;

export type FILEChannel = typeof FILE_CHANNELS[keyof typeof FILE_CHANNELS];
