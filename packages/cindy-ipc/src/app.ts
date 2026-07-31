export const APP_CHANNELS = {
  OPEN_LOGS_DIR: "app:open-logs-dir",
  READY_FOR_BOT: "app:ready-for-bot",
} as const;

export type APPChannel = typeof APP_CHANNELS[keyof typeof APP_CHANNELS];
