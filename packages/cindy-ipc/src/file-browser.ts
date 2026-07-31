export const FILE_BROWSER_CHANNELS = {
  REMOTE_OP: "file-browser:remote-op",
} as const;

export type FILE_BROWSERChannel = typeof FILE_BROWSER_CHANNELS[keyof typeof FILE_BROWSER_CHANNELS];
