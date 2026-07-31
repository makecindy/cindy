export const DINGTALK_BOT_CHANNELS = {
  CLEAR: "dingtalkBot:clear",
  GET_STATE: "dingtalkBot:get-state",
  RECONNECT: "dingtalkBot:reconnect",
  SAVE: "dingtalkBot:save",
} as const;

export type DINGTALK_BOTChannel = typeof DINGTALK_BOT_CHANNELS[keyof typeof DINGTALK_BOT_CHANNELS];
