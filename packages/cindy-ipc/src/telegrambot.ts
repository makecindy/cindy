export const TELEGRAM_BOT_CHANNELS = {
  CHECK_SESSION_AUTH: "telegramBot:check-session-auth",
  DISCONNECT: "telegramBot:disconnect",
  GET_BEHAVIOR: "telegramBot:get-behavior",
  GET_PERSONA: "telegramBot:get-persona",
  GET_STATUS: "telegramBot:get-status",
  LIST_GROUPS: "telegramBot:list-groups",
  SET_BEHAVIOR: "telegramBot:set-behavior",
  SET_CONFIG: "telegramBot:set-config",
  SET_GROUP_ACTIVATION: "telegramBot:set-group-activation",
  SET_ONLINE: "telegramBot:set-online",
  SET_PERSONA: "telegramBot:set-persona",
} as const;

export type TELEGRAM_BOTChannel = typeof TELEGRAM_BOT_CHANNELS[keyof typeof TELEGRAM_BOT_CHANNELS];
