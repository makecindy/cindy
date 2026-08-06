export const LOG_UPLOAD_CHANNELS = {
  RESET_CRASH_AUTO: "log-upload:reset-crash-auto",
  SET_CRASH_AUTO: "log-upload:set-crash-auto",
  SETTINGS_CHANGE: "log-upload:settings-change",
  SETTINGS_GET: "log-upload:settings-get",
  UPLOAD_NOW: "log-upload:upload-now",
} as const;

export type LOG_UPLOADChannel = typeof LOG_UPLOAD_CHANNELS[keyof typeof LOG_UPLOAD_CHANNELS];
