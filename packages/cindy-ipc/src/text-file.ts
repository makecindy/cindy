export const TEXT_FILE_CHANNELS = {
  READ_PREVIEW: "text-file:read-preview",
} as const;

export type TEXT_FILEChannel = typeof TEXT_FILE_CHANNELS[keyof typeof TEXT_FILE_CHANNELS];
