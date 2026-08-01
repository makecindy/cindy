export const AUTH_CHANNELS = {
  ACCOUNT_DELETION_CLEAR_RECEIPT: "auth:account-deletion:clear-receipt",
  ACCOUNT_DELETION_CONFIRM: "auth:account-deletion:confirm",
  ACCOUNT_DELETION_CONSUME_RESTORED_NOTICE: "auth:account-deletion:consume-restored-notice",
  ACCOUNT_DELETION_GET_AVAILABILITY: "auth:account-deletion:get-availability",
  ACCOUNT_DELETION_GET_STATUS: "auth:account-deletion:get-status",
  ACCOUNT_DELETION_REQUEST_CHALLENGE: "auth:account-deletion:request-challenge",
  DISPATCH_LOGIN_ACTION: "auth:dispatch-login-action",
  ENTER_LOCAL: "auth:enter-local",
  EXIT_LOCAL: "auth:exit-local",
  GET_LOGIN_STATE: "auth:get-login-state",
  HAS_PERSISTED_SESSION_HINT_SYNC: "auth:has-persisted-session-hint-sync",
  INITIALIZE: "auth:initialize",
  LOGOUT: "auth:logout",
  REFRESH: "auth:refresh",
  SESSION_EXPIRED: "auth:session-expired",
  STATE_CHANGE: "auth:state-change",
} as const;

export type AUTHChannel = typeof AUTH_CHANNELS[keyof typeof AUTH_CHANNELS];
