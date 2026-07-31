export const NOTIFICATION_CHANNELS = {
  CLEAR_SESSION_ATTENTION: "notification:clear-session-attention",
  FOCUS_SESSION: "notification:focus-session",
  MARK_SESSION_ATTENTION: "notification:mark-session-attention",
  SET_DESKTOP_ENABLED: "notification:set-desktop-enabled",
  SHOW_SESSION_EVENT: "notification:show-session-event",
} as const;

export type NOTIFICATIONChannel = typeof NOTIFICATION_CHANNELS[keyof typeof NOTIFICATION_CHANNELS];
