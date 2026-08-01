export const BROWSER_CHANNELS = {
  RSB_COMMAND: "rsb:browser-command",
  RSB_FOCUS_URL_BAR: "rsb:browser-focus-url-bar",
  RSB_POPUP: "rsb:browser-popup",
} as const;

export type BROWSERChannel = typeof BROWSER_CHANNELS[keyof typeof BROWSER_CHANNELS];
