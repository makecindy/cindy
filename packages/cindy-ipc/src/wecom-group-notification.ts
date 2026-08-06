export const WECOM_GROUP_NOTIFICATION_CHANNELS = {
  CLEAR: 'wecomGroupNotification:clear',
  GET_STATE: 'wecomGroupNotification:get-state',
  SAVE_AND_TEST: 'wecomGroupNotification:save-and-test',
  SET_ENABLED: 'wecomGroupNotification:set-enabled',
  TEST: 'wecomGroupNotification:test',
} as const;

export type WECOM_GROUP_NOTIFICATIONChannel =
  typeof WECOM_GROUP_NOTIFICATION_CHANNELS[keyof typeof WECOM_GROUP_NOTIFICATION_CHANNELS];
