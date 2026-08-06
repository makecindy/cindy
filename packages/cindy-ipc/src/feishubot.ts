export const FEISHU_BOT_CHANNELS = {
  CLEAR: "feishuBot:clear",
  CONFLICT: "feishuBot:conflict",
  GET_STATE: "feishuBot:get-state",
  RECONNECT: "feishuBot:reconnect",
  REGISTRATION_BEGIN: "feishuBot:registration-begin",
  REGISTRATION_CANCEL: "feishuBot:registration-cancel",
  REGISTRATION_STATUS: "feishuBot:registration-status",
  SAVE: "feishuBot:save",
  SET_LIFECYCLE_ANNOUNCEMENT: "feishuBot:set-lifecycle-announcement",
  STATUS_CHANGE: "feishuBot:status-change",
} as const;

export type FEISHU_BOTChannel = typeof FEISHU_BOT_CHANNELS[keyof typeof FEISHU_BOT_CHANNELS];
