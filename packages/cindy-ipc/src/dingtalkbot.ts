export const DINGTALK_BOT_CHANNELS = {
  CLEAR: "dingtalkBot:clear",
  GET_STATE: "dingtalkBot:get-state",
  OWNER_CHANGE: "dingtalkBot:owner-change",
  RECONNECT: "dingtalkBot:reconnect",
  SAVE: "dingtalkBot:save",
  STATUS_CHANGE: "dingtalkBot:status-change",
} as const;

export type DINGTALK_BOTChannel = typeof DINGTALK_BOT_CHANNELS[keyof typeof DINGTALK_BOT_CHANNELS];
