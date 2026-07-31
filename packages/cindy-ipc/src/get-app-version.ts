export const GET_APP_VERSION_CHANNELS = {
  GET_APP_VERSION: "get-app-version",
} as const;

export type GET_APP_VERSIONChannel = typeof GET_APP_VERSION_CHANNELS[keyof typeof GET_APP_VERSION_CHANNELS];
