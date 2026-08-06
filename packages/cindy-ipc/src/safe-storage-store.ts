export const SAFE_STORAGE_STORE_CHANNELS = {
  SAFE_STORAGE_STORE: "safe-storage-store",
} as const;

export type SAFE_STORAGE_STOREChannel = typeof SAFE_STORAGE_STORE_CHANNELS[keyof typeof SAFE_STORAGE_STORE_CHANNELS];
