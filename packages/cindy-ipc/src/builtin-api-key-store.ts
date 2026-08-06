export const BUILTIN_API_KEY_STORE_CHANNELS = {
  BUILTIN_API_KEY_STORE: "builtin-api-key-store",
} as const;

export type BUILTIN_API_KEY_STOREChannel = typeof BUILTIN_API_KEY_STORE_CHANNELS[keyof typeof BUILTIN_API_KEY_STORE_CHANNELS];
