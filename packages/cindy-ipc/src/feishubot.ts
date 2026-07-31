export const FEISHU_BOT_CHANNELS = {
  CLEAR: "feishuBot:clear",
  GET_STATE: "feishuBot:get-state",
  RECONNECT: "feishuBot:reconnect",
  REGISTRATION_BEGIN: "feishuBot:registration-begin",
  REGISTRATION_CANCEL: "feishuBot:registration-cancel",
  SAVE: "feishuBot:save",
  SET_LIFECYCLE_ANNOUNCEMENT: "feishuBot:set-lifecycle-announcement",
} as const;

export type FEISHU_BOTChannel = typeof FEISHU_BOT_CHANNELS[keyof typeof FEISHU_BOT_CHANNELS];
