export const SAFE_STORAGE_READ_CHANNELS = {
  SAFE_STORAGE_READ: "safe-storage-read",
} as const;

export type SAFE_STORAGE_READChannel = typeof SAFE_STORAGE_READ_CHANNELS[keyof typeof SAFE_STORAGE_READ_CHANNELS];
