export const GET_OS_RELEASE_CHANNELS = {
  GET_OS_RELEASE: "get-os-release",
} as const;

export type GET_OS_RELEASEChannel = typeof GET_OS_RELEASE_CHANNELS[keyof typeof GET_OS_RELEASE_CHANNELS];
