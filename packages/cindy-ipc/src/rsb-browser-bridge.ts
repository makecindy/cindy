export const RSB_BROWSER_BRIDGE_CHANNELS = {
  CAPTURE_SCREENSHOT: "rsb-browser-bridge:capture-screenshot",
  CAPTURE_SCREENSHOT_DATA: "rsb-browser-bridge:capture-screenshot-data",
  FORCE_KILL: "rsb-browser-bridge:force-kill",
  RELEASE: "rsb-browser-bridge:release",
  REPORT: "rsb-browser-bridge:report",
  SET_ACTIVE_SESSION: "rsb-browser-bridge:set-active-session",
  SET_FOREGROUND: "rsb-browser-bridge:set-foreground",
  SNAPSHOT: "rsb-browser-bridge:snapshot",
  TAB_OP_RESULT: "rsb-browser-bridge:tab-op-result",
} as const;

export type RSB_BROWSER_BRIDGEChannel = typeof RSB_BROWSER_BRIDGE_CHANNELS[keyof typeof RSB_BROWSER_BRIDGE_CHANNELS];
