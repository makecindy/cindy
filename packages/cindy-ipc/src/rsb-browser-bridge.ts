export const RSB_BROWSER_BRIDGE_CHANNELS = {
  CAPTURE_SCREENSHOT: "rsb-browser-bridge:capture-screenshot",
  CAPTURE_SCREENSHOT_DATA: "rsb-browser-bridge:capture-screenshot-data",
  FORCE_KILL: "rsb-browser-bridge:force-kill",
  PIN: "rsb-browser-bridge:pin",
  RELEASE: "rsb-browser-bridge:release",
  REPORT: "rsb-browser-bridge:report",
  RESOURCE_EVENT: "rsb-browser-bridge:resource-event",
  SET_ACTIVE_SESSION: "rsb-browser-bridge:set-active-session",
  SET_FOREGROUND: "rsb-browser-bridge:set-foreground",
  SNAPSHOT: "rsb-browser-bridge:snapshot",
  TAB_OP_REQUEST: "rsb-browser-bridge:tab-op-request",
  TAB_OP_RESULT: "rsb-browser-bridge:tab-op-result",
  UNPIN: "rsb-browser-bridge:unpin",
} as const;

export type RSB_BROWSER_BRIDGEChannel = typeof RSB_BROWSER_BRIDGE_CHANNELS[keyof typeof RSB_BROWSER_BRIDGE_CHANNELS];
