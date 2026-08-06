export const BUILTIN_API_KEY_HAS_CHANNELS = {
  BUILTIN_API_KEY_HAS: "builtin-api-key-has",
} as const;

export type BUILTIN_API_KEY_HASChannel = typeof BUILTIN_API_KEY_HAS_CHANNELS[keyof typeof BUILTIN_API_KEY_HAS_CHANNELS];
