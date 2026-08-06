export const BUILTIN_API_KEY_REMOVE_CHANNELS = {
  BUILTIN_API_KEY_REMOVE: "builtin-api-key-remove",
} as const;

export type BUILTIN_API_KEY_REMOVEChannel = typeof BUILTIN_API_KEY_REMOVE_CHANNELS[keyof typeof BUILTIN_API_KEY_REMOVE_CHANNELS];
