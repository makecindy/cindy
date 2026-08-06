export const APP_LOCALE_CHANNELS = {
  GET_PREFERRED_SYSTEM_LOCALE_SYNC: "app-locale:get-preferred-system-locale-sync",
} as const;

export type APP_LOCALEChannel = typeof APP_LOCALE_CHANNELS[keyof typeof APP_LOCALE_CHANNELS];
