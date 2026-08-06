export const PROFILE_CHANNELS = {
  CHOOSE_AVATAR: "profile:choose-avatar",
  GET_STATE: "profile:get-state",
  UPDATE: "profile:update",
} as const;

export type PROFILEChannel = typeof PROFILE_CHANNELS[keyof typeof PROFILE_CHANNELS];
