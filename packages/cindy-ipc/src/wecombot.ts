export const WECOM_BOT_CHANNELS = {
  DISCONNECT: 'wecomBot:disconnect',
  GET_STATUS: 'wecomBot:get-status',
  RECONNECT: 'wecomBot:reconnect',
  SET_CONFIG: 'wecomBot:set-config',
  STATUS_CHANGE: 'wecomBot:status-changed',
} as const;

export type WECOM_BOTChannel = typeof WECOM_BOT_CHANNELS[keyof typeof WECOM_BOT_CHANNELS];
