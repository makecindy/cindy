export const WECHAT_BOT_CHANNELS = {
  AUTHORIZE: "wechatBot:authorize",
  CANCEL_AUTHORIZATION: "wechatBot:cancel-authorization",
  CHOOSE_WORKING_DIRECTORY: "wechatBot:choose-working-directory",
  GET_CHANNEL_SETTINGS: "wechatBot:get-channel-settings",
  GET_STATE: "wechatBot:get-state",
  RESET_WORKING_DIRECTORY: "wechatBot:reset-working-directory",
  UNBIND: "wechatBot:unbind",
} as const;

export type WECHAT_BOTChannel = typeof WECHAT_BOT_CHANNELS[keyof typeof WECHAT_BOT_CHANNELS];
