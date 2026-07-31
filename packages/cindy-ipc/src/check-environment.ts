export const CHECK_ENVIRONMENT_CHANNELS = {
  CHECK_ENVIRONMENT: "check-environment",
} as const;

export type CHECK_ENVIRONMENTChannel = typeof CHECK_ENVIRONMENT_CHANNELS[keyof typeof CHECK_ENVIRONMENT_CHANNELS];
