export const SYSTEM_CHANNELS = {
  TRANSIENT_NETWORK_ERROR: "system:transient-network-error",
} as const;

export type SYSTEMChannel = typeof SYSTEM_CHANNELS[keyof typeof SYSTEM_CHANNELS];
