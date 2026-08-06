export const SAFE_STORAGE_REMOVE_CHANNELS = {
  SAFE_STORAGE_REMOVE: "safe-storage-remove",
} as const;

export type SAFE_STORAGE_REMOVEChannel = typeof SAFE_STORAGE_REMOVE_CHANNELS[keyof typeof SAFE_STORAGE_REMOVE_CHANNELS];
