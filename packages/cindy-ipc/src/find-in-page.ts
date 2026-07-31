export const FIND_IN_PAGE_CHANNELS = {
  RESULT: "find-in-page:result",
  START: "find-in-page:start",
  STOP: "find-in-page:stop",
} as const;

export type FIND_IN_PAGEChannel = typeof FIND_IN_PAGE_CHANNELS[keyof typeof FIND_IN_PAGE_CHANNELS];
