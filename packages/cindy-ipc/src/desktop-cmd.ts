export const DESKTOP_CMD_CHANNELS = {
  RUN: "desktop-cmd:run",
} as const;

export type DESKTOP_CMDChannel = typeof DESKTOP_CMD_CHANNELS[keyof typeof DESKTOP_CMD_CHANNELS];
