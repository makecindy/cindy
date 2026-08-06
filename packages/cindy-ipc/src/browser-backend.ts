export const BROWSER_BACKEND_CHANNELS = {
  GET_HEALTH: "browser-backend:get-health",
  GET_STATE: "browser-backend:get-state",
  RECOVER: "browser-backend:recover",
  RESET: "browser-backend:reset",
  SET_KIND: "browser-backend:set-kind",
} as const;

export type BROWSER_BACKENDChannel = typeof BROWSER_BACKEND_CHANNELS[keyof typeof BROWSER_BACKEND_CHANNELS];
