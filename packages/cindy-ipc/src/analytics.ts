export const ANALYTICS_CHANNELS = {
  CONSENT_ACCEPT: "analytics:consent-accept",
  SETTINGS_CHANGE: "analytics:settings-change",
  SETTINGS_GET: "analytics:settings-get",
  SETTINGS_RESET_ENABLED: "analytics:settings-reset-enabled",
  SETTINGS_SET_ENABLED: "analytics:settings-set-enabled",
} as const;

export type ANALYTICSChannel = typeof ANALYTICS_CHANNELS[keyof typeof ANALYTICS_CHANNELS];
