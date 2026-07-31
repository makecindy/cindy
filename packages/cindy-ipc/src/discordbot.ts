export const DISCORD_BOT_CHANNELS = {
  CHECK_SESSION_AUTH: "discordBot:check-session-auth",
  DISCONNECT: "discordBot:disconnect",
  GET_STATUS: "discordBot:get-status",
  SET_CONFIG: "discordBot:set-config",
  SET_LIFECYCLE_ANNOUNCEMENT: "discordBot:set-lifecycle-announcement",
} as const;

export type DISCORD_BOTChannel = typeof DISCORD_BOT_CHANNELS[keyof typeof DISCORD_BOT_CHANNELS];
