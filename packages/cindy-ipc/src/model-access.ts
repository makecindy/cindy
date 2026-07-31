export const MODEL_ACCESS_CHANNELS = {
  GET_STATUS: "model-access:get-status",
  RETRY: "model-access:retry",
  ROTATE: "model-access:rotate",
} as const;

export type MODEL_ACCESSChannel = typeof MODEL_ACCESS_CHANNELS[keyof typeof MODEL_ACCESS_CHANNELS];
